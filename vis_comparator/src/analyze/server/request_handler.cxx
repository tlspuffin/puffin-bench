#include "request_handler.hxx"
#include "parts_handler.hxx"
#include "../../utils/rapidjson.hxx"
#include <algorithm>
#include <fstream>
#include <unordered_map>
#include <string>
#include <list>
#include <mutex>
#include <Poco/JSON/Object.h>
#include <Poco/JSON/Stringifier.h>
#include <Poco/Net/HTTPServerRequest.h>
#include <Poco/Base64Encoder.h>
#include <Poco/StreamCopier.h>
#include <Poco/URI.h>
#include <Poco/Net/HTTPClientSession.h>
#include <Poco/Net/HTTPSClientSession.h>
#include <Poco/Net/HTTPRequest.h>
#include <Poco/Net/HTTPResponse.h>
#include <rapidjson/writer.h>
#include <rapidjson/stringbuffer.h>

// Simple thread-safe LRU cache of serialized endpoint responses. The cache key
// embeds the run's (mtime,size) fingerprint, so a changed run yields a new key
// (the stale entry is evicted by LRU pressure).
class ResponseCache {
public:
  explicit ResponseCache(size_t maxEntries) : maxEntries_(maxEntries) {}

  bool Get(std::string const& key, std::string& out) {
    std::lock_guard<std::mutex> lk(mutex_);
    auto it = map_.find(key);
    if (it == map_.end()) {
      return false;
    }
    order_.splice(order_.begin(), order_, it->second.second);
    out = it->second.first;
    return true;
  }

  void Put(std::string const& key, std::string value) {
    std::lock_guard<std::mutex> lk(mutex_);
    auto it = map_.find(key);
    if (it != map_.end()) {
      it->second.first = std::move(value);
      order_.splice(order_.begin(), order_, it->second.second);
      return;
    }
    order_.push_front(key);
    map_.emplace(key, std::make_pair(std::move(value), order_.begin()));
    while (map_.size() > maxEntries_) {
      map_.erase(order_.back());
      order_.pop_back();
    }
  }

private:
  size_t maxEntries_;
  std::mutex mutex_;
  std::list<std::string> order_;  // front = most recently used
  std::unordered_map<std::string,
      std::pair<std::string, std::list<std::string>::iterator>> map_;
};

static std::string decodeViewName(const std::string& encoded) {
  std::string decoded;
  Poco::URI::decode(encoded, decoded);
  return decoded;
}

static std::string viewNameToStem(const std::string& name) {
  std::string result;
  result.reserve(name.size());
  for (char c : name) {
    if (c == '/') result += "%2F";
    else          result += c;
  }
  return result;
}

static std::string stemToViewName(const std::string& stem) {
  std::string result;
  result.reserve(stem.size());
  for (size_t i = 0; i < stem.size(); ++i) {
    if (stem[i] == '%' && i + 2 < stem.size() &&
        stem[i+1] == '2' && (stem[i+2] == 'F' || stem[i+2] == 'f')) {
      result += '/';
      i += 2;
    } else {
      result += stem[i];
    }
  }
  return result;
}

static bool isValidViewName(const std::string& name) {
  if (name.empty()) return false;
  if (name.find('\0') != std::string::npos) return false;
  if (name.find("..") != std::string::npos) return false;
  return true;
}

inline static bool ToBool(std::string const& v) {
  return v == "1" || v == "true" || v == "on" || v == "yes";
};

static bool ManageCORS(Poco::Net::HTTPServerRequest& request,
    Poco::Net::HTTPServerResponse& response) {
  response.set("Access-Control-Allow-Origin", "*");
  response.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  response.set("Access-Control-Allow-Headers", "Content-Type");

  if (request.getMethod() == Poco::Net::HTTPRequest::HTTP_OPTIONS) {
    response.setStatus(Poco::Net::HTTPResponse::HTTP_OK);
    response.send();
    return true;
  }
  return false;
}

void ns_Server::RequestHandlerError::handleRequest(Poco::Net::HTTPServerRequest& request,
    Poco::Net::HTTPServerResponse& response) {
  response.setStatus(Poco::Net::HTTPResponse::HTTP_NOT_FOUND);
  response.setContentType("text/plain");
  response.send() << "404 - Path not found: " << request.getURI() << '\n';
}

