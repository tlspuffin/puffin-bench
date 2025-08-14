#pragma once

#include "config.hxx"
#include "../api/api.hxx"
#include <Poco/Util/ServerApplication.h>

namespace ns_Server {

class MyServerApp : public Poco::Util::ServerApplication {
public:
  MyServerApp(ns_Server::Config const& config, struct ns_API::APIS& apis);

  protected:
  int main(const std::vector<std::string>& args);

private:
  ns_Server::Config const& config_;
  struct ns_API::APIS& apis_;
};

};