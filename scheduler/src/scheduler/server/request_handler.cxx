#include "request_handler.hxx"
#include "parts_handler.hxx"
#include "../../utils/rapidjson.hxx"
#include <fstream>
#include <unordered_map>
#include <Poco/JSON/Object.h>
#include <Poco/JSON/Stringifier.h>
#include <Poco/Net/HTTPServerRequest.h>
#include <Poco/Base64Encoder.h>
#include <Poco/StreamCopier.h>
#include <Poco/URI.h>

inline static bool ToBool(std::string const& v) {
  return v == "1" || v == "true" || v == "on" || v == "yes";
};

static bool ManageCORS(Poco::Net::HTTPServerRequest& request,
    Poco::Net::HTTPServerResponse& response) {
  response.set("Access-Control-Allow-Origin", "*");
  response.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
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
  response.send() << "404 - Path not found: " << request.getURI();
}

void ns_Server::RequestHandlerTaskNew::handleRequest(Poco::Net::HTTPServerRequest& request,
    Poco::Net::HTTPServerResponse& response) {
  response.setChunkedTransferEncoding(true);
  response.setContentType("application/json; charset=utf-8");
  response.set("Cache-Control", "no-store, no-cache, must-revalidate");
  response.set("Pragma", "no-cache");

  PartsHandler partsHandler;
  Poco::Net::HTMLForm form(request, request.stream(), partsHandler);
  std::unordered_multimap<std::string, ns_Server::PartsHandler::PartData> const& parts = 
      partsHandler.GetParts();

  std::ostream& out = response.send();
  try {
    std::string name = form.get("name", "");
    auto flow = parts.find("config");
    auto functions = parts.find("script");

    if ((flow == parts.end()) || (functions == parts.end())) {
      out << R"({"success": false, "error": "Missing config or script file."})";
      out.flush();
      return;
    }

    std::string user = "anonymous";
    auto userIT = parts.find("user");
    if (userIT != parts.end()) {
      user = userIT->second.content[0];
    }
    std::string jobType = "unknown";
    auto jobTypeIT = parts.find("job_type");
    if (jobTypeIT != parts.end()) {
      jobType = jobTypeIT->second.content[0];
    }

    std::unordered_map<std::string, std::vector<uint8_t>> files;
    auto range = parts.equal_range("files[]");
    for (auto it = range.first; it != range.second; ++it) {
      const auto& partData = it->second;
      files.emplace(partData.filename, std::move(partData.content));
    }

    std::unordered_map<std::string, std::string> args;
    for (auto& [name, value] : form) {
      if ((name.find("args[") != 0) || (name.rfind("]") != (name.size()-1))) {
        continue;
      }
      std::string key = name.substr(5, name.size() - 6);
      if (key.empty()) {
        throw std::runtime_error("Empty key in args[]");
      }
      auto success = args.emplace(key, value);
      if (!success.second) {
        throw std::runtime_error("args[] value duplicate key found");
      }
    }

    std::unordered_map<std::string, std::string> runtimeConfig;
    for (auto& [name, value] : form) {
      if ((name.find("runtime[") != 0) || (name.rfind("]") != (name.size()-1))) {
        continue;
      }
      std::string key = name.substr(16, name.size() - 17);
      if (key.empty()) {
        throw std::runtime_error("Empty key in runtime[]");
      }
      auto success = runtimeConfig.emplace(key, value);
      if (!success.second) {
        throw std::runtime_error("runtime[] value duplicate key found");
      }
    }

    uint64_t taskID = apis_->scheduleAPI_.AddTask(name, flow->second.content, 
        functions->second.content, files, args, runtimeConfig, user, jobType);

    out << R"({"success": true, "task_id": ")" << taskID << R"("})";
  } catch (const std::exception& e) {
    response.setStatus(Poco::Net::HTTPResponse::HTTP_INTERNAL_SERVER_ERROR);
    out << R"({"success": false, "error": ")" << e.what() << R"("})";
  }
  out.flush();
}

