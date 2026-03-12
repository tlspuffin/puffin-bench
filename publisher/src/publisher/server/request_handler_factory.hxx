#pragma once

#include "config.hxx"
#include "request_handler.hxx"
#include "../../utils/logs.hxx"
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

  RequestHandler* requestHandler = nullptr;
  std::string uri = request.getURI();
  std::string method = request.getMethod();
  LOGI("Got request " << method << " " << uri);
  if (method == Poco::Net::HTTPRequest::HTTP_POST) {
    if (uri == "/api/notify") {
      requestHandler = new RequestHandlerNotify;
    }
   } else if (method == Poco::Net::HTTPRequest::HTTP_GET) {
    if (uri.find("/api/download?") == 0 || (uri == "/api/download")) {
      requestHandler = new RequestHandlerDownload();
    } else if (uri.find("/files/") == 0) {
      requestHandler = new RequestHandlerFiles("/files", apis_.publishAPI_.Storage());
    } else if (uri.find("/html/") == 0) {
      requestHandler = new RequestHandlerFiles("/html", apis_.publishAPI_.HTMLStorage());
    }
  }
  if (requestHandler != nullptr) {
    requestHandler->Configure(config_, apis_);
  } else {
    requestHandler = new RequestHandlerError;
  }
  return requestHandler;
}

};