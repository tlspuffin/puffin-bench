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
  Config config;

  std::string configFile = "publisher_config.json";
  if (argc == 2) {
    configFile = argv[1];
  }
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