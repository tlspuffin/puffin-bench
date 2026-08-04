#include "../version.h"
#include "../utils/logs.hxx"
#include "server/server.hxx"
#include "api/api.hxx"
#include "config.hxx"

int main(int argc, char *argv[]) {
  logs.SetLevel({1, 1, 1, 1});
  LOGA << "Version: " << buildID << (buildGitDirty ? "-dev" : "") << Log::Flags::End;
  Config config;

  bool overrideLogsLevel = false;
  unsigned int userLogsLevel = 0;
  bool forceInstall = false;
  bool onlyInstall = false;
  std::string configFile = "publisher_config.json";
  for(int i=1; i<argc; i++) {
    if (argv[i][0] != '-') {
      configFile = argv[i];
    } else {
      bool used = false;
      std::vector<std::string> parameters{"--force-install", "--only-install", "--logslevel"};
      for(size_t j=0; j<parameters.size(); ++j) {
        if (parameters[j].compare(argv[i]) == 0) {
          switch(j) {
            case 0:
              forceInstall = true;
              used = true;
              break;
            case 1:
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

  try {
    struct ns_API::APIS apis(config.publish_);
    ns_Server::MyServerApp app(config.server_, apis);

    return app.run(1, argv);
  } catch(std::runtime_error const& e) {
    LOGE << e.what() << Log::Flags::End;
    return 1;
  }
}
