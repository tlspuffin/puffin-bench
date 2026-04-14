#include "../version.h"
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
  std::cout << "Version: " << buildID << (buildGitDirty ? "-dev" : "") << std::endl;
  Config config;

#if 0
  config.server_.secure_ = false;
  config.server_.key_ = std::filesystem::weakly_canonical(std::filesystem::path(SEC_PATH) / "site.key").string();
  config.server_.cert_ = std::filesystem::weakly_canonical(std::filesystem::path(SEC_PATH) / "site.pem").string();
  config.server_.CA_ = std::filesystem::weakly_canonical(std::filesystem::path(SEC_PATH) / "CA.pem").string();
  config.server_.port_ = config.server_.secure_ ? 8443 : 8080;

  ns_Executor::LocalConfig* localConfig = new struct ns_Executor::LocalConfig();
  localConfig->maxCPU_ = 4;
  localConfig->scriptPath_ = std::filesystem::canonical(std::filesystem::path(SCRIPT_PATH)).string();
  localConfig->runPath_ = std::filesystem::canonical(std::filesystem::path(RUN_PATH)).string();
  config.schedule_.executors_.insert(std::make_pair<>("local", localConfig));
  config.schedule_.userPath_ = std::filesystem::canonical(std::filesystem::path(USR_PATH)).string();
  config.schedule_.exportPath_ = std::filesystem::canonical(std::filesystem::path(EXPORT_PATH)).string();

  config.cache_.storagePath_ = std::filesystem::canonical(std::filesystem::path(USR_PATH)).string();
  config.cache_.mappingFile_ = std::filesystem::weakly_canonical(std::filesystem::path(USR_PATH) / "cache.json").string();
#endif

  bool forceInstall = false;
  bool onlyInstall = false;
  std::string configFile = "config.json";
  for(int i=1; i<argc; i++) {
    if (argv[i][0] != '-') {
      configFile = argv[i];
    } else {
      bool used = false;
      std::vector<std::string> parameters{"--force-install", "--install"};
      for(size_t j=0; j<parameters.size(); ++j) {
        if (parameters[j].compare(argv[i]) == 0) {
          switch(j) {
            case 0:
              forceInstall = true;
              used = true;
              break;
            case 1:
              forceInstall = true;
              onlyInstall = true;
              used = true;
              break;
            default:
              std::cerr << "Unknown parameter: " << argv[i] << ". Aborting" << std::endl;
              return 1;
          }
        }
      }
      if (!used) {
        std::cerr << "Unknown parameter: " << argv[i] << ". Aborting" << std::endl;
        return 1;
      }
    }
  }
  if (!config.Load(configFile)) {
    config.Save(configFile);
  }
  config.Validate(forceInstall);
  if (onlyInstall) {
    return 0;
  }

  struct ns_API::APIS apis(config.schedule_, config.cache_, config.server_.port_);

  ns_Server::MyServerApp app(config.server_, apis);
  try {
    return app.run(1, argv);
  } catch(std::runtime_error const& e) {
    std::cerr << e.what() << std::endl;
    return 1;
  }
}