#include "request_handler.hxx"
#include "parts_handler.hxx"
#include "../../utils/rapidjson.hxx"
#include <fstream>
#include <mutex>
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

void ns_Server::RequestHandlerHistory::handleRequest(Poco::Net::HTTPServerRequest& request,
    Poco::Net::HTTPServerResponse& response) {

  if (ManageCORS(request, response)) {
    return;
  }

  response.setChunkedTransferEncoding(true);
  response.setContentType("application/json; charset=utf-8");
  response.set("Cache-Control", "no-store, no-cache, must-revalidate");
  response.set("Pragma", "no-cache");

  std::string const& url = std::get<0>(args_);
  Poco::URI uri(url);

  std::vector<std::string> branches;

  for (auto& param : uri.getQueryParameters()) {
    if (param.first == "branches") {
      std::stringstream ss(param.second);
      std::string branche;
      while (std::getline(ss, branche, ',')) {
        branches.push_back(branche);
      }
    } else {
      response.setStatus(Poco::Net::HTTPResponse::HTTP_BAD_REQUEST);
      std::ostream& out = response.send();
      out << R"({"success": false, "error": "Invalid parameters"})";
      out.flush();
      return;
    }
  }

  bool fileError = false;
  std::filesystem::path outFile = apis_->tmpPath_ / ("git_cache.json");
  std::ostream* out = nullptr;
  {
    static std::mutex lock_;
    static std::chrono::steady_clock::time_point lastUpdate{};
    static std::string cachedResult;

    std::lock_guard lock(lock_);

    auto now = std::chrono::steady_clock::now();
    if (cachedResult.empty() || (now - lastUpdate) > std::chrono::minutes(1)) {
      std::system(((apis_->tmpPath_ / "tlspuffin_history.sh").string() + " " + outFile.string() + " --no-standalone " + (apis_->tmpPath_ / "tlspuffin.git").string()).c_str());
      cachedResult.clear();
      std::ifstream ifs(outFile);
      fileError = !(ifs.is_open());
      if (!fileError) {
        cachedResult = std::string(std::istreambuf_iterator<char>(ifs), {});
        fileError = ifs.fail();
        lastUpdate = now;
      }
    }
    if (!cachedResult.empty()) {
      out = &(response.send());
      *out << cachedResult;
    }
  }
  if (fileError) {
    response.setStatus(Poco::Net::HTTPResponse::HTTP_INTERNAL_SERVER_ERROR);
    std::ostream& out = response.send();
    out << R"({"success": false, "error": "Unable to send git history file"})";
    out.flush();
    return;
  }
  out->flush();
}
