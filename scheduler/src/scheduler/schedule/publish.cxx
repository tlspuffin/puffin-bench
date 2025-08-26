#include "publish.hxx"
#include "../utils/rapidjson.hxx"
#include <memory>
#include <iostream>
#include <Poco/URI.h>
#include <Poco/Net/HTTPClientSession.h>
#include <Poco/Net/HTTPSClientSession.h>
#include <Poco/Net/HTTPRequest.h>
#include <Poco/Net/HTTPResponse.h>

ns_Schedule::Publish::Publish() 
    : server_(), storage_(), checkServerCertificat_(false) {
}

ns_Schedule::Publish::Publish(rapidjson::Value const& config) 
    : Publish() {
  ReadJSON(config);
}

void ns_Schedule::Publish::ReadJSON(rapidjson::Value const& config) {
  if (!config.IsObject()) {
    throw std::runtime_error("publish config should be an object");
  }
  server_ = GetOrDefault<std::string>(config, "server", "");
  checkServerCertificat_ = 
      GetOrDefault<bool>(config, "check_server_certificat", false);
  storage_  = std::filesystem::weakly_canonical(
      GetOrDefault<std::string>(config, "storage_path", ""));
}

void ns_Schedule::Publish::ToJSON(rapidjson::Value& node, 
    rapidjson::Document::AllocatorType& alloc) const {
  node.AddMember("server", rapidjson::Value(server_.c_str(), alloc), alloc);
  node.AddMember("check_server_certificat", checkServerCertificat_, alloc);
  node.AddMember("storage_path", rapidjson::Value(storage_.c_str(), alloc), alloc);
}

void ns_Schedule::Publish::PublishResults(std::filesystem::path const& inLogs, 
    std::filesystem::path const& inArtefacts, 
    std::unordered_map<std::string, std::string> const& taskVariables) {
  if (storage_.empty()) {
    return;
  }

  std::filesystem::path finalStoragePath = ResolveVariables(storage_, taskVariables);
  if (!finalStoragePath.empty()) {
    if (!std::filesystem::create_directories(finalStoragePath)) {
      throw std::runtime_error(
          "Unable to create user save directory (" + finalStoragePath.string() + ")");
    }

    std::filesystem::copy_options copyOptions = 
        std::filesystem::copy_options::update_existing |
        std::filesystem::copy_options::recursive;
    std::filesystem::copy(inLogs, finalStoragePath / ".process_logs", copyOptions);
    std::filesystem::copy(inArtefacts, finalStoragePath, copyOptions);
  }

  if (server_.empty()) {
    return;
  }
  PublishToServer(finalStoragePath);
}

std::string ns_Schedule::Publish::ResolveVariables(
    std::string const& pattern, 
    std::unordered_map<std::string, std::string> const& taskVariables) {
  std::unordered_map<std::string, std::string> variables = taskVariables;
  std::string result = pattern;

  size_t pos = 0;
  while ((pos = result.find("${", pos)) != std::string::npos) {
    size_t end = result.find('}', pos);
    if (end == std::string::npos) {
      break;
    }
    std::string variableName = result.substr(pos + 2, end - pos - 2);
    auto const& it = variables.find(variableName);
    if (it != variables.end()) {
      result.replace(pos, end - pos + 1, it->second);
      pos += it->second.length();
    } else {
      pos = end + 1;
    }
  }

  return result;
}

void ns_Schedule::Publish::PublishToServer(std::filesystem::path const& archivePath) {
  try {
    Poco::URI uri(server_);
    std::unique_ptr<Poco::Net::HTTPClientSession> session;
    if (uri.getScheme() == "https") {
      Poco::Net::Context::Ptr context = new Poco::Net::Context(
          Poco::Net::Context::CLIENT_USE,
          "", "", "",
          checkServerCertificat_ ? Poco::Net::Context::VERIFY_STRICT : Poco::Net::Context::VERIFY_NONE);
      std::unique_ptr<Poco::Net::HTTPSClientSession> httpsSession = 
          std::make_unique<Poco::Net::HTTPSClientSession>(
              uri.getHost(), uri.getPort() != 0 ? uri.getPort() : 443, context);
      session = std::move(httpsSession);
    } else {
      session = std::make_unique<Poco::Net::HTTPClientSession>(
          uri.getHost(), uri.getPort() != 0 ? uri.getPort() : 80);
    }
    session->setTimeout(Poco::Timespan(30, 0));

    std::string path = uri.getPath().empty() ? "/" : uri.getPath();
    Poco::Net::HTTPRequest request(Poco::Net::HTTPRequest::HTTP_POST, path);

    std::string encodedPath;
    Poco::URI::encode(archivePath.string(), "", encodedPath);
    std::string formData = "path=" + encodedPath;

    request.setContentType("application/x-www-form-urlencoded");
    request.setContentLength(formData.length());
    std::ostream& requestStream = session->sendRequest(request);
    requestStream << formData;
    requestStream.flush();

    Poco::Net::HTTPResponse response;
    std::istream& responseStream = session->receiveResponse(response);

    if (response.getStatus() != Poco::Net::HTTPResponse::HTTP_OK) {
      std::string responseBody;
      Poco::StreamCopier::copyToString(responseStream, responseBody);
      throw std::runtime_error("Server returned status " + 
          std::to_string(response.getStatus()) + 
          ": " + responseBody);
    }
        
  } catch (const Poco::Exception& e) {
    throw std::runtime_error("HTTP[S] request failed: " + e.displayText());
  }
}
