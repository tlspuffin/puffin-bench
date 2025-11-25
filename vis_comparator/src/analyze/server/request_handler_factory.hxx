#pragma once

#include "config.hxx"
#include "request_handler.hxx"
#include <iostream>
#include <regex>
#include <Poco/Net/HTTPRequestHandlerFactory.h>
#include <Poco/Net/HTTPServerRequest.h>
#include <Poco/URI.h>

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

  Poco::URI uri(request.getURI());
  std::string path = uri.getPath();
  std::string method = request.getMethod();

  RequestHandler* requestHandler = nullptr;

  static const std::regex regListCommits("^/api/PR/commits/([^/]+)$");
  static const std::regex regGetCommitSubjects("^/api/PR/subjects/([^/]+)/([^/]+)$");
  static const std::regex regGetCommitMetrics("^/api/PR/metrics/([^/]+)/([^/]+)/([^/]+)$");
  static const std::regex regGetCommitMetricsValues(
      "^/api/PR/values/([^/]+)/([^/]+)/([^/]+)/([0-9]+)/([0-9]+)/([0-9]+)$");

  std::smatch match;

  try {
    if (path.find("/api/") == 0) {
      if (method == "GET") {
        if (std::regex_search(path, match, regListCommits)) {
          requestHandler = new RequestHandlerAPIListCommits(match[1].str());
        } else if (std::regex_search(path, match, regGetCommitSubjects)) {
          requestHandler = new RequestHandlerAPIGetCommitSubjects(
              match[1].str(), match[2].str());
        } else if (std::regex_search(path, match, regGetCommitMetrics)) {
          requestHandler = new RequestHandlerAPIGetCommitMetrics(
              match[1].str(), match[2].str(), match[3].str());
        }
      } else if (method == "POST") {
        if (std::regex_search(path, match, regGetCommitMetricsValues)) {
          requestHandler = new RequestHandlerAPIGetCommitMetricsValues(
              match[1].str(), match[2].str(), match[3].str(), 
              std::strtoull(match[4].str().c_str(), nullptr, 10), 
              std::strtoull(match[5].str().c_str(), nullptr, 10), 
              std::strtoull(match[6].str().c_str(), nullptr, 10));
        } else if (path == "/api/refresh") {
          //requestHandler = new RequestHandlerAPIRefresh();
        }
      }
    }
    else if (method == "GET" && path.find("/files/") == 0) {
      requestHandler = new RequestHandlerFiles("/files");
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
