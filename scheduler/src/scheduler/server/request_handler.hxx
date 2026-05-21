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

  static bool ManageCORS(Poco::Net::HTTPServerRequest& request,
    Poco::Net::HTTPServerResponse& response);
  static bool SendFile(std::filesystem::path const& filename,
    Poco::Net::HTTPServerResponse& response, std::ostream*& responseStream);

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
REQUESTHANDLER(TaskNew);
REQUESTHANDLER(TasksRunning);
REQUESTHANDLER(TaskOutputs, std::string const, uint64_t, 
    std::string const, std::string const, size_t , ssize_t);
REQUESTHANDLER(TaskCancel, uint64_t);
REQUESTHANDLER(TaskCancelStep, uint64_t, uint64_t);
REQUESTHANDLER(TaskGetArtefacts, std::string const);
REQUESTHANDLER(TaskGetFinalState, std::string const);
REQUESTHANDLER(UsersList);
REQUESTHANDLER(UserJobsTypeList, std::string const);
REQUESTHANDLER(UserTasksList, std::string const, std::string const);
REQUESTHANDLER(CachePut, std::string const);
REQUESTHANDLER(CacheGet, std::string const);
REQUESTHANDLER(Files, std::string const);

};
