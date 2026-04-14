#include "../version.h"
#include "../utils/logs.hxx"
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
  logs.SetLevel({1, 1, 1, 1});
  LOGA << "Version: " << buildID << (buildGitDirty ? "-dev" : "") << Log::Flags::End;
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

  bool overrideLogsLevel = false;
  unsigned int userLogsLevel = 0;
  bool forceInstall = false;
  bool onlyInstall = false;
  std::string configFile = "config.json";
  for(int i=1; i<argc; i++) {
    if (argv[i][0] != '-') {
      configFile = argv[i];
    } else {
      bool used = false;
      std::vector<std::string> parameters{"--force-install", "--install", "--logslevel"};
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
            case 2:
              if ((i+1) >= argc) {
                LOGE << "Missing number parameter for --logslevel. Aborting" << Log::Flags::End;
                return 1;
              }
              overrideLogsLevel = true;
              userLogsLevel = std::stoi(argv[++i]);
              used = true;
              break;
            default:
              LOGE << "Unknown parameter: " << argv[i] << ". Aborting" << Log::Flags::End;
              return 1;
          }
        }
      }
      if (!used) {
        LOGE << "Unknown parameter: " << argv[i] << ". Aborting" << Log::Flags::End;
        return 1;
      }
    }
  }
  if ((!config.Load(configFile)) && (!std::filesystem::exists(configFile))) {
    config.Save(configFile);
    LOGA << "Config file " << configFile << " not found, create a default one and exit" << Log::Flags::End;
    return 1;
  }
  config.Validate(forceInstall);
  if (onlyInstall) {
    return 0;
  }
  if (overrideLogsLevel) {
    logs.SetLevel(userLogsLevel);
  } else {
    userLogsLevel = config.logsLevel_;
  }

  {
    unsigned int saveConfigLogsLevel = config.logsLevel_;
    config.logsLevel_ = userLogsLevel;
    config.Save(configFile + ".run");
    config.logsLevel_ = saveConfigLogsLevel;
  }

  struct ns_API::APIS apis(config.schedule_, config.cache_, config.server_.port_);

  ns_Server::MyServerApp app(config.server_, apis);
  try {
    return app.run(1, argv);
  } catch(std::runtime_error const& e) {
    LOGE << e.what() << Log::Flags::End;
    return 1;
  }
}
