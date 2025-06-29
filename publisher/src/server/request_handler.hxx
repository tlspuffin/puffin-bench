#pragma once

#include "config.hxx"
#include "../api/schedule_api.hxx"
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
      ns_API::ScheduleAPI& scheduleAPI);

protected:
  ns_Server::Config const* config_;
  ns_API::ScheduleAPI* scheduleAPI_;

  /*static std::string ns_Server::RequestHandler::readPartToString(
      Poco::Net::HTMLForm& form, const std::string& field);
  static std::vector<uint8_t> ns_Server::RequestHandler::readPartToBytes(
      Poco::Net::HTMLForm& form, const std::string& field);*/
};

inline void RequestHandler::Configure(ns_Server::Config const& config, 
    ns_API::ScheduleAPI& scheduleAPI) {
  config_ = &config;
  scheduleAPI_ = &scheduleAPI;
}

REQUESTHANDLER(TaskNew);

};