void ns_Server::RequestHandlerFiles::handleRequest(Poco::Net::HTTPServerRequest& request,
    Poco::Net::HTTPServerResponse& response) {

  response.setChunkedTransferEncoding(true);

  std::string const& prefix = std::get<0>(args_);

  std::ostream* out = nullptr;
  try {
    Poco::URI uri(request.getURI());
    std::string path = uri.getPath();
    path = path.substr(prefix.size());

    if (path.compare("/") == 0) {
      path = "index.html";
    } else if (path[0] == '/') {
      path = path.substr(1);
    }

    std::filesystem::path filename = config_->html_ / path;
    try {
      filename = std::filesystem::canonical(filename);
    } catch(...) {
      //detectHostileIP_.SetHostileIP(srcIP);
      response.setStatusAndReason(Poco::Net::HTTPResponse::HTTP_NOT_FOUND);
      response.send();
      return;
    }

    std::filesystem::path rootPath = config_->html_;
    std::error_code ec;
    std::string relativePath = std::filesystem::relative(filename, rootPath, ec).string();
    if (ec || (relativePath.find("..") == 0)) {
      //detectHostileIP_.SetHostileIP(srcIP);
      response.setStatusAndReason(Poco::Net::HTTPResponse::HTTP_BAD_REQUEST);
      response.send();
      return;
    }

    static std::unordered_map<std::string, std::pair<std::string, std::ios_base::openmode>> 
        mimeType {
            {".txt", {"text/text", std::ios_base::in}},
            {".html", {"text/html", std::ios_base::in}}, 
            {".css", {"text/css", std::ios_base::in}},
            {".json", {"application/json; charset=utf-8", std::ios_base::in}},
            {".js", {"text/javascript", std::ios_base::in}}, 
            {".jpg", {"image/jpeg", std::ios_base::binary}}, 
            {".jpeg", {"image/jpeg", std::ios_base::binary}}, 
            {".png", {"image/png", std::ios_base::binary}}, 
            {".svg", {"image/svg+xml", std::ios_base::in}}, 
    };
    std::string extension = filename.extension().string();

    std::string contentType = "application/octet-stream";
    std::ios_base::openmode openmode = std::ios_base::in;
    auto const& mimeTypeIT = mimeType.find(extension);
    if (mimeTypeIT != mimeType.end()) {
      contentType = mimeTypeIT->second.first;
      openmode = mimeTypeIT->second.second;
    }

    std::ifstream file(filename, openmode);
    if (!file.is_open()) {
      //detectHostileIP_.RecordFailedRequest(srcIP);
      //char cwd[4096] = {};
      //getcwd(cwd, 4096);
      ///LOGWARNING("[%s][%s] unable to access %s cwd: %s", GenerateHumanTS().c_str(), srcIP.c_str(), filename.c_str(), cwd);
      throw std::runtime_error("file open failed");
    }

    response.setContentType(contentType);
    response.setChunkedTransferEncoding(true);
    out = &response.send();
    Poco::StreamCopier::copyStream(file, *out);
    out->flush();
  } catch (const std::exception& e) {
    std::cerr << "File server error: " << e.what() << std::endl;
    if (out != nullptr) {
      out->flush();
    } else if (!response.sent()) {
      response.setStatus(Poco::Net::HTTPResponse::HTTP_INTERNAL_SERVER_ERROR);
      response.send();
    }
  }
}

static void SendJSONResponse(Poco::Net::HTTPServerResponse& response, rapidjson::Document const& doc) {
  rapidjson::StringBuffer buffer;
  rapidjson::Writer<rapidjson::StringBuffer> writer(buffer);
  doc.Accept(writer);

  response.setContentType("application/json");
  response.setStatus(Poco::Net::HTTPResponse::HTTP_OK);
  std::ostream& out = response.send();
  out << buffer.GetString();
  out.flush();
}

static void SendErrorResponse(Poco::Net::HTTPServerResponse& response,
    int status, std::string const& message) {
  rapidjson::Document doc;
  doc.SetObject();
  auto& allocator = doc.GetAllocator();
  doc.AddMember("error", rapidjson::Value(message.c_str(), allocator), allocator);

  rapidjson::StringBuffer buffer;
  rapidjson::Writer<rapidjson::StringBuffer> writer(buffer);
  doc.Accept(writer);

  response.setContentType("application/json");
  response.setStatus(static_cast<Poco::Net::HTTPResponse::HTTPStatus>(status));
  std::ostream& out = response.send();
  out << buffer.GetString();
  out.flush();
}

void ns_Server::RequestHandlerAPIListCommits::handleRequest(
    Poco::Net::HTTPServerRequest& request,
    Poco::Net::HTTPServerResponse& response) {

  if (ManageCORS(request, response)) return;

  std::string const& type = std::get<0>(args_);
  std::vector<ns_Analyze::DataManager::SCommitInfo> commits = apis_->analyzeAPI_.GetCommits(type);

  rapidjson::Document doc;
  doc.SetObject();
  auto& allocator = doc.GetAllocator();

  rapidjson::Value commitsArray(rapidjson::kArrayType);
  for (auto const& info : commits) {
    rapidjson::Value obj(rapidjson::kObjectType);
    obj.AddMember("commit", rapidjson::Value(info.commit.c_str(), allocator), allocator);
    obj.AddMember("timestamp", info.latest, allocator);
    obj.AddMember("count", info.count, allocator);
    commitsArray.PushBack(obj, allocator);
  }

  doc.AddMember("commits", commitsArray, allocator);
  SendJSONResponse(response, doc);
}

