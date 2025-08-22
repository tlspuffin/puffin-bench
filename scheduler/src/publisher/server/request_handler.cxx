#include "request_handler.hxx"
#include "parts_handler.hxx"
#include <fstream>
#include <Poco/JSON/Object.h>
#include <Poco/JSON/Stringifier.h>
#include <Poco/Net/HTTPServerRequest.h>
#include <Poco/Base64Encoder.h>
#include <Poco/URI.h>

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

void ns_Server::RequestHandlerNotify::handleRequest(Poco::Net::HTTPServerRequest& request,
    Poco::Net::HTTPServerResponse& response) {
  response.setChunkedTransferEncoding(true);
  response.setContentType("application/json");
  response.set("Cache-Control", "no-store, no-cache, must-revalidate");
  response.set("Pragma", "no-cache");

  PartsHandler partsHandler;
  Poco::Net::HTMLForm form(request, request.stream(), partsHandler);
  std::unordered_multimap<std::string, ns_Server::PartsHandler::PartData> const& parts = 
      partsHandler.GetParts();

  std::ostream& out = response.send();
  try {
    std::string error;
    if (!apis_->publishAPI_.Notify(form.get("path", ""), error)) {
      throw std::runtime_error(error);
    }
    out << R"({"success": true})";
  } catch (const std::exception& e) {
    response.setStatus(Poco::Net::HTTPResponse::HTTP_INTERNAL_SERVER_ERROR);
    out << R"({"success": false, "error": ")" << e.what() << R"("})";
  }
  out.flush();
}

void ns_Server::RequestHandlerFiles::handleRequest(Poco::Net::HTTPServerRequest& request,
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
    //apis_->publisherAPI_.Files(....);
    out << R"({"success": true})";
  } catch(std::runtime_error const& e) {
    response.setStatus(Poco::Net::HTTPResponse::HTTP_INTERNAL_SERVER_ERROR);
    out << R"({"success": false})";
  }
  out.flush();
}
