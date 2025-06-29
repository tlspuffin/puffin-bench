#include "request_handler.hxx"
#include "parts_handler.hxx"
#include <Poco/JSON/Object.h>
#include <Poco/JSON/Stringifier.h>
#include <Poco/Net/HTTPServerRequest.h>

void ns_Server::RequestHandlerTaskNew::handleRequest(Poco::Net::HTTPServerRequest& request,
    Poco::Net::HTTPServerResponse& response) {
  response.setChunkedTransferEncoding(true);
  response.setContentType("application/json");

  PartsHandler partsHandler;
  Poco::Net::HTMLForm form(request, request.stream(), partsHandler);
  //std::string name = form.get("name", "UnnamedTask");
  std::unordered_map<std::string, ns_Server::PartsHandler::PartData> const& parts = partsHandler.GetParts();

  std::ostream& out = response.send();
  try {
    auto flow = parts.find("config");
    auto functions = parts.find("script");

    if ((flow == parts.end()) || (functions == parts.end())) {
      out << R"({"success": false, "error": "Missing config or script file."})";
      return;
    }

    uint64_t taskID = scheduleAPI_->AddTask(flow->second.content, functions->second.content);

    out << R"({"success": true, "task_id": ")" << taskID << R"("})";
  } catch (const std::exception& ex) {
    out << R"({"success": false, "error": ")" << ex.what() << R"("})";
  }
}