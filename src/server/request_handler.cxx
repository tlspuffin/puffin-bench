#include "request_handler.hxx"
#include "parts_handler.hxx"
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


    uint64_t taskID = apis_->scheduleAPI_.AddTask(flow->second.content, 
        functions->second.content, files);

    out << R"({"success": true, "task_id": ")" << taskID << R"("})";
  } catch (const std::exception& e) {
    out << R"({"success": false, "error": ")" << e.what() << R"("})";
  }
}

void ns_Server::RequestHandlerCachePut::handleRequest(Poco::Net::HTTPServerRequest& request,
    Poco::Net::HTTPServerResponse& response) {
  response.setChunkedTransferEncoding(true);
  response.setContentType("application/json");

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
    out << R"({"success": false, "error": ")" << e.what() << R"("})";
  }
}

void ns_Server::RequestHandlerCacheGet::handleRequest(Poco::Net::HTTPServerRequest& request,
    Poco::Net::HTTPServerResponse& response) {
  response.setChunkedTransferEncoding(true);
  response.setContentType("application/json");

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
    out << R"({"success": false, "error": ")" << e.what() << R"("})";
  }
}