void ns_Server::RequestHandlerAPIGetCommitRuns::handleRequest(
    Poco::Net::HTTPServerRequest& request,
    Poco::Net::HTTPServerResponse& response) {

  if (ManageCORS(request, response)) return;

  std::string const& commit = std::get<0>(args_);
  std::vector<std::pair<uint64_t, std::string>> runs = apis_->analyzeAPI_.GetRuns(commit);

  rapidjson::Document doc;
  doc.SetObject();
  auto& allocator = doc.GetAllocator();

  rapidjson::Value runsArray(rapidjson::kArrayType);
  for (auto const& [timestamp, type] : runs) {
    rapidjson::Value obj(rapidjson::kObjectType);
    obj.AddMember("timestamp", timestamp, allocator);
    obj.AddMember("type", rapidjson::Value(type.c_str(), allocator), allocator);
    runsArray.PushBack(obj, allocator);
  }

  doc.AddMember("runs", runsArray, allocator);
  SendJSONResponse(response, doc);
}

void ns_Server::RequestHandlerAPIListCampaigns::handleRequest(
    Poco::Net::HTTPServerRequest& request,
    Poco::Net::HTTPServerResponse& response) {

  if (ManageCORS(request, response)) return;

  std::vector<ns_Analyze::DataManager::RunEntry> campaigns =
      apis_->analyzeAPI_.GetCampaigns();

  rapidjson::Document doc;
  doc.SetArray();
  auto& allocator = doc.GetAllocator();

  for (auto const& run : campaigns) {
    rapidjson::Value obj(rapidjson::kObjectType);
    obj.AddMember("type", rapidjson::Value(run.type.c_str(), allocator), allocator);
    obj.AddMember("user", rapidjson::Value(run.user.c_str(), allocator), allocator);
    obj.AddMember("campaign", rapidjson::Value(run.campaign.c_str(), allocator), allocator);
    obj.AddMember("commit", rapidjson::Value(run.commit.c_str(), allocator), allocator);
    obj.AddMember("timestamp", run.timestamp, allocator);
    rapidjson::Value subjects(rapidjson::kArrayType);
    for (auto const& s : run.subjects) {
      subjects.PushBack(rapidjson::Value(s.c_str(), allocator), allocator);
    }
    obj.AddMember("subjects", subjects, allocator);
    doc.PushBack(obj, allocator);
  }

  SendJSONResponse(response, doc);
}

void ns_Server::RequestHandlerAPIGetCommitSubjects::handleRequest(
    Poco::Net::HTTPServerRequest& request,
    Poco::Net::HTTPServerResponse& response) {

  if (ManageCORS(request, response)) return;

  std::string const& type = std::get<0>(args_);
  std::string const& commitID = std::get<1>(args_);
  uint64_t timestamp = std::get<2>(args_);
  std::vector<std::pair<std::string, uint64_t>> subjects =
      apis_->analyzeAPI_.GetCommitSubjects(type, commitID, timestamp);

  rapidjson::Document doc;
  doc.SetObject();
  auto& allocator = doc.GetAllocator();

  for (auto const& [subject, count] : subjects) {
    doc.AddMember(rapidjson::Value(subject.c_str(), allocator), rapidjson::Value(count), allocator);
  }

  SendJSONResponse(response, doc);
}

void ns_Server::RequestHandlerAPIGetCommitMetrics::handleRequest(
    Poco::Net::HTTPServerRequest& request,
    Poco::Net::HTTPServerResponse& response) {

  if (ManageCORS(request, response)) return;

  std::string const& type = std::get<0>(args_);
  std::string const& commitID = std::get<1>(args_);
  uint64_t timestamp = std::get<2>(args_);
  std::string const& subject = std::get<3>(args_);
  ns_Analyze::DataManager::SMetricsSummaries metricsSummaries =
      apis_->analyzeAPI_.GetCommitMetrics(type, commitID, timestamp, subject);

  rapidjson::Document doc;
  doc.SetObject();
  auto& allocator = doc.GetAllocator();
  doc.AddMember("nbRun", rapidjson::Value(metricsSummaries.nbRun_), allocator);

  rapidjson::Value runsArray(rapidjson::kArrayType);
  for (auto const& runSummary : metricsSummaries.runSummary_) {
    rapidjson::Value runObj(rapidjson::kObjectType);
    
    runObj.AddMember("id", rapidjson::Value(runSummary.id_), allocator);
    runObj.AddMember("nbClient", rapidjson::Value(runSummary.nbClient_), allocator);
    runObj.AddMember("runTime", rapidjson::Value(runSummary.runTime_), allocator);

    std::unordered_set<std::string> uniqueMetrics;
    rapidjson::Value metricsArray(rapidjson::kArrayType);
    for (size_t i=0; i<runSummary.summary_.size(); ++i) {
      for (auto const& [metricName, _] : runSummary.summary_[i]) {
        std::string name = (i == 0 ? "global." : "client.") + metricName;
        if (uniqueMetrics.count(name) == 0) {
          metricsArray.PushBack(rapidjson::Value(name.c_str(), allocator), allocator);
          uniqueMetrics.insert(name);
        }
      }
    }
    runObj.AddMember("metrics", metricsArray, allocator);
    runsArray.PushBack(runObj, allocator);
  }
  doc.AddMember("runs", runsArray, allocator);

  SendJSONResponse(response, doc);
}

