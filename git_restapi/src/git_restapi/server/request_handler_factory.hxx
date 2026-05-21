#pragma once

#include "config.hxx"
#include "request_handler.hxx"
#include "../../utils/logs.hxx"
#include <iostream>
#include <regex>
#include <Poco/Net/HTTPRequestHandlerFactory.h>
#include <Poco/Net/HTTPServerRequest.h>

namespace ns_Server {

class RequestHandlerFactory : public Poco::Net::HTTPRequestHandlerFactory {
public:
  RequestHandlerFactory(ns_Server::Config const& config, 
      ns_API::APIS& apis);
  Poco::Net::HTTPRequestHandler* createRequestHandler(
      const Poco::Net::HTTPServerRequest&);
private:
  ns_Server::Config const& config_;
  ns_API::APIS& apis_;
};

RequestHandlerFactory::RequestHandlerFactory(ns_Server::Config const& config, 
    ns_API::APIS& apis)
    : config_(config), apis_(apis)
{
}

Poco::Net::HTTPRequestHandler* RequestHandlerFactory::createRequestHandler(
    const Poco::Net::HTTPServerRequest& request) {

  std::string uri = request.getURI();
  std::string method = request.getMethod();

  RequestHandler* requestHandler = nullptr;
  static std::regex historyURI = std::regex(R"(^/api/git/history/([0-9a-zA-Z-_.%]+)(\?.*)?$)");
  static std::regex logURI = std::regex(R"(^/api/git/log/([0-9a-zA-Z-_.%]+)\?commit=([0-9a-fA-F]+)$)");
  static std::regex logsURI = std::regex(R"(^/api/git/logs/([0-9a-zA-Z-_.%]+)$)");

  try {
    if (method == Poco::Net::HTTPRequest::HTTP_OPTIONS) {
      requestHandler = new RequestHandlerCORSOptions();
    } else if (method == Poco::Net::HTTPRequest::HTTP_GET) {
      std::smatch matches;
      if (std::regex_match(uri, matches, historyURI)) {
        requestHandler = new RequestHandlerHistory(matches[1].str(), uri);
      } else if (std::regex_match(uri, matches, logURI)) {
        requestHandler = new RequestHandlerLog(matches[1].str(), matches[2].str());
      }
    } else if (method == Poco::Net::HTTPRequest::HTTP_POST) {
      std::smatch matches;
      if (std::regex_match(uri, matches, logsURI)) {
        requestHandler = new RequestHandlerLogs(matches[1].str());
      }
    } else if (method == Poco::Net::HTTPRequest::HTTP_PATCH) {
    } else if (method == Poco::Net::HTTPRequest::HTTP_PUT) {
    } else if (method == Poco::Net::HTTPRequest::HTTP_DELETE) {
    }

    if (requestHandler != nullptr) {
      requestHandler->Configure(config_, apis_);
    }
  } catch(std::runtime_error const& e) {
    LOGE << e.what() << Log::Flags::End;
  }

  if (requestHandler == nullptr) {
    requestHandler = new RequestHandlerError;
  }
  return requestHandler;
}

};
