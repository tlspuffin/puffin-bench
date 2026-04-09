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
      if (std::regex_match(uri, matches, std::regex(
          R"(/api/task/output/(\d+)/(\d+)/(\d+-\d+-\d+)/(stdout|stderr)/(\d+)/(-?\d+))"))) {
        requestHandler = new RequestHandlerTaskOutputs(matches[1].str(), 
            std::stoull(matches[2].str()), matches[3].str(), matches[4].str(), 
            std::stoull(matches[5].str()), std::stoll(matches[6].str()));
      } else if (uri == "/api/tasks/running") {
        requestHandler = new RequestHandlerTasksRunning;
      } else if (std::regex_match(uri, matches, std::regex(R"(/api/cache/([a-zA-Z0-9_-]+))"))) {
        requestHandler = new RequestHandlerCacheGet(matches[1].str());
      } else if (std::regex_match(uri, matches, std::regex(R"(/api/users$)"))) {
        requestHandler = new RequestHandlerUsersList();
      } else if (std::regex_match(uri, matches, std::regex(R"(/api/user/([a-zA-Z0-9_-]+)/job_types$)"))) {
        requestHandler = new RequestHandlerUserJobsTypeList(matches[1].str());
      } else if (std::regex_match(uri, matches, std::regex(R"(/api/user/([a-zA-Z0-9_-]+)/([a-zA-Z0-9_-]+)/tasks$)"))) {
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
      if (std::regex_match(uri, matches, std::regex(R"(/api/cache/([a-zA-Z0-9_-]+))"))) {
        requestHandler = new RequestHandlerCachePut(matches[1].str());
      }
    } else if (method == "DELETE") {
      std::smatch matches;
      if (std::regex_match(uri, matches, std::regex(R"(/api/task/(\d+))"))) {
        requestHandler = new RequestHandlerTaskCancel(
            std::stoul(matches[1].str()));
      } else if (std::regex_match(uri, matches, std::regex(R"(/api/task/(\d+)/step/(\d+))"))) {
        requestHandler = new RequestHandlerTaskCancelStep(
            std::stoul(matches[1].str()), std::stoul(matches[2].str()));
      }
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
