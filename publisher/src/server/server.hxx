#pragma once

#include "config.hxx"
#include "../api/schedule_api.hxx"
#include <Poco/Util/ServerApplication.h>

namespace ns_Server {

class MyServerApp : public Poco::Util::ServerApplication {
public:
  MyServerApp(ns_Server::Config const& config, ns_API::ScheduleAPI& scheduleAPI);

  protected:
  int main(const std::vector<std::string>& args);

private:
  ns_Server::Config const& config_;
  ns_API::ScheduleAPI& scheduleAPI_;
};

};