void ns_Server::RequestHandlerTasksRunning::handleRequest(Poco::Net::HTTPServerRequest& request,
    Poco::Net::HTTPServerResponse& response) {
  if (ManageCORS(request, response)) {
    return;
  }

  response.setChunkedTransferEncoding(true);
  response.setContentType("application/json; charset=utf-8");
  response.set("Cache-Control", "no-store, no-cache, must-revalidate");
  response.set("Pragma", "no-cache");

  std::ostream& out = response.send();
  try {
    std::ifstream ifs(apis_->scheduleAPI_.ExportPath() / "tasksmanager.json");
    if (!ifs.is_open()) {
      throw std::runtime_error("Server can't read schedule status");
    }
    std::stringstream buffer;
    buffer << ifs.rdbuf();
    out << R"({"success": true, "data": )" << buffer.str() << "}";
  } catch(std::runtime_error const& e) {
    response.setStatus(Poco::Net::HTTPResponse::HTTP_INTERNAL_SERVER_ERROR);
    out << R"({"success": false, "error": ")" << e.what() << R"("})";
  }
  out.flush();
}

void ns_Server::RequestHandlerTaskOutputs::handleRequest(Poco::Net::HTTPServerRequest& request,
    Poco::Net::HTTPServerResponse& response) {
  if (ManageCORS(request, response)) {
    return;
  }

  response.setContentType("application/json; charset=utf-8");
  response.setChunkedTransferEncoding(true);

  std::ostream* out = nullptr;
  try {
    std::string const& taskid = std::get<0>(args_);
    uint64_t stepuuid = std::get<1>(args_);
    std::string const& stepid = std::get<2>(args_);
    std::string const& type = std::get<3>(args_);
    size_t readsize = std::get<4>(args_);
    ssize_t readoffset = std::get<5>(args_);

    if ((type.empty()) || (taskid.empty()) || (stepid.empty())) {
      throw std::runtime_error("Missing required parameter(s)");
    }

    struct FileExtractedText data;
    data.requestReadOffset = readoffset;
    data.requestReadSize = readsize;
    apis_->scheduleAPI_.GetOutput(type, taskid, stepuuid, stepid, data);
    if ((data.state != FileReadState::Ok) && (data.state != FileReadState::EndOfFile)) {
      throw std::runtime_error("Server can't read requested output");
    } else if (data.partialFile) {
      response.set("Cache-Control", "no-store, no-cache, must-revalidate");
      response.set("Pragma", "no-cache");
    }

    std::ostringstream oss;
    Poco::Base64Encoder encoder(oss);
    encoder.rdbuf()->setLineLength(0);
    encoder << data.buffer;
    encoder.close();

    out = &(response.send());

    *out << R"({"success": true, "data": ")" << oss.str() << R"(", "size": )" << 
        data.buffer.size() << R"(, "filesize": )" << data.filesize << R"(, "state": )" << 
        (int)(data.state) << R"(, "support_seek": )" << data.supportSeek << 
        R"(, "start_offset": )" << data.startOffset << "}";
  } catch(std::runtime_error const& e) {
    response.setStatus(Poco::Net::HTTPResponse::HTTP_INTERNAL_SERVER_ERROR);
    if (out == nullptr) {
      out = &(response.send());
    }
    *out << R"({"success": false, "error": ")" << e.what() << R"("})";
  }
  out->flush();
}

void ns_Server::RequestHandlerTaskCancel::handleRequest(Poco::Net::HTTPServerRequest& request,
    Poco::Net::HTTPServerResponse& response) {
  uint64_t taskID = std::get<0>(args_);

  if (ManageCORS(request, response)) {
    return;
  }

  response.setChunkedTransferEncoding(true);
  response.setContentType("application/json; charset=utf-8");
  response.set("Cache-Control", "no-store, no-cache, must-revalidate");
  response.set("Pragma", "no-cache");

  std::ostream* out = nullptr;
  try {
    if (!apis_->scheduleAPI_.CancelTask(taskID)) {
      response.setStatus(Poco::Net::HTTPResponse::HTTP_INTERNAL_SERVER_ERROR);
      throw std::runtime_error("task cancel failed");
    }
    out = &(response.send());
    *out << R"({"success": true})";
  } catch(std::runtime_error const& e) {
    out = &(response.send());
    *out << R"({"success": false, "error": ")" << e.what() << R"("})";
  }
  out->flush();
}

