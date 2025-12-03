#include "../utils/rapidjson.hxx"
#include "server/server.hxx"
#include "api/api.hxx"
#include <iostream>
#include <fstream>
#include <vector>
#include <string>
#include <rapidjson/ostreamwrapper.h>
#include <rapidjson/prettywriter.h>

class Config {
public:
  ns_Server::Config server_;
  ns_Analyze::Config analyze_;

  Config();
  void Load(std::string const& filename);
  void Save(std::string const& filename) const;
  void Validate() const;
};

Config::Config()
{}

void Config::Load(std::string const& filename) {
  rapidjson::Document doc;
  ReadJSONFile(filename, doc);
  server_.Load("server", doc);
  analyze_.Load("data", doc);
}

void Config::Save(std::string const& filename) const {
  rapidjson::Document doc;
  doc.SetObject();
  auto& alloc = doc.GetAllocator();
  server_.Save("server", doc, alloc);
  analyze_.Save("data", doc, alloc);

  std::ofstream ofs(filename, std::ios::trunc);
  if (ofs.is_open()) {
    std::runtime_error("Unable to create file " + filename);
  }
  rapidjson::OStreamWrapper osw { ofs };
  rapidjson::PrettyWriter<rapidjson::OStreamWrapper> writer { osw };
  doc.Accept(writer);
  ofs.close();
}

void Config::Validate() const {
  server_.Validate();
  analyze_.Validate();
}

int main(int argc, char *argv[]) {
  Config config;
  std::filesystem::path configName = "analyze_server.json";
  if (argc > 1) {
    configName = argv[1];
  }
  try {
    config.Load(configName);
    config.Validate();
  } catch(...) {
    config.Save(configName);
    return 1;
  }

  struct ns_API::APIS apis(config.analyze_);

  ns_Server::MyServerApp app(config.server_, apis);
  try {
    return app.run(argc, argv);
  } catch(std::runtime_error const& e) {
    std::cerr << e.what() << std::endl;
    return 1;
  }
}
