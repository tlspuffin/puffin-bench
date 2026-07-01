#pragma once

#include "config.hxx"
#include "request_handler.hxx"
#include "../../utils/logs.hxx"
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

  static std::regex reProjectListData(R"(/api/project/([a-zA-Z0-9_-]+)/data$)");
  static std::regex reProjectListCampaigns(R"(/api/project/([a-zA-Z0-9_-]+)/campaigns$)");
  static std::regex reProjectRegenrateCache(R"(/api/project/([a-zA-Z0-9_-]+)/regenerate_cache(?:\?directory=([a-zA-Z0-9_./-]+))?$)");
  static std::regex reProjectDeleteData(R"(/api/project/([a-zA-Z0-9_-]+)/data/([a-zA-Z0-9_./-]+)$)");

  RequestHandler* requestHandler = nullptr;
  std::string uri = request.getURI();
  std::string method = request.getMethod();
  LOGI << "Got request " << method << " " << uri << Log::Flags::End;
  std::smatch matches;
  if (method == Poco::Net::HTTPRequest::HTTP_OPTIONS) {
    requestHandler = new RequestHandlerCORSOptions();
  } else if (method == Poco::Net::HTTPRequest::HTTP_POST) {
    if (uri == "/api/notify") {
      requestHandler = new RequestHandlerNotify;
    } else if (std::regex_match(uri, matches, reProjectRegenrateCache)) {
      requestHandler = new RequestHandlerProjectRegenerateCache(matches[1].str(), matches[2].str());
    }
   } else if (method == Poco::Net::HTTPRequest::HTTP_GET) {
    if (std::regex_match(uri, matches, reProjectListData)) {
      requestHandler = new RequestHandlerProjectListData(matches[1].str());
    } else if (std::regex_match(uri, matches, reProjectListCampaigns)) {
      requestHandler = new RequestHandlerProjectListCampaigns(matches[1].str());
    } else if (uri.find("/files/") == 0) {
      uri = uri.substr(7);
      std::string uriRulesIndex = apis_.publishAPI_.RulesIndex(uri);
      if (uri == uriRulesIndex) {
        requestHandler = new RequestHandlerFiles(apis_.publishAPI_.Storage(), uri);
      } else {
        requestHandler = new RequestHandlerFiles(apis_.publishAPI_.HTMLStorage(), uriRulesIndex);
      }
    } else if (uri.find("/html/") == 0) {
      uri = uri.substr(6);
      requestHandler = new RequestHandlerFiles(apis_.publishAPI_.HTMLStorage(), uri);
    }
  } else if (method == Poco::Net::HTTPRequest::HTTP_DELETE) {
    if (std::regex_match(uri, matches, reProjectDeleteData)) {
      requestHandler = new RequestHandlerProjectDeleteData(matches[1].str(), matches[2].str());
    }
  }
  if (requestHandler != nullptr) {
    requestHandler->Configure(config_, apis_);
  } else {
    requestHandler = new RequestHandlerError;
  }
  return requestHandler;
}

};
