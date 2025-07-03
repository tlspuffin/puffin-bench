#include "server/server.hxx"
#include "api/api.hxx"

#include "config.hxx"
#include "schedule/executor/config.hxx"

#define SEC_PATH "../security"
#define USR_PATH "../users_data"
#define SCRIPT_PATH "../scripts"
#define RUN_PATH "../runs"
#define EXPORT_PATH "../users_data"

int main(int argc, char *argv[]) {
  Config config;
  config.server_.secure_ = false;
  config.server_.key_ = realpath(SEC_PATH "/site.key", nullptr);
  config.server_.cert_ = realpath(SEC_PATH "/site.pem", nullptr);
  config.server_.CA_ = realpath(SEC_PATH "/CA.pem", nullptr);
  config.server_.port_ = config.server_.secure_ ? 8443 : 8080;

  ns_Executor::LocalConfig* localConfig = new struct ns_Executor::LocalConfig();
  localConfig->maxCPU_ = 4;
  localConfig->scriptPath_ = realpath(SCRIPT_PATH, nullptr);
  localConfig->runPath_ = realpath(RUN_PATH, nullptr);
  config.schedule_.executors_.insert(std::make_pair<>("local", localConfig));
  config.schedule_.userPath_ = realpath(USR_PATH, nullptr);
  config.schedule_.exportPath_ = realpath(EXPORT_PATH, nullptr);

  config.cache_.storagePath_ = realpath(USR_PATH, nullptr);
  config.cache_.mappingFile_ = std::string(realpath(USR_PATH, nullptr)) + "/cache_data.json";

  struct ns_API::APIS apis(config.schedule_, config.cache_);

  ns_Server::MyServerApp app(config.server_, apis);
  return app.run(argc, argv);
}