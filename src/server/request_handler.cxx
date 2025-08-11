#include "request_handler.hxx"
#include "parts_handler.hxx"
#include <fstream>
#include <Poco/JSON/Object.h>
#include <Poco/JSON/Stringifier.h>
#include <Poco/Net/HTTPServerRequest.h>
#include <Poco/Base64Encoder.h>

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
      out.flush();
      return;
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

    uint64_t taskID = apis_->scheduleAPI_.AddTask(flow->second.content, 
        functions->second.content, files, args);

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
  out.flush();
}

void ns_Server::RequestHandlerTaskOutputs::handleRequest(Poco::Net::HTTPServerRequest& request,
    Poco::Net::HTTPServerResponse& response) {
  if (ManageCORS(request, response)) {
    return;
  }

  response.setChunkedTransferEncoding(true);
  response.setContentType("application/json");
  response.set("Cache-Control", "no-store, no-cache, must-revalidate");
  response.set("Pragma", "no-cache");

  std::ostream& out = response.send();

  Poco::Net::HTMLForm form(request, request.stream());
  std::string type = form.get("type", "");
  std::string taskid = form.get("task_id", "");
  std::string stepid = form.get("step_id", "");
  std::string rankid = form.get("rank_id", "");
  std::string attemptid = form.get("attempt_id", "");
  std::string readoffsetStr = form.get("read_offset", "");
  std::string readsizeStr = form.get("read_size", "");
  std::string executor = form.get("executor", "");

  if ((type.empty()) || (taskid.empty()) || (stepid.empty()) || 
      (rankid.empty()) || (attemptid.empty()) || (readoffsetStr.empty()) ||
      (readsizeStr.empty()) || (executor.empty())) {
    out << R"({"success": false, "error": "Missing required parameter(s)."})";
    out.flush();
    return;
  }

  try {
    ssize_t readoffset = std::stoll(readoffsetStr);
    size_t readsize = std::stoull(readsizeStr);
    int state = 0;
    std::string output = apis_->scheduleAPI_.GetOutput(
        executor, type, taskid, stepid, rankid, attemptid, readsize, readoffset, state);
    if (state == 0) {
      throw std::runtime_error("Server can't read requested output");
    }

    std::ostringstream oss;
    Poco::Base64Encoder encoder(oss);
    encoder.rdbuf()->setLineLength(0);
    encoder << output;
    encoder.close();

    out << R"({"success": true, "data": ")" << oss.str() << R"(", "state": )" << state << "}";
  } catch(std::runtime_error const& e) {
    response.setStatus(Poco::Net::HTTPResponse::HTTP_INTERNAL_SERVER_ERROR);
    out << R"({"success": false, "error": ")" << e.what() << R"("})";
  }
  out.flush();
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
  out.flush();
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
      out.flush();
      return;
    }

    std::filesystem::path path;
    std::string state = apis_->cacheAPI_.Get(id, path);

    out << R"({"success": true, "error": "", "state": ")" + state + R"(", "path": ")" + path.string() + R"(" })";
  } catch (const std::exception& e) {
    response.setStatus(Poco::Net::HTTPResponse::HTTP_INTERNAL_SERVER_ERROR);
    out << R"({"success": false, "error": ")" << e.what() << R"("})";
  }
  out.flush();
}