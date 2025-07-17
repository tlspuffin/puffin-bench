#include "request_handler.hxx"
#include "parts_handler.hxx"
#include <fstream>
#include <Poco/JSON/Object.h>
#include <Poco/JSON/Stringifier.h>
#include <Poco/Net/HTTPServerRequest.h>

inline static bool ToBool(std::string const& v) {
  return v == "1" || v == "true" || v == "on" || v == "yes";
};

void ns_Server::RequestHandlerTaskNew::handleRequest(Poco::Net::HTTPServerRequest& request,
    Poco::Net::HTTPServerResponse& response) {
  response.setChunkedTransferEncoding(true);
  response.setContentType("application/json");
  response.set("Cache-Control", "no-store, no-cache, must-revalidate");
  response.set("Pragma", "no-cache");

  PartsHandler partsHandler;
  Poco::Net::HTMLForm form(request, request.stream(), partsHandler);
  //std::string name = form.get("name", "UnnamedTask");
  std::unordered_multimap<std::string, ns_Server::PartsHandler::PartData> const& parts = 
      partsHandler.GetParts();

  std::ostream& out = response.send();
  try {
    auto flow = parts.find("config");
    auto functions = parts.find("script");

    if ((flow == parts.end()) || (functions == parts.end())) {
      out << R"({"success": false, "error": "Missing config or script file."})";
      return;
    }

    std::unordered_map<std::string, std::vector<uint8_t>> files;
    auto range = parts.equal_range("files[]");
    for (auto it = range.first; it != range.second; ++it) {
      const auto& partData = it->second;
      files.emplace(partData.filename, std::move(partData.content));
    }

    std::unordered_map<std::string, std::string> args;
    for (auto key : form) {
      if (key.first.compare("args[]") == 0) {
        std::string const& variable = key.second;
        size_t pos = variable.find('=');
        if (pos == std::string::npos) {
          throw std::runtime_error("args[] value required a =");
        }
        auto success = args.emplace(variable.substr(0, pos), variable.substr(pos+1));
        if (!success.second) {
          throw std::runtime_error("args[] value duplicate key found");
        }
      }
    }

    uint64_t taskID = apis_->scheduleAPI_.AddTask(flow->second.content, 
        functions->second.content, files, args);

    out << R"({"success": true, "task_id": ")" << taskID << R"("})";
  } catch (const std::exception& e) {
    response.setStatus(Poco::Net::HTTPResponse::HTTP_INTERNAL_SERVER_ERROR);
    out << R"({"success": false, "error": ")" << e.what() << R"("})";
  }
}

void ns_Server::RequestHandlerTasksRunning::handleRequest(Poco::Net::HTTPServerRequest& request,
    Poco::Net::HTTPServerResponse& response) {
  response.setChunkedTransferEncoding(true);
  response.setContentType("application/json");
  response.set("Cache-Control", "no-store, no-cache, must-revalidate");
  response.set("Pragma", "no-cache");

  std::ostream& out = response.send();
  try {
    std::ifstream ifs(apis_->scheduleAPI_.ExportPath() / "status.json");
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
}

void ns_Server::RequestHandlerCachePut::handleRequest(Poco::Net::HTTPServerRequest& request,
    Poco::Net::HTTPServerResponse& response) {
  response.setChunkedTransferEncoding(true);
  response.setContentType("application/json");
  response.set("Cache-Control", "no-store, no-cache, must-revalidate");
  response.set("Pragma", "no-cache");

  PartsHandler partsHandler;
  Poco::Net::HTMLForm form(request, request.stream(), partsHandler);

  std::string id = form.get("id", "");
  std::string srcPath = form.get("path", "");
  bool computeMD5 = ToBool(form.get("computeMD5", "false"));
  bool force = ToBool(form.get("force", "false"));

  std::ostream& out = response.send();
  try {
    if (id.empty() || srcPath.empty()) {
      out << R"({"success": false, "error": "Missing required parameters id and/or path."})";
      return;
    }

    bool result = apis_->cacheAPI_.Put(srcPath, id, force, computeMD5);

    out << R"({"success": )"<< (result ? "true" : "false") << R"(, "error": ""})";
  } catch (const std::exception& e) {
    response.setStatus(Poco::Net::HTTPResponse::HTTP_INTERNAL_SERVER_ERROR);
    out << R"({"success": false, "error": ")" << e.what() << R"("})";
  }
}

void ns_Server::RequestHandlerCacheGet::handleRequest(Poco::Net::HTTPServerRequest& request,
    Poco::Net::HTTPServerResponse& response) {
  response.setChunkedTransferEncoding(true);
  response.setContentType("application/json");
  response.set("Cache-Control", "no-store, no-cache, must-revalidate");
  response.set("Pragma", "no-cache");

  PartsHandler partsHandler;
  Poco::Net::HTMLForm form(request, request.stream(), partsHandler);

  std::string id = form.get("id", "");

  std::ostream& out = response.send();
  try {
    if (id.empty()) {
      out << R"({"success": false, "error": "Missing required parameters id."})";
      return;
    }

    std::filesystem::path path;
    std::string state = apis_->cacheAPI_.Get(id, path);

    out << R"({"success": true, "error": "", "state": ")" + state + R"(", "path": ")" + path.string() + R"(" })";
  } catch (const std::exception& e) {
    response.setStatus(Poco::Net::HTTPResponse::HTTP_INTERNAL_SERVER_ERROR);
    out << R"({"success": false, "error": ")" << e.what() << R"("})";
  }
}