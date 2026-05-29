#include "../version.h"
#include "config.hxx"
#include "server/server.hxx"
#include "api/api.hxx"
#include <iostream>

int main(int argc, char *argv[]) {
  std::cout << "Version: " << buildID << (buildGitDirty ? "-dev" : "") << std::endl;

  Config config;
  bool forceInstall = false;
  bool onlyInstall = false;
  std::string configFile = "vis_compartor-config.json";
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
  if ((!config.Load(configFile)) && (!std::filesystem::exists(configFile))) {
    config.Save(configFile);
    std::cerr << "Config file " << configFile << " not found, create a default one and exit" << std::endl;
    return 1;
  }
  config.Validate(forceInstall);
  if (onlyInstall) {
    return 0;
  }

  {
    config.Save(configFile + ".run");
  }

  struct ns_API::APIS apis(config.analyze_);

  ns_Server::MyServerApp app(config.server_, apis);
  try {
    return app.run(1, argv);
  } catch(std::runtime_error const& e) {
    std::cerr << e.what() << std::endl;
    return 1;
  }
}
