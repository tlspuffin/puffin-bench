#include "../version.h"
#include "server/server.hxx"
#include "config.hxx"
#include "../embeded/git_restapi/tlspuffin_history_sh.h"
#include <fstream>
#include <iostream>
#include <unistd.h>

static void CleanTMP(std::string const& tmpPath) {
  std::error_code ec;
  std::filesystem::remove_all(tmpPath, ec);
  if (ec) {
    std::cerr << "Was unable to delete " << tmpPath << std::endl;
  }
}

int main(int argc, char *argv[]) {
  std::cout << "Version: " << buildID << (buildGitDirty ? "-dev" : "") << std::endl;

  std::string tmpPath = std::filesystem::temp_directory_path() / 
      (std::string(basename(argv[0])) + "-" + std::to_string(getpid()));

  Config config(tmpPath);

  bool forceInstall = false;
  std::string configFile = "git_restapi-config.json";
  for(int i=1; i<argc; i++) {
    if (argv[i][0] != '-') {
      configFile = argv[i];
    } else {
      bool used = false;
      std::vector<std::string> parameters{"--install"};
      for(size_t j=0; j<parameters.size(); ++j) {
        if (parameters[j].compare(argv[i]) == 0) {
          switch(j) {
            case 0:
              forceInstall = true;
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

  try {
    if (!std::filesystem::create_directories(tmpPath)) {
      throw std::runtime_error(std::string("Fatal error: unable to create path: ") + tmpPath);
    }
    Poco::Util::ServerApplication::registerTerminateCallback(CleanTMP, tmpPath);

    struct ns_API::APIS apis(config.git_);
    ns_Server::MyServerApp app(config.server_, apis);
    return app.run(1, argv);
  } catch(std::runtime_error const& e) {
    std::cerr << e.what() << std::endl;
    std::error_code ec;
    std::filesystem::remove_all(tmpPath);
    return 1;
  }
}