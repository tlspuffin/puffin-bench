#include "../version.h"
#include "server/server.hxx"
#include "config.hxx"
#include "../utils/logs.hxx"
#include "../embeded/git_restapi/tlspuffin_history_sh.h"
#include <fstream>
#include <iostream>
#include <unistd.h>

static void CleanTMP(std::string const& tmpPath) {
  std::error_code ec;
  std::filesystem::remove_all(tmpPath, ec);
  if (ec) {
    LOGE << "Was unable to delete " << tmpPath << Log::Flags::End;
  }
}

int main(int argc, char *argv[]) {
  logs.SetLevel({1, 1, 1, 1});
  LOGA << "Version: " << buildID << (buildGitDirty ? "-dev" : "") << Log::Flags::End;

  std::string tmpPath = std::filesystem::temp_directory_path() / 
      (std::string(basename(argv[0])) + "-" + std::to_string(getpid()));

  Config config(tmpPath);

  bool overrideLogsLevel = false;
  unsigned int userLogsLevel = 0;
  bool forceInstall = false;
  std::string configFile = "git_restapi-config.json";
  for(int i=1; i<argc; i++) {
    if (argv[i][0] != '-') {
      configFile = argv[i];
    } else {
      bool used = false;
      std::vector<std::string> parameters{"--install", "--logslevel"};
      for(size_t j=0; j<parameters.size(); ++j) {
        if (parameters[j].compare(argv[i]) == 0) {
          switch(j) {
            case 0:
              forceInstall = true;
              used = true;
              break;
            case 1:
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
    if (!std::filesystem::create_directories(tmpPath)) {
      throw std::runtime_error(std::string("Fatal error: unable to create path: ") + tmpPath);
    }
    Poco::Util::ServerApplication::registerTerminateCallback(CleanTMP, tmpPath);

    struct ns_API::APIS apis(config.git_);
    ns_Server::MyServerApp app(config.server_, apis);
    return app.run(1, argv);
  } catch(std::runtime_error const& e) {
    LOGE << e.what() << Log::Flags::End;
    std::error_code ec;
    std::filesystem::remove_all(tmpPath);
    return 1;
  }
}