bool ValidateJSONArray(rapidjson::Document const& doc, std::string const& name, bool& error) {
  error = false;
  if (!doc.HasMember(name.c_str())) {
    return false;
  }
  if (!doc[name.c_str()].IsArray()) {
    error = true;
    return false;
  }
  return true;
}

template<typename T>
std::vector<T> ExtractJSONArray(rapidjson::Document const& doc, std::string const& name, bool& error) {
  throw std::runtime_error("Fatal Error, not implemented");
}

template<>
std::vector<uint64_t> ExtractJSONArray(rapidjson::Document const& doc, std::string const& name, bool& error) {
  std::vector<uint64_t> result;
  if (!ValidateJSONArray(doc, name, error)) {
    return {};
  }
  for (auto const& item : doc[name.c_str()].GetArray()) {
    if (item.IsUint64()) {
      result.push_back(item.GetUint64());
    } else if (item.IsInt64() && item.GetInt64() >= 0) {
      result.push_back(static_cast<uint64_t>(item.GetInt64()));
    } else if (item.IsInt() && item.GetInt() >= 0) {
      result.push_back(static_cast<uint64_t>(item.GetInt()));
    } else {
      error = true;
    }
  }
  return result;
}

template<>
std::vector<std::string> ExtractJSONArray(rapidjson::Document const& doc, std::string const& name, bool& error) {
  std::vector<std::string> result;
  if (!ValidateJSONArray(doc, name, error)) {
    return {};
  }
  for (auto const& item : doc[name.c_str()].GetArray()) {
    if (item.IsString()) {
      result.push_back(item.GetString());
    } else {
      error = true;
    }
  }
  return result;
}

