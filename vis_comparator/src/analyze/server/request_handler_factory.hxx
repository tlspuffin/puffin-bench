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

  std::string path = request.getURI();
  size_t qPos = path.find('?');
  if (qPos != std::string::npos) path = path.substr(0, qPos);
  std::string method = request.getMethod();

  RequestHandler* requestHandler = nullptr;

  // Every /api route now carries the protocol as its first capture group
  // (^/api/<protocol>/PR/…); the concrete args follow, shifted by one.
  static const std::regex regListCommits("^/api/([^/]+)/PR/commits/([^/]+)$");
  static const std::regex regGetCommitRuns("^/api/([^/]+)/PR/runs/([^/]+)$");
  static const std::regex regListCampaigns("^/api/([^/]+)/PR/campaigns$");
  static const std::regex regGetCommitSubjects("^/api/([^/]+)/PR/subjects/([^/]+)/([^/]+)/([0-9]+)$");
  static const std::regex regGetCommitMetrics("^/api/([^/]+)/PR/metrics/([^/]+)/([^/]+)/([0-9]+)/([^/]+)$");
  static const std::regex regGetCommitMetricsValues(
      "^/api/([^/]+)/PR/values/([^/]+)/([^/]+)/([0-9]+)/([^/]+)/([0-9]+)/([0-9]+)/([0-9]+)$");
  static const std::regex regSaveLoadUserData("^/api/([^/]+)/PR/userdata/([^/]+)$");
  static const std::regex regListUserData("^/api/([^/]+)/PR/userdata/*$");
  static const std::regex regSaveLoadTemplate("^/api/([^/]+)/PR/userdata/templates/([^/]+)$");
  static const std::regex regListTemplates("^/api/([^/]+)/PR/userdata/templates/*$");
  static const std::regex regListTemplateVariables("^/api/([^/]+)/PR/userdata/templates-variables$");
  static const std::regex regGetGitHistory("^/api/([^/]+)/PR/git/history$");
  static const std::regex regGetGitLog("^/api/([^/]+)/PR/git/log/([^/]+)$");

  std::smatch match;

  try {
    if (path.find("/api/") == 0) {
      if (method == "GET") {
        if (std::regex_search(path, match, regListCommits)) {
          requestHandler = new RequestHandlerAPIListCommits(match[2].str());
        } else if (std::regex_search(path, match, regGetCommitRuns)) {
          requestHandler = new RequestHandlerAPIGetCommitRuns(match[2].str());
        } else if (std::regex_search(path, match, regListCampaigns)) {
          requestHandler = new RequestHandlerAPIListCampaigns();
        } else if (std::regex_search(path, match, regGetCommitSubjects)) {
          requestHandler = new RequestHandlerAPIGetCommitSubjects(
              match[2].str(), match[3].str(),
              std::strtoull(match[4].str().c_str(), nullptr, 10));
        } else if (std::regex_search(path, match, regGetCommitMetrics)) {
          requestHandler = new RequestHandlerAPIGetCommitMetrics(
              match[2].str(), match[3].str(),
              std::strtoull(match[4].str().c_str(), nullptr, 10), match[5].str());
        } else if (std::regex_search(path, match, regGetGitHistory)) {
          requestHandler = new RequestHandlerAPIGetGitHistory();
        } else if (std::regex_search(path, match, regGetGitLog)) {
          requestHandler = new RequestHandlerAPIGetGitLog(match[2].str());
        } else if (std::regex_search(path, match, regListTemplateVariables)) {
          requestHandler = new RequestHandlerAPIListTemplateVariables();
        } else if (std::regex_search(path, match, regSaveLoadTemplate)) {
          requestHandler = new RequestHandlerAPILoadTemplate(match[2].str());
        } else if (std::regex_search(path, match, regListTemplates)) {
          requestHandler = new RequestHandlerAPIListTemplates();
        } else if (std::regex_search(path, match, regSaveLoadUserData)) {
          requestHandler = new RequestHandlerAPILoadUserData(match[2].str());
        } else if (std::regex_search(path, match, regListUserData)) {
          requestHandler = new RequestHandlerAPIListUserData();
        }
      } else if (method == "DELETE") {
        if (std::regex_search(path, match, regSaveLoadTemplate)) {
          requestHandler = new RequestHandlerAPIDeleteTemplate(match[2].str());
        } else if (std::regex_search(path, match, regSaveLoadUserData)) {
          requestHandler = new RequestHandlerAPIDeleteUserData(match[2].str());
        }
      } else if (method == "POST") {
        if (std::regex_search(path, match, regSaveLoadTemplate)) {
          requestHandler = new RequestHandlerAPISaveTemplate(match[2].str());
        } else if (std::regex_search(path, match, regGetCommitMetricsValues)) {
          requestHandler = new RequestHandlerAPIGetCommitMetricsValues(
              match[2].str(), match[3].str(),
              std::strtoull(match[4].str().c_str(), nullptr, 10), match[5].str(),
              std::strtoull(match[6].str().c_str(), nullptr, 10),
              std::strtoull(match[7].str().c_str(), nullptr, 10),
              std::strtoull(match[8].str().c_str(), nullptr, 10));
        } else if (std::regex_search(path, match, regSaveLoadUserData)) {
          requestHandler = new RequestHandlerAPISaveUserData(match[2].str());
        }
      }
      // The matching regex left the protocol in group 1; carry it to the handler.
      if (requestHandler != nullptr) {
        requestHandler->SetProtocol(match[1].str());
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
