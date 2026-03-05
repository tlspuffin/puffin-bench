#include "config.hxx"
#include "api/api.hxx"
#include "server/server.hxx"

#include <iostream>

#define SEC_PATH "../security"
#define USR_PATH "../users_data"
#define SCRIPT_PATH "../scripts"
#define RUN_PATH "../runs"
#define EXPORT_PATH "../users_data"

int main(int argc, char *argv[]) {
  bool forceInstall = false;
  std::string configFile = "publisher_config.json";
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

  Config config(forceInstall);
  if (!config.Load(configFile)) {
    config.Save(configFile);
  }
  config.Validate();

  struct ns_API::APIS apis(config.publish_);

  ns_Server::MyServerApp app(config.server_, apis);
  try {
    return app.run(argc, argv);
  } catch(std::runtime_error const& e) {
    std::cerr << e.what() << std::endl;
    return 1;
  }
}