void ns_Server::RequestHandlerAPIGetCommitMetricsValues::handleRequest(
    Poco::Net::HTTPServerRequest& request,
    Poco::Net::HTTPServerResponse& response) {

  if (ManageCORS(request, response)) return;

  static ResponseCache valuesCache(256);

  std::string const& type = std::get<0>(args_);
  std::string const& commitID = std::get<1>(args_);
  uint64_t timestamp = std::get<2>(args_);
  std::string const& subject = std::get<3>(args_);
  uint64_t min = std::get<4>(args_);
  uint64_t max = std::get<5>(args_);
  uint64_t step = std::get<6>(args_);

  std::istream& stream = request.stream();
  std::stringstream ss;
  ss << stream.rdbuf();
  std::string const body = ss.str();

  rapidjson::Document doc;
  doc.Parse(body.c_str());
  if (doc.HasParseError()) {
    SendErrorResponse(response, 400, "Invalid json in request body");
    return;
  }

  bool error;
  std::vector<uint64_t> runs = ExtractJSONArray<uint64_t>(doc, "runs", error);
  if (error) {
    SendErrorResponse(response, 400, "Invalid json in request body");
    return;
  }
  std::vector<uint64_t> clients = ExtractJSONArray<uint64_t>(doc, "clients", error);
  if (error) {
    SendErrorResponse(response, 400, "Invalid json in request body");
    return;
  }
  std::vector<std::string> metrics = ExtractJSONArray<std::string>(doc, "metrics", error);
  if (metrics.empty() || error) {
    SendErrorResponse(response, 400, "Invalid json in request body");
    return;
  }

  // Response cache: key on the normalized request (runId, params, sorted selection)
  // for an unchanged run -> hit. Built from parsed fields so byte differences in
  // the body (whitespace, key/array order) still hit the same entry.
  std::string const runTag = apis_->analyzeAPI_.GetRunTag(type, commitID, timestamp);
  std::string cacheKey;
  if (!runTag.empty()) {
    auto joinU64 = [](std::vector<uint64_t> v) {
      std::sort(v.begin(), v.end());
      std::string s;
      for (uint64_t x : v) { s += std::to_string(x); s += ','; }
      return s;
    };
    std::vector<std::string> sortedMetrics = metrics;
    std::sort(sortedMetrics.begin(), sortedMetrics.end());
    std::string metricsJoined;
    for (std::string const& m : sortedMetrics) { metricsJoined += m; metricsJoined += ','; }

    cacheKey = type + "/" + commitID + "/" + std::to_string(timestamp) + "/" + subject +
        "/" + std::to_string(min) + "/" + std::to_string(max) + "/" + std::to_string(step) +
        "@" + runTag + "#runs=" + joinU64(runs) +
        ";clients=" + joinU64(clients) + ";metrics=" + metricsJoined;
    std::string cached;
    if (valuesCache.Get(cacheKey, cached)) {
      response.setStatus(Poco::Net::HTTPServerResponse::HTTP_OK);
      response.setContentType("application/x-metrics-binary+json");
      response.setContentLength64(cached.size());
      std::ostream& ostr = response.send();
      ostr.write(cached.data(), static_cast<std::streamsize>(cached.size()));
      ostr.flush();
      return;
    }
  }

  std::unordered_map<std::string, std::vector<struct ns_Analyze::DataManager::SMetricValues>> values;
  try {
    values = apis_->analyzeAPI_.GetCommitValues(type, commitID, timestamp, subject, min, max, step,
        runs, clients, metrics);
  } catch (std::exception const& e) {
    std::cerr << "[GetCommitValues] exception: " << e.what() << std::endl;
    SendErrorResponse(response, 500, std::string("Internal error: ") + e.what());
    return;
  }

  doc.SetObject();
  auto& allocator = doc.GetAllocator();

  doc.AddMember("endian", rapidjson::Value("little", allocator), allocator);
  doc.AddMember("min", min, allocator);
  doc.AddMember("max", max, allocator);
  doc.AddMember("step", step, allocator);
  doc.AddMember("count", ((max - min) + step - 1) / step, allocator);

  rapidjson::Value runsArray(rapidjson::kArrayType);
  for(uint64_t runID: runs) {
    runsArray.PushBack(runID, allocator);
  }
  doc.AddMember("runs", runsArray, allocator);

  rapidjson::Value clientsArray(rapidjson::kArrayType);
  for(uint64_t clientID: clients) {
    clientsArray.PushBack(clientID, allocator);
  }
  doc.AddMember("clients", clientsArray, allocator);

  rapidjson::Value metricsArray(rapidjson::kArrayType);
  metricsArray.Reserve(static_cast<rapidjson::SizeType>(values.size()), allocator);
  for(auto const& [name, series]: values) {
    rapidjson::Value metricObj(rapidjson::kObjectType);
    metricObj.AddMember("name", rapidjson::Value(name.c_str(), allocator), allocator);
    char const* typeStr = std::holds_alternative<std::vector<uint64_t>>(series[0].values_) ? "uint64" : "double";
    metricObj.AddMember("type", rapidjson::Value(typeStr, allocator), allocator);
    metricObj.AddMember("count", series.size(), allocator);
    metricsArray.PushBack(metricObj, allocator);
  }
  doc.AddMember("metrics", metricsArray, allocator);

  rapidjson::StringBuffer jsonBuffer;
  rapidjson::Writer<rapidjson::StringBuffer> jsonWriter(jsonBuffer);
  doc.Accept(jsonWriter);

  std::string jsonHeader = jsonBuffer.GetString();
  uint64_t jsonSizeLE = jsonHeader.size();
  
  uint64_t alignHeader = jsonHeader.size() % 8;
  if (alignHeader != 0) {
    alignHeader = 8 - alignHeader;
    for(int i=0; i<alignHeader; ++i) {
      jsonHeader.push_back(0);
    }
  }

  uint64_t dataSize = 8 + jsonHeader.size();

  for (const auto& [name, series]: values) {
    for (const auto& serie: series) {
      if (std::holds_alternative<std::vector<uint64_t>>(serie.values_)) {
        dataSize += std::get<std::vector<uint64_t>>(serie.values_).size() * sizeof(uint64_t);
      } else {
        dataSize += std::get<std::vector<double>>(serie.values_).size() * sizeof(double);
      }
    }
  }

  // Assemble the full binary payload once (so it can be cached and written).
  std::string payload;
  payload.reserve(dataSize);
  payload.append(reinterpret_cast<const char*>(&jsonSizeLE), sizeof(jsonSizeLE));
  payload.append(jsonHeader.data(), jsonHeader.size());
  for (const auto& [name, series]: values) {
    for (const auto& serie: series) {
      if (std::holds_alternative<std::vector<uint64_t>>(serie.values_)) {
        std::vector<uint64_t> const& data = std::get<std::vector<uint64_t>>(serie.values_);
        payload.append(reinterpret_cast<const char*>(data.data()), data.size() * sizeof(uint64_t));
      } else {
        std::vector<double> const& data = std::get<std::vector<double>>(serie.values_);
        payload.append(reinterpret_cast<const char*>(data.data()), data.size() * sizeof(double));
      }
    }
  }

  if (!cacheKey.empty()) {
    valuesCache.Put(cacheKey, payload);
  }

  response.setStatus(Poco::Net::HTTPServerResponse::HTTP_OK);
  response.setContentType("application/x-metrics-binary+json");
  response.setContentLength64(payload.size());
  std::ostream& ostr = response.send();
  ostr.write(payload.data(), static_cast<std::streamsize>(payload.size()));
  ostr.flush();
}

