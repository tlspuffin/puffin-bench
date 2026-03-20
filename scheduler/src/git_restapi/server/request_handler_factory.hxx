#pragma once

#include "config.hxx"
#include "request_handler.hxx"
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

  try {
    if (method == "GET") {
      std::smatch matches;
      if (std::regex_match(uri, matches, std::regex(R"(/api/git/history(\?.*)?)"))) {
        requestHandler = new RequestHandlerHistory(uri);
      }
    } else if (method == "POST") {
    } else if (method == "PUT") {
    } else if (method == "DELETE") {
    }

    if (requestHandler != nullptr) {
      requestHandler->Configure(config_, apis_);
    }
  } catch(std::runtime_error const& e) {
    std::cerr << e.what() << std::endl;
  }

  if (requestHandler == nullptr) {
    requestHandler = new RequestHandlerError;
  }
  return requestHandler;
}

};
