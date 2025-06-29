#pragma once

#include "config.hxx"
#include "request_handler.hxx"
#include <Poco/Net/HTTPRequestHandlerFactory.h>
#include <Poco/Net/HTTPServerRequest.h>

namespace ns_Server {

class RequestHandlerFactory : public Poco::Net::HTTPRequestHandlerFactory {
public:
  RequestHandlerFactory(ns_Server::Config const& config, 
      ns_API::ScheduleAPI& scheduleAPI);
  Poco::Net::HTTPRequestHandler* createRequestHandler(
      const Poco::Net::HTTPServerRequest&);
private:
  ns_Server::Config const& config_;
  ns_API::ScheduleAPI& scheduleAPI_;
};

RequestHandlerFactory::RequestHandlerFactory(ns_Server::Config const& config, 
    ns_API::ScheduleAPI& scheduleAPI)
    : config_(config), scheduleAPI_(scheduleAPI)
{
}

Poco::Net::HTTPRequestHandler* RequestHandlerFactory::createRequestHandler(
    const Poco::Net::HTTPServerRequest& request) {

  RequestHandler* requestHandler = nullptr;
  if (request.getURI() == "/task_new") {
    requestHandler = new RequestHandlerTaskNew;
  }
  if (requestHandler != nullptr) {
    requestHandler->Configure(config_, scheduleAPI_);
  }
  return requestHandler;
}

};