void ns_Server::RequestHandlerAPISaveUserData::handleRequest(
    Poco::Net::HTTPServerRequest& request,
    Poco::Net::HTTPServerResponse& response) {

  if (ManageCORS(request, response)) return;

  std::string viewName = decodeViewName(std::get<0>(args_));
  if (!isValidViewName(viewName)) {
    SendErrorResponse(response, 400, "Invalid view name");
    return;
  }
  std::filesystem::path const filePath =
      config_->userdata_ / (viewNameToStem(viewName) + ".json");
  std::istream& stream = request.stream();

  std::ofstream ofs(filePath, std::ios::binary);
  if (!ofs.is_open()) {
    SendErrorResponse(response, 400, "Unable to create file " + filePath.string());
    return;
  }
  ofs << stream.rdbuf();
  ofs.close();

  rapidjson::Document doc;
  SendJSONResponse(response, doc);
}

void ns_Server::RequestHandlerAPILoadUserData::handleRequest(
    Poco::Net::HTTPServerRequest& request,
    Poco::Net::HTTPServerResponse& response) {

  if (ManageCORS(request, response)) return;

  std::string viewName = decodeViewName(std::get<0>(args_));
  if (!isValidViewName(viewName)) {
    SendErrorResponse(response, 400, "Invalid view name");
    return;
  }
  std::filesystem::path const filePath =
      config_->userdata_ / (viewNameToStem(viewName) + ".json");

  rapidjson::Document doc;
  try {
    ReadJSONFile(filePath.string(), doc);
  } catch(...) {
    SendErrorResponse(response, 400, "Unable to read " + filePath.string());
    return;
  }

  SendJSONResponse(response, doc);
}

void ns_Server::RequestHandlerAPIListUserData::handleRequest(
    Poco::Net::HTTPServerRequest& request,
    Poco::Net::HTTPServerResponse& response) {

  if (ManageCORS(request, response)) return;

  std::string const& path = config_->userdata_;

  rapidjson::Document doc;
  doc.SetObject();
  auto& allocator = doc.GetAllocator();

  try {
    rapidjson::Value files(rapidjson::kArrayType);

    if (!std::filesystem::exists(path) || !std::filesystem::is_directory(path)) {
      SendErrorResponse(response, 500, "Userdata directory not found");
      return;
    }

    for (auto const& entry : std::filesystem::directory_iterator(path)) {
      if (entry.is_regular_file()) {
        if (entry.path().extension().string() != ".json") {
          continue;
        }
        std::string filename = stemToViewName(entry.path().stem().string());
        rapidjson::Value filenameVal;
        filenameVal.SetString(filename.c_str(), filename.length(), allocator);
        files.PushBack(filenameVal, allocator);
      }
    }

    doc.AddMember("files", files, allocator);
  } catch(...) {
    SendErrorResponse(response, 400, "Unable to list userdata");
    return;
  }

  SendJSONResponse(response, doc);
}

void ns_Server::RequestHandlerAPIDeleteUserData::handleRequest(
    Poco::Net::HTTPServerRequest& request,
    Poco::Net::HTTPServerResponse& response) {

  if (ManageCORS(request, response)) return;

  std::string viewName = decodeViewName(std::get<0>(args_));
  if (!isValidViewName(viewName)) {
    SendErrorResponse(response, 400, "Invalid view name");
    return;
  }
  std::filesystem::path const filePath =
      config_->userdata_ / (viewNameToStem(viewName) + ".json");

  if (!std::filesystem::exists(filePath)) {
    SendErrorResponse(response, 404, "View not found: " + filePath.string());
    return;
  }

  try {
    std::filesystem::remove(filePath);
  } catch (std::exception const& e) {
    SendErrorResponse(response, 500, std::string("Failed to delete view: ") + e.what());
    return;
  }

  rapidjson::Document doc;
  SendJSONResponse(response, doc);
}

// ── Template helpers ──────────────────────────────────────────────────────────

static std::filesystem::path getTemplatesDir(ns_Server::Config const* config) {
  return config->userdata_ / "templates";
}

