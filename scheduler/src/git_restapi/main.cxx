#include "server/server.hxx"
#include "config.hxx"
#include "../embeded/git_restapi/tlspuffin_history_sh.h"
#include <fstream>
#include <iostream>

static void CleanTMP(std::string const& tmpPath) {
  std::error_code ec;
  std::filesystem::remove_all(tmpPath, ec);
  if (ec) {
    std::cerr << "Was unable to delete " << tmpPath << std::endl;
  }
}

int main(int argc, char *argv[]) {
  Config config;

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
    struct ns_API::APIS apis(argv[0]);
    ns_Server::MyServerApp app(config.server_, apis);
    Poco::Util::ServerApplication::registerTerminateCallback(CleanTMP, apis.tmpPath_);

    for(auto const& [ file, data, size ] : {
      std::tuple{ "tlspuffin_history.sh", TLSPuffinHistory_Script_data, TLSPuffinHistory_Script_size },
    }) {
      std::filesystem::path filePath = 
          std::filesystem::weakly_canonical(apis.tmpPath_ / file);
      if (forceInstall || (!std::filesystem::exists(filePath))) {
        std::cerr << "Creating missing required file " << filePath << std::endl;
        std::ofstream ofs(filePath, std::ios::binary);
        ofs.write(data, size);
        ofs.close();
        std::filesystem::permissions(filePath,
          std::filesystem::perms::owner_all |
          std::filesystem::perms::group_read | std::filesystem::perms::group_exec, 
          std::filesystem::perm_options::replace);
      }
    }
    std::filesystem::create_directory(apis.tmpPath_ / "tlspuffin.git");
    return app.run(1, argv);
  } catch(std::runtime_error const& e) {
    std::cerr << e.what() << std::endl;
    return 1;
  }
}