void ns_Server::RequestHandlerTaskCancelStep::handleRequest(Poco::Net::HTTPServerRequest& request,
    Poco::Net::HTTPServerResponse& response) {
  uint64_t taskID = std::get<0>(args_);
  uint64_t stepUUID = std::get<1>(args_);

  if (ManageCORS(request, response)) {
    return;
  }

  response.setChunkedTransferEncoding(true);
  response.setContentType("application/json; charset=utf-8");
  response.set("Cache-Control", "no-store, no-cache, must-revalidate");
  response.set("Pragma", "no-cache");

  std::ostream* out = nullptr;
  try {
    if (!apis_->scheduleAPI_.CancelStep(taskID, stepUUID)) {
      response.setStatus(Poco::Net::HTTPResponse::HTTP_INTERNAL_SERVER_ERROR);
      throw std::runtime_error("step cancel failed");
    }
    out = &(response.send());
    *out << R"({"success": true})";
  } catch(std::runtime_error const& e) {
    out = &(response.send());
    *out << R"({"success": false, "error": ")" << e.what() << R"("})";
  }
  out->flush();
}

void ns_Server::RequestHandlerUsersList::handleRequest(Poco::Net::HTTPServerRequest& request,
    Poco::Net::HTTPServerResponse& response) {
  if (ManageCORS(request, response)) {
    return;
  }
  response.setChunkedTransferEncoding(true);
  response.setContentType("application/json; charset=utf-8");
  response.set("Cache-Control", "no-store, no-cache, must-revalidate");
  response.set("Pragma", "no-cache");

  std::ostream* out = nullptr;
  try {
    std::vector<std::string> users = apis_->usersAPI_.Users();
    out = &(response.send());
    *out << R"({"success": true, "data": [)";
    for (size_t i = 0; i < users.size(); ++i) {
      if (i > 0) {
        *out << ",";
      }
      *out << R"(")" << users[i] << R"(")";
    }
    *out << "]}";
  } catch(std::runtime_error const& e) {
    response.setStatus(Poco::Net::HTTPResponse::HTTP_INTERNAL_SERVER_ERROR);
    out = &(response.send());
    *out << R"({"success": false, "error": ")" << e.what() << R"("})";
  }
  out->flush();
}

void ns_Server::RequestHandlerUserJobsTypeList::handleRequest(Poco::Net::HTTPServerRequest& request,
    Poco::Net::HTTPServerResponse& response) {
  if (ManageCORS(request, response)) {
    return;
  }
  response.setChunkedTransferEncoding(true);
  response.setContentType("application/json; charset=utf-8");
  response.set("Cache-Control", "no-store, no-cache, must-revalidate");
  response.set("Pragma", "no-cache");

  std::ostream* out = nullptr;
  std::string user = std::get<0>(args_);
  try {
    std::vector<std::string> jobsType;
    if (!apis_->usersAPI_.UserJobTypes(user, jobsType)) {
      response.setStatus(Poco::Net::HTTPResponse::HTTP_INTERNAL_SERVER_ERROR);
      throw std::runtime_error("step cancel failed");
    }
    out = &(response.send());
    *out << R"({"success": true, "data": [)";
    for (size_t i = 0; i < jobsType.size(); ++i) {
      if (i > 0) {
        *out << ",";
      }
      *out << R"(")" << jobsType[i] << R"(")";
    }
    *out << "]}";
  } catch(std::runtime_error const& e) {
    response.setStatus(Poco::Net::HTTPResponse::HTTP_INTERNAL_SERVER_ERROR);
    out = &(response.send());
    *out << R"({"success": false, "error": ")" << e.what() << R"("})";
  }
  out->flush();
}