void ns_Server::RequestHandlerAPISaveTemplate::handleRequest(
    Poco::Net::HTTPServerRequest& request,
    Poco::Net::HTTPServerResponse& response) {

  if (ManageCORS(request, response)) return;

  std::string templateName = decodeViewName(std::get<0>(args_));
  if (!isValidViewName(templateName)) {
    SendErrorResponse(response, 400, "Invalid template name");
    return;
  }
  std::filesystem::path const dir = getTemplatesDir(config_);
  std::filesystem::create_directories(dir);
  std::filesystem::path const filePath = dir / (viewNameToStem(templateName) + ".json");

  std::istream& stream = request.stream();
  std::ofstream ofs(filePath, std::ios::binary);
  if (!ofs.is_open()) {
    SendErrorResponse(response, 500, "Unable to create template " + filePath.string());
    return;
  }
  ofs << stream.rdbuf();
  if (ofs.fail()) {
    SendErrorResponse(response, 500, "Failed to write template data");
    return;
  }
  ofs.close();

  rapidjson::Document doc;
  doc.SetObject();
  doc.AddMember("status", "ok", doc.GetAllocator());
  SendJSONResponse(response, doc);
}

void ns_Server::RequestHandlerAPILoadTemplate::handleRequest(
    Poco::Net::HTTPServerRequest& request,
    Poco::Net::HTTPServerResponse& response) {

  if (ManageCORS(request, response)) return;

  std::string templateName = decodeViewName(std::get<0>(args_));
  if (!isValidViewName(templateName)) {
    SendErrorResponse(response, 400, "Invalid template name");
    return;
  }
  std::filesystem::path const filePath =
      getTemplatesDir(config_) / (viewNameToStem(templateName) + ".json");

  rapidjson::Document doc;
  try {
    ReadJSONFile(filePath.string(), doc);
  } catch (...) {
    SendErrorResponse(response, 404, "Template not found: " + filePath.string());
    return;
  }
  SendJSONResponse(response, doc);
}

void ns_Server::RequestHandlerAPIListTemplates::handleRequest(
    Poco::Net::HTTPServerRequest& request,
    Poco::Net::HTTPServerResponse& response) {

  if (ManageCORS(request, response)) return;

  std::filesystem::path const dir = getTemplatesDir(config_);

  rapidjson::Document doc;
  doc.SetObject();
  auto& allocator = doc.GetAllocator();
  rapidjson::Value files(rapidjson::kArrayType);

  if (std::filesystem::exists(dir) && std::filesystem::is_directory(dir)) {
    for (auto const& entry : std::filesystem::directory_iterator(dir)) {
      if (!entry.is_regular_file()) continue;
      if (entry.path().extension().string() != ".json") continue;
      std::string filename = stemToViewName(entry.path().stem().string());
      rapidjson::Value filenameVal;
      filenameVal.SetString(filename.c_str(), filename.length(), allocator);
      files.PushBack(filenameVal, allocator);
    }
  }

  doc.AddMember("files", files, allocator);
  SendJSONResponse(response, doc);
}

// Returns, for every saved template, only the names of its variables per
// category — enough for the client to match templates against a URL without
// fetching every full template definition. Variables are stored as serialised
// Maps: { "__type":"Map", "value":[ ["c1", {...}], ... ] }, so a variable name
// is the first element of each entry pair.
void ns_Server::RequestHandlerAPIListTemplateVariables::handleRequest(
    Poco::Net::HTTPServerRequest& request,
    Poco::Net::HTTPServerResponse& response) {

  if (ManageCORS(request, response)) return;

  std::filesystem::path const dir = getTemplatesDir(config_);

  rapidjson::Document doc;
  doc.SetObject();
  auto& allocator = doc.GetAllocator();
  rapidjson::Value templates(rapidjson::kObjectType);

  static char const* const kCategories[] = {"commits", "subtasks", "campaigns", "metrics"};

  if (std::filesystem::exists(dir) && std::filesystem::is_directory(dir)) {
    for (auto const& entry : std::filesystem::directory_iterator(dir)) {
      if (!entry.is_regular_file()) continue;
      if (entry.path().extension().string() != ".json") continue;

      rapidjson::Document tdoc;
      try {
        ReadJSONFile(entry.path().string(), tdoc);
      } catch (...) {
        continue;  // skip unreadable / corrupt templates
      }

      rapidjson::Value const* variables = nullptr;
      if (tdoc.IsObject() && tdoc.HasMember("variables") && tdoc["variables"].IsObject()) {
        variables = &tdoc["variables"];
      }

      rapidjson::Value vars(rapidjson::kObjectType);
      for (char const* cat : kCategories) {
        rapidjson::Value names(rapidjson::kArrayType);
        if (variables && variables->HasMember(cat)) {
          auto const& m = (*variables)[cat];
          if (m.IsObject() && m.HasMember("value") && m["value"].IsArray()) {
            for (auto const& pair : m["value"].GetArray()) {
              if (pair.IsArray() && pair.Size() >= 1 && pair[0].IsString()) {
                rapidjson::Value n;
                n.SetString(pair[0].GetString(), pair[0].GetStringLength(), allocator);
                names.PushBack(n, allocator);
              }
            }
          }
        }
        rapidjson::Value catKey(cat, allocator);
        vars.AddMember(catKey, names, allocator);
      }

      std::string name = stemToViewName(entry.path().stem().string());
      rapidjson::Value nameKey(name.c_str(), name.length(), allocator);
      templates.AddMember(nameKey, vars, allocator);
    }
  }

  doc.AddMember("templates", templates, allocator);
  SendJSONResponse(response, doc);
}

