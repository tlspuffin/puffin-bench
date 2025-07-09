#include "server/server.hxx"
#include "api/api.hxx"

#include "config.hxx"
#include "schedule/executor/config.hxx"

#include <iostream>

#define SEC_PATH "../security"
#define USR_PATH "../users_data"
#define SCRIPT_PATH "../scripts"
#define RUN_PATH "../runs"
#define EXPORT_PATH "../users_data"

int main(int argc, char *argv[]) {
  Config config;
  config.server_.secure_ = false;
  config.server_.key_ = std::filesystem::canonical(std::filesystem::path(SEC_PATH) / "site.key").string();
  config.server_.cert_ = std::filesystem::canonical(std::filesystem::path(SEC_PATH) / "site.pem").string();
  config.server_.CA_ = std::filesystem::canonical(std::filesystem::path(SEC_PATH) / "CA.pem").string();
  config.server_.port_ = config.server_.secure_ ? 8443 : 8080;

  ns_Executor::LocalConfig* localConfig = new struct ns_Executor::LocalConfig();
  localConfig->maxCPU_ = 4;
  localConfig->scriptPath_ = std::filesystem::canonical(std::filesystem::path(SCRIPT_PATH)).string();
  localConfig->runPath_ = std::filesystem::canonical(std::filesystem::path(RUN_PATH)).string();
  config.schedule_.executors_.insert(std::make_pair<>("local", localConfig));
  config.schedule_.userPath_ = std::filesystem::canonical(std::filesystem::path(USR_PATH)).string();
  config.schedule_.exportPath_ = std::filesystem::canonical(std::filesystem::path(EXPORT_PATH)).string();

  config.cache_.storagePath_ = std::filesystem::canonical(std::filesystem::path(USR_PATH)).string();
  config.cache_.mappingFile_ = std::filesystem::canonical(std::filesystem::path(USR_PATH) / "cache.json").string();

  struct ns_API::APIS apis(config.schedule_, config.cache_);

  ns_Server::MyServerApp app(config.server_, apis);
  try {
    int rc = app.run(argc, argv);
    delete localConfig;
    return rc;
  } catch(std::runtime_error const& e) {
    std::cerr << e.what() << std::endl;
    return 1;
  }
}