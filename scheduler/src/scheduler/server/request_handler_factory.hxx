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

  static auto regexTaskOutputs = 
      std::regex(R"(/api/task/(\d+)/(\d+)/(\d+-\d+-\d+)/output/(stdout|stderr|[0-9]+)/(\d+)/(-?\d+))");
  static auto regexTaskGetArtefacts = std::regex(R"(/api/task/(\d+)/artefacts$)");
  static auto regexTaskGetFinalState = std::regex(R"(/api/task/(\d+)/final_state$)");
  static auto regexTaskGetState = std::regex(R"(/api/task/(\d+)/state$)");
  static auto regexTaskCancel = std::regex(R"(/api/task/(\d+))");
  static auto regexTaskCancelStep = std::regex(R"(/api/task/(\d+)/step/(\d+))");
  static auto regexTaskUpdatePriority = std::regex(R"(/api/task/(\d+)/(-?\d+))");
  static auto regexUsersList = std::regex(R"(/api/users$)");
  static auto regexUserJobsTypeList = std::regex(R"(/api/user/([a-zA-Z0-9_-]+)/job_types$)");
  static auto regexUserTasksList = std::regex(R"(/api/user/([a-zA-Z0-9_-]+)/([a-zA-Z0-9_-]+)/tasks$)");
  static auto regexCacheGet = std::regex(R"(/api/cache/([a-zA-Z0-9_-]+))");
  static auto regexCachePut = std::regex(R"(/api/cache/([a-zA-Z0-9_-]+))");

  try {
    if (method == "GET") {
      std::smatch matches;
      if (std::regex_match(uri, matches, regexTaskOutputs)) {
        requestHandler = new RequestHandlerTaskOutputs(matches[1].str(), 
            std::stoull(matches[2].str()), matches[3].str(), matches[4].str(), 
            std::stoll(matches[5].str()), std::stoll(matches[6].str()));
      } else if (std::regex_match(uri, matches, regexTaskGetArtefacts)) {
        requestHandler = new RequestHandlerTaskGetArtefacts(matches[1].str());
      } else if (std::regex_match(uri, matches, regexTaskGetFinalState)) {
        requestHandler = new RequestHandlerTaskGetState(true, matches[1].str());
      } else if (std::regex_match(uri, matches, regexTaskGetState)) {
        requestHandler = new RequestHandlerTaskGetState(false, matches[1].str());
      } else if (uri == "/api/tasks/running") {
        requestHandler = new RequestHandlerTasksRunning;
      } else if (std::regex_match(uri, matches, regexCacheGet)) {
        requestHandler = new RequestHandlerCacheGet(matches[1].str());
      } else if (std::regex_match(uri, matches, regexUsersList)) {
        requestHandler = new RequestHandlerUsersList();
      } else if (std::regex_match(uri, matches, regexUserJobsTypeList)) {
        requestHandler = new RequestHandlerUserJobsTypeList(matches[1].str());
      } else if (std::regex_match(uri, matches, regexUserTasksList)) {
        requestHandler = new RequestHandlerUserTasksList(matches[1].str(), matches[2].str());
      } else if (uri.find("/files/") == 0) {
        requestHandler = new RequestHandlerFiles("/files");
      }
    } else if (method == "POST") {
      if (uri == "/api/task/new") {
        requestHandler = new RequestHandlerTaskNew;
      }
    } else if (method == "PUT") {
      std::smatch matches;
      if (std::regex_match(uri, matches, regexCachePut)) {
        requestHandler = new RequestHandlerCachePut(matches[1].str());
      }
    } else if (method == "PATCH") {
      std::smatch matches;
      if (std::regex_match(uri, matches, regexTaskUpdatePriority)) {
        requestHandler = new RequestHandlerTaskUpdatePriority(matches[1].str(), matches[2].str());
      }
    } else if (method == "DELETE") {
      std::smatch matches;
      if (std::regex_match(uri, matches, regexTaskCancel)) {
        requestHandler = new RequestHandlerTaskCancel(
            std::stoul(matches[1].str()));
      } else if (std::regex_match(uri, matches, regexTaskCancelStep)) {
        requestHandler = new RequestHandlerTaskCancelStep(
            std::stoul(matches[1].str()), std::stoul(matches[2].str()));
      }
    }

    if (requestHandler != nullptr) {
      requestHandler->Configure(config_, apis_);
    }
  } catch(std::exception const& e) {
    LOGE << e.what() << Log::Flags::End;
  }

  if (requestHandler == nullptr) {
    requestHandler = new RequestHandlerError;
  }
  return requestHandler;
}

};
