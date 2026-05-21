#include "request_handler.hxx"
#include "parts_handler.hxx"
#include "../../utils/rapidjson.hxx"
#include <fstream>
#include <mutex>
#include <regex>
#include <Poco/JSON/Object.h>
#include <Poco/JSON/Stringifier.h>
#include <Poco/Net/HTTPServerRequest.h>
#include <Poco/Base64Encoder.h>
#include <Poco/StreamCopier.h>
#include <Poco/URI.h>
#include <rapidjson/document.h>
#include <rapidjson/stringbuffer.h>
#include <rapidjson/writer.h>

static std::regex hexValue("[0-9a-fA-F]+");

inline static bool ToBool(std::string const& v) {
  return v == "1" || v == "true" || v == "on" || v == "yes";
};

static std::string ErrorJSON(std::string const& msg) {
  rapidjson::Document doc;
  doc.SetObject();
  doc.AddMember("success", false, doc.GetAllocator());
  doc.AddMember("error",
      rapidjson::Value(msg.c_str(), doc.GetAllocator()),
      doc.GetAllocator());
  rapidjson::StringBuffer sb;
  rapidjson::Writer<rapidjson::StringBuffer> writer(sb);
  doc.Accept(writer);
  return sb.GetString();
}

static bool ManageCORS(Poco::Net::HTTPServerRequest& request,
    Poco::Net::HTTPServerResponse& response) {
  response.set("Access-Control-Allow-Origin", "*");
  response.set("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS");
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

void ns_Server::RequestHandlerCORSOptions::handleRequest(Poco::Net::HTTPServerRequest& request,
    Poco::Net::HTTPServerResponse& response) {
  ManageCORS(request, response);
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

  std::string const repo = std::get<0>(args_);
  std::string const& url = std::get<1>(args_);

  Poco::URI uri(url);
  ns_GIT::GitAPI::ERefresh refresh = ns_GIT::GitAPI::ERefresh::None;
  for (auto& param : uri.getQueryParameters()) {
    if (param.first == "refresh") {
      if (param.second == "local") {
        refresh = ns_GIT::GitAPI::ERefresh::Local;
      } else if (param.second == "all") {
        refresh = ns_GIT::GitAPI::ERefresh::All;
      }
    } else {
      response.setStatus(Poco::Net::HTTPResponse::HTTP_BAD_REQUEST);
      std::ostream& out = response.send();
      out << R"({"success": false, "error": "Invalid parameters"})";
      out.flush();
      return;
    }
  }

  if (apis_->gitAPI_.find(repo) == apis_->gitAPI_.end()) {
    response.setStatus(Poco::Net::HTTPResponse::HTTP_NOT_FOUND);
    std::ostream& out = response.send();
    out << ErrorJSON("Unknown repository " + repo);
    out.flush();
    return;
  }

  std::string buffer;
  if (!apis_->gitAPI_.at(repo).History(buffer, refresh)) {
    response.setStatus(Poco::Net::HTTPResponse::HTTP_INTERNAL_SERVER_ERROR);
    std::ostream& out = response.send();
    out << ErrorJSON(buffer);
    out.flush();
    return;
  }
  std::ostream& out = response.send();
  out << buffer;
  out.flush();
  return;
}

void ns_Server::RequestHandlerLog::handleRequest(Poco::Net::HTTPServerRequest& request,
    Poco::Net::HTTPServerResponse& response) {
  if (ManageCORS(request, response)) {
    return;
  }

  std::string const repo = std::get<0>(args_);
  std::string const& commitid = std::get<1>(args_);

  response.setChunkedTransferEncoding(true);
  response.setContentType("application/json; charset=utf-8");

  if (apis_->gitAPI_.find(repo) == apis_->gitAPI_.end()) {
    response.setStatus(Poco::Net::HTTPResponse::HTTP_NOT_FOUND);
    std::ostream& out = response.send();
    out << ErrorJSON("Unknown repository " + repo);
    out.flush();
    return;
  }

  std::string buffer;
  if (!apis_->gitAPI_.at(repo).Logs({commitid}, buffer)) {
    response.setStatus(Poco::Net::HTTPResponse::HTTP_INTERNAL_SERVER_ERROR);
    std::ostream& out = response.send();
    out << ErrorJSON("Git error " + repo +": " + buffer);
    out.flush();
    return;
  }
  std::ostream& out = response.send();
  out << buffer;
  out.flush();
}

void ns_Server::RequestHandlerLogs::handleRequest(Poco::Net::HTTPServerRequest& request,
    Poco::Net::HTTPServerResponse& response) {
  if (ManageCORS(request, response)) {
    return;
  }

  std::string const repo = std::get<0>(args_);

  std::string body;
  Poco::StreamCopier::copyToString(request.stream(), body);
  rapidjson::Document doc;
  doc.Parse(body.c_str());
  if (doc.HasParseError() || (!doc.HasMember("commits")) || (!doc["commits"].IsArray())) {
    response.setStatus(Poco::Net::HTTPResponse::HTTP_BAD_REQUEST);
    std::ostream& out = response.send();
    out << R"({"success": false, "error": "Problem with JSON"})";
    out.flush();
    return;
  }

  std::vector<std::string> commitIDs;
  auto const& commitsList = doc["commits"].GetArray();
  for(int i=0; i<commitsList.Size(); ++i) {
    if (!commitsList[i].IsString()) {
      response.setStatus(Poco::Net::HTTPResponse::HTTP_BAD_REQUEST);
      std::ostream& out = response.send();
      out << R"({"success": false, "error": "No commit(s) specified"})";
      out.flush();
      return;
    }
    std::string commitID = commitsList[i].GetString();
    if (!std::regex_match(commitID, hexValue)) {
      response.setStatus(Poco::Net::HTTPResponse::HTTP_BAD_REQUEST);
      std::ostream& out = response.send();
      out << R"({"success": false, "error": "Corrupted commit(s) provided"})";
      out.flush();
      return;
    }
    commitIDs.push_back(commitID);
  }

  response.setChunkedTransferEncoding(true);
  response.setContentType("application/json; charset=utf-8");

  if (apis_->gitAPI_.find(repo) == apis_->gitAPI_.end()) {
    response.setStatus(Poco::Net::HTTPResponse::HTTP_NOT_FOUND);
    std::ostream& out = response.send();
    out << ErrorJSON("Unknown repository " + repo);
    out.flush();
    return;
  }

  std::string buffer;
  if (!apis_->gitAPI_.at(repo).Logs(commitIDs, buffer)) {
    response.setStatus(Poco::Net::HTTPResponse::HTTP_INTERNAL_SERVER_ERROR);
    std::ostream& out = response.send();
    out << ErrorJSON("Git error " + repo +": " + buffer);
    out.flush();
    return;
  }
  std::ostream& out = response.send();
  out << buffer;
  out.flush();
}
