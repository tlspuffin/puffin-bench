#pragma once

#include "config.hxx"
#include "../api/api.hxx"
#include <Poco/Net/HTMLForm.h>
#include <Poco/Net/HTTPRequestHandler.h>
#include <Poco/Net/HTTPServerResponse.h>

#define REQUESTHANDLER(name) \
class RequestHandler ## name : public RequestHandler {\
public:\
  void handleRequest(Poco::Net::HTTPServerRequest& request,\
      Poco::Net::HTTPServerResponse& response);\
}


namespace ns_Server {

class RequestHandler : public Poco::Net::HTTPRequestHandler {

public:
  void Configure(ns_Server::Config const& config, 
      ns_API::APIS& apis);

protected:
  ns_Server::Config const* config_;
  ns_API::APIS* apis_;
};

inline void RequestHandler::Configure(ns_Server::Config const& config, 
    ns_API::APIS& apis) {
  config_ = &config;
  apis_ = &apis;
}

REQUESTHANDLER(Notify);
REQUESTHANDLER(Files);

};
