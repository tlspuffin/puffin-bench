#include "server/server.hxx"
#include "api/schedule_api.hxx"

#include "config.hxx"

#define SEC_PATH "../security"
#define USR_PATH "../users_data"
#define SCRIPT_PATH "../scripts"
#define RUN_PATH "../runs"

int main(int argc, char *argv[]) {
  Config config;
  config.server_.secure_ = false;
  config.server_.key_ = SEC_PATH "/site.key";
  config.server_.cert_ = SEC_PATH "/site.pem";
  config.server_.CA_ = SEC_PATH "/CA.pem";
  config.server_.userPath_ = USR_PATH;
  config.server_.port_ = config.server_.secure_ ? 8443 : 8080;

  config.schedule_.maxCPU_ = 4;
  config.schedule_.userPath_ = USR_PATH;  
  config.schedule_.scriptPath_ = SCRIPT_PATH;
  config.schedule_.runPath_ = RUN_PATH;

  ns_API::ScheduleAPI scheduleAPI(config.schedule_);

  ns_Server::MyServerApp app(config.server_, scheduleAPI);
  return app.run(argc, argv);
}