void ns_Server::RequestHandlerAPIDeleteTemplate::handleRequest(
    Poco::Net::HTTPServerRequest& request,
    Poco::Net::HTTPServerResponse& response) {

  if (ManageCORS(request, response)) return;

  std::string templateName = decodeViewName(std::get<0>(args_));
  if (!isValidViewName(templateName)) {
    SendErrorResponse(response, 400, "Invalid template name");
    return;
  }
  std::filesystem::path const filePath =
      getTemplatesDir(config_) / (viewNameToStem(templateName) + ".json");

  if (!std::filesystem::exists(filePath)) {
    SendErrorResponse(response, 404, "Template not found: " + filePath.string());
    return;
  }
  try {
    std::filesystem::remove(filePath);
  } catch (std::exception const& e) {
    SendErrorResponse(response, 500,
        std::string("Failed to delete template: ") + e.what());
    return;
  }

  rapidjson::Document doc;
  doc.SetObject();
  SendJSONResponse(response, doc);
}

// Proxies a GET to an upstream JSON URL and forwards the body verbatim. On any
// failure (non-2xx upstream, exception) it replies 200 with `fallback` so the
// frontend always receives valid JSON. `label` tags error logs. Exactly one of
// the response.send() paths runs per call.
static void ProxyGetJSON(std::string const& fullUrl, char const* label,
    char const* fallback, Poco::Net::HTTPServerResponse& response) {
  response.setContentType("application/json");
  response.setStatus(Poco::Net::HTTPResponse::HTTP_OK);
  try {
    Poco::URI uri(fullUrl);
    std::string path = uri.getPathAndQuery();
    if (path.empty()) path = "/";

    std::unique_ptr<Poco::Net::HTTPClientSession> session;
    if (uri.getScheme() == "https") {
      session = std::make_unique<Poco::Net::HTTPSClientSession>(
          uri.getHost(), uri.getPort());
    } else {
      session = std::make_unique<Poco::Net::HTTPClientSession>(
          uri.getHost(), uri.getPort());
    }

    Poco::Net::HTTPRequest req(
        Poco::Net::HTTPRequest::HTTP_GET, path,
        Poco::Net::HTTPMessage::HTTP_1_1);
    req.setHost(uri.getHost());
    session->setTimeout(Poco::Timespan(10, 0));
    session->sendRequest(req);

    Poco::Net::HTTPResponse resp;
    std::istream& bodyStream = session->receiveResponse(resp);

    if (resp.getStatus() < 200 || resp.getStatus() >= 300) {
      response.send() << fallback;
      return;
    }

    std::stringstream ss;
    ss << bodyStream.rdbuf();
    response.send() << ss.str();
  } catch (std::exception const& e) {
    std::cerr << "[" << label << "] " << e.what() << std::endl;
    response.send() << fallback;
  }
}

// Get GIT history
void ns_Server::RequestHandlerAPIGetGitHistory::handleRequest(
    Poco::Net::HTTPServerRequest& request,
    Poco::Net::HTTPServerResponse& response) {

  if (ManageCORS(request, response)) return;

  std::string const& url = config_->git_history_url_;
  if (url.empty()) {
    response.setContentType("application/json");
    response.setStatus(Poco::Net::HTTPResponse::HTTP_OK);
    response.send() << "[]";
    return;
  }

  ProxyGetJSON(url, "git/history proxy", "[]", response);
}

// Proxies the git-log endpoint for a single commit. The log URL is derived from
// the configured history URL (".../api/git/history/<repo>" -> ".../api/git/log/
// <repo>?commit=<id>"). Same CORS-driven proxy pattern as the history handler.
void ns_Server::RequestHandlerAPIGetGitLog::handleRequest(
    Poco::Net::HTTPServerRequest& request,
    Poco::Net::HTTPServerResponse& response) {

  if (ManageCORS(request, response)) return;

  std::string const& url = config_->git_history_url_;
  std::string const commit = std::get<0>(args_);

  std::string::size_type const pos = url.find("/git/history/");
  if (url.empty() || pos == std::string::npos) {
    response.setContentType("application/json");
    response.setStatus(Poco::Net::HTTPResponse::HTTP_OK);
    response.send() << "{}";
    return;
  }

  std::string logUrl = url;
  logUrl.replace(pos, std::string("/git/history/").length(), "/git/log/");
  Poco::URI logUri(logUrl);
  logUri.addQueryParameter("commit", commit);

  ProxyGetJSON(logUri.toString(), "git/log proxy", "{}", response);
}
