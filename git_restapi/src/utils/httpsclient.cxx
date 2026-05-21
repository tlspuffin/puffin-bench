#include "httpsclient.hxx"

#include <iostream>
#include <sstream>

#include <Poco/URI.h>
#include <Poco/StreamCopier.h>
#include <Poco/Net/HTTPClientSession.h>
#include <Poco/Net/HTTPSClientSession.h>
#include <Poco/Net/HTTPRequest.h>
#include <Poco/Net/HTTPResponse.h>
#include <Poco/Net/SSLManager.h>
#include <Poco/Net/Context.h>
#include <Poco/Net/AcceptCertificateHandler.h>

static Poco::Net::Context::Ptr context = new Poco::Net::Context(
    Poco::Net::Context::CLIENT_USE, "", "", "", 
    Poco::Net::Context::VERIFY_RELAXED, 9, true); 

HTTPSClient::HTTPSClient() : session_(nullptr)
{
}

HTTPSClient::~HTTPSClient() {
  Close();
}

bool HTTPSClient::Remote(std::string const& site) {
  try {
    Close();
    Poco::URI uri("https://"+site);
    session_ = new Poco::Net::HTTPSClientSession(uri.getHost(), uri.getPort(), context);   
  } catch(Poco::Exception const& e) {
    return false;
  }
  return true;
}


bool HTTPSClient::Close() {
  if (session_ != nullptr) {
    delete session_;
    session_ = nullptr;
  }
  return true;
}

bool HTTPSClient::Get(std::string const& path, std::string& result, 
    std::unordered_map<std::string, std::string>& headers) {
  if (path.empty()) {
    throw std::runtime_error("Error in HTTPSClient::Get, path should ne be empty");
  }
  if (session_ == nullptr) {
    return false;
  }

  try {
    Poco::Net::HTTPRequest request(Poco::Net::HTTPRequest::HTTP_GET, path, 
        Poco::Net::HTTPMessage::HTTP_1_1);
    request.set("User-Agent", "Poco-Cpp-Client");
    request.set("Accept", "application/vnd.github+json");
    session_->sendRequest(request);
    Poco::Net::HTTPResponse response;
    std::istream& rs = session_->receiveResponse(response);
    //std::cout << "Status: " << response.getStatus() << " " << response.getReason() << std::endl;
    std::ostringstream body;
    Poco::StreamCopier::copyStream(rs, body);
    result = body.str();
    for (auto& [name, value]: headers) {
      value = response.get(name, "");
    }
  } catch(Poco::Exception const& e) {
    return false;
  }
  return true;
}