void ns_Server::RequestHandlerUserTasksList::handleRequest(Poco::Net::HTTPServerRequest& request,
    Poco::Net::HTTPServerResponse& response) {
  if (ManageCORS(request, response)) {
    return;
  }
  response.setChunkedTransferEncoding(true);
  response.setContentType("application/json; charset=utf-8");
  response.set("Cache-Control", "no-store, no-cache, must-revalidate");
  response.set("Pragma", "no-cache");

  std::ostream* out = nullptr;
  std::string user = std::get<0>(args_);
  std::string jobType = std::get<1>(args_);
  try {
    std::vector<struct ns_API::UsersAPI::TaskInfos> tasks;
    if (!apis_->usersAPI_.UserTasks(user, jobType, tasks)) {
      response.setStatus(Poco::Net::HTTPResponse::HTTP_INTERNAL_SERVER_ERROR);
      throw std::runtime_error("step cancel failed");
    }
    out = &(response.send());
    *out << R"({"success": true, "data": [)";
    for (size_t i = 0; i < tasks.size(); ++i) {
      if (i > 0) {
        *out << ",";
      }
      *out << tasks[i].ToJSON();
    }
    *out << "]}";
  } catch(std::runtime_error const& e) {
    response.setStatus(Poco::Net::HTTPResponse::HTTP_INTERNAL_SERVER_ERROR);
    out = &(response.send());
    *out << R"({"success": false, "error": ")" << e.what() << R"("})";
  }
  out->flush();
}

void ns_Server::RequestHandlerCachePut::handleRequest(Poco::Net::HTTPServerRequest& request,
    Poco::Net::HTTPServerResponse& response) {
  response.setChunkedTransferEncoding(true);
  response.setContentType("application/json; charset=utf-8");
  response.set("Cache-Control", "no-store, no-cache, must-revalidate");
  response.set("Pragma", "no-cache");

  std::ostream& out = response.send();
  try {
    std::istream& stream = request.stream();
    std::string jsonBody;
    std::getline(stream, jsonBody, '\0');

    rapidjson::Document doc;
    doc.Parse(jsonBody.c_str());
    if (doc.HasParseError()) {
      throw std::runtime_error("Invalid JSON format");
    }

    std::string const& id = std::get<0>(args_);
    std::string srcPath = GetOrDefault<std::string>(doc, "path", "");
    bool computeMD5 = GetOrDefault<bool>(doc, "computeMD5", false);
    bool force = GetOrDefault<bool>(doc, "force", false);

    if (id.empty() || srcPath.empty()) {
      throw std::runtime_error("Missing required parameters id and/or path");
    }

    bool result = apis_->cacheAPI_.Put(srcPath, id, force, computeMD5);
    out << R"({"success": )"<< (result ? "true" : "false") << R"(})";
  } catch (const std::exception& e) {
    response.setStatus(Poco::Net::HTTPResponse::HTTP_INTERNAL_SERVER_ERROR);
    out << R"({"success": false, "error": ")" << e.what() << R"("})";
  }
  out.flush();
}

void ns_Server::RequestHandlerCacheGet::handleRequest(Poco::Net::HTTPServerRequest& request,
    Poco::Net::HTTPServerResponse& response) {
  response.setChunkedTransferEncoding(true);
  response.setContentType("application/json; charset=utf-8");
  response.set("Cache-Control", "no-store, no-cache, must-revalidate");
  response.set("Pragma", "no-cache");

  std::string const& id = std::get<0>(args_);

  std::ostream& out = response.send();
  try {
    if (id.empty()) {
      out << R"({"success": false, "error": "Missing required parameters id."})";
      out.flush();
      return;
    }

    std::filesystem::path path;
    std::string state = apis_->cacheAPI_.Get(id, path);

    out << R"({"success": true, "state": ")" + state + R"(", "path": ")" + path.string() + R"(" })";
  } catch (const std::exception& e) {
    response.setStatus(Poco::Net::HTTPResponse::HTTP_INTERNAL_SERVER_ERROR);
    out << R"({"success": false, "error": ")" << e.what() << R"("})";
  }
  out.flush();
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
