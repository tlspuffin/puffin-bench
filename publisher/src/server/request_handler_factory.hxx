#pragma once

#include "config.hxx"
#include "request_handler.hxx"
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
  if (request.getURI() == "/task_new") {
    requestHandler = new RequestHandlerTaskNew;
  } else if (request.getURI() == "/cache_put") {
    requestHandler = new RequestHandlerCachePut;
  } else if (request.getURI() == "/cache_get") {
    requestHandler = new RequestHandlerCacheGet;
  }
  if (requestHandler != nullptr) {
    requestHandler->Configure(config_, apis_);
  }
  return requestHandler;
}

};