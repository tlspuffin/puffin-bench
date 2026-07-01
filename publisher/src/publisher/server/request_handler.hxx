#pragma once

#include "config.hxx"
#include "../api/api.hxx"
#include <Poco/Net/HTMLForm.h>
#include <Poco/Net/HTTPRequestHandler.h>
#include <Poco/Net/HTTPServerResponse.h>

#define REQUESTHANDLER(name, ...) \
class RequestHandler ## name : public RequestHandler {\
public:\
  template<typename... Args>\
  RequestHandler ## name(Args... args) : args_(std::make_tuple(args...)) {}\
  void handleRequest(Poco::Net::HTTPServerRequest& request,\
      Poco::Net::HTTPServerResponse& response);\
private:\
  std::tuple<__VA_ARGS__> args_;\
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

REQUESTHANDLER(Error);
REQUESTHANDLER(CORSOptions);
REQUESTHANDLER(Notify);
REQUESTHANDLER(ProjectListData, std::string const);
REQUESTHANDLER(ProjectListCampaigns, std::string const);
REQUESTHANDLER(ProjectRegenerateCache, std::string const, std::string const);
REQUESTHANDLER(ProjectDeleteData, std::string const, std::string const);
REQUESTHANDLER(Files, std::string const, std::string const);

};
