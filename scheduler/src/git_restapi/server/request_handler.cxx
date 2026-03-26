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

static std::regex hexValue("[0-9a-fA-F]+");

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

  std::string const repo = std::get<0>(args_);
  std::string const& url = std::get<1>(args_);

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

  if (apis_->gitAPI_.find(repo) == apis_->gitAPI_.end()) {
    response.setStatus(Poco::Net::HTTPResponse::HTTP_BAD_REQUEST);
    std::ostream& out = response.send();
    out << R"({"success": false, "error": "Unknown repository )" << repo << R"("})";
    out.flush();
    return;
  }

  static std::mutex lock;
  static std::chrono::steady_clock::time_point lastUpdate{};
  static std::string cachedResult;

  lock.lock();
  auto now = std::chrono::steady_clock::now();
  if (cachedResult.empty() || (now - lastUpdate) > std::chrono::minutes(1)) {
    std::string buffer;
    if (!apis_->gitAPI_.at(repo).History(buffer)) {
      lock.unlock();
      response.setStatus(Poco::Net::HTTPResponse::HTTP_INTERNAL_SERVER_ERROR);
      std::ostream& out = response.send();
      out << R"({"success": false, "error": ")" + buffer + "})";
      out.flush();
      return;
    }
    cachedResult = buffer;
    lastUpdate = now;
  }
  std::ostream& out = response.send();
  out << cachedResult;
  lock.unlock();
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
    response.setStatus(Poco::Net::HTTPResponse::HTTP_BAD_REQUEST);
    std::ostream& out = response.send();
    out << R"({"success": false, "error": "Invalid parameters"})";
    out.flush();
    return;
  }

  std::string buffer;
  if (!apis_->gitAPI_.at(repo).Logs({commitid}, buffer)) {
    response.setStatus(Poco::Net::HTTPResponse::HTTP_INTERNAL_SERVER_ERROR);
    std::ostream& out = response.send();
    out << R"({"success": false, "error": "Unknown repository )" << repo << R"("})";
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
    response.setStatus(Poco::Net::HTTPResponse::HTTP_BAD_REQUEST);
    std::ostream& out = response.send();
    out << R"({"success": false, "error": "Unknown repository )" << repo << R"("})";
    out.flush();
    return;
  }

  std::string buffer;
  if (!apis_->gitAPI_.at(repo).Logs(commitIDs, buffer)) {
    response.setStatus(Poco::Net::HTTPResponse::HTTP_INTERNAL_SERVER_ERROR);
    std::ostream& out = response.send();
    out << R"({"success": false, "error": ")" << buffer << R"("})";
    out.flush();
    return;
  }
  std::ostream& out = response.send();
  out << buffer;
  out.flush();
}
