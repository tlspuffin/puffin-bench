#include "config.hxx"
#include "../utils/rapidjson.hxx"
#include <fstream>
#include <vector>
#include <string>
#include <rapidjson/ostreamwrapper.h>
#include <rapidjson/prettywriter.h>

Config::Config()
{}

bool Config::Load(std::string const& filename) {
  rapidjson::Document doc;
  try {
    ReadJSONFile(filename, doc);
  } catch(std::exception const& e) {
    std::cerr << "Loading config file filename failed: " << e.what() << std::endl;
    return false;
  } catch(...) {
    std::cerr << "Loading config file filename failed: unknown error" << std::endl;
    return false;
  }
  server_.Load("server", doc);
  analyze_.Load("data", doc);
  return true;
}

void Config::Save(std::string const& filename) const {
  rapidjson::Document doc;
  doc.SetObject();
  auto& alloc = doc.GetAllocator();
  server_.Save("server", doc, alloc);
  analyze_.Save("data", doc, alloc);

  std::ofstream ofs(filename, std::ios::trunc);
  if (!ofs.is_open()) {
    std::cerr << "Can't open for writing: " << filename << std::endl;
    std::runtime_error("Unable to create file " + filename);
    return;
  }
  rapidjson::OStreamWrapper osw { ofs };
  rapidjson::PrettyWriter<rapidjson::OStreamWrapper> writer { osw };
  doc.Accept(writer);
  ofs.close();
}

void Config::Validate(bool forceInstall) const {
  server_.Validate(forceInstall);
  analyze_.Validate();
}
