#include "request_handler.hxx"
#include "parts_handler.hxx"
#include <fstream>
#include <Poco/JSON/Object.h>
#include <Poco/JSON/Stringifier.h>
#include <Poco/Net/HTTPServerRequest.h>
#include <Poco/Base64Encoder.h>
#include <Poco/StreamCopier.h>
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

void ns_Server::RequestHandlerError::handleRequest(Poco::Net::HTTPServerRequest& request,
    Poco::Net::HTTPServerResponse& response) {
  response.setStatus(Poco::Net::HTTPResponse::HTTP_NOT_FOUND);
  response.setContentType("text/plain");
  response.send() << "404 - Path not found: " << request.getURI();
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

  response.setChunkedTransferEncoding(true);

  //std::string const& prefix = std::get<0>(args_);
  std::string const& prefix = "/files";

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

    std::filesystem::path rootPath = apis_->publishAPI_.Storage();

    std::filesystem::path filename = rootPath / path;
    try {
      filename = std::filesystem::canonical(filename);
    } catch(...) {
      //detectHostileIP_.SetHostileIP(srcIP);
      response.setStatusAndReason(Poco::Net::HTTPResponse::HTTP_NOT_FOUND);
      response.send();
      return;
    }

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
            {".html", {"text/html", std::ios_base::in}}, 
            {".css", {"text/css", std::ios_base::in}},
            {".json", {"application/json", std::ios_base::in}},
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
