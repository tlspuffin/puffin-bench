#include "config.hxx"
#include "../../utils/logs.hxx"
#include "../../utils/rapidjson.hxx"
#include <fstream>
#include <tuple>

static ns_Publish::Config defaultConfig;

ns_Publish::Config::Config() 
    : storage_("data"), html_("html"), orphanScanInterval_(3600)  
{}

void ns_Publish::Config::Load(std::string const& name, rapidjson::Value& doc) {
  rapidjson::Value emptyConfig(rapidjson::kObjectType);
  rapidjson::Value const* config = &emptyConfig;
  if (doc.HasMember(name.c_str()) && (doc[name.c_str()].IsObject())) {
    config = &doc[name.c_str()];
  }
  storage_ = std::filesystem::weakly_canonical(
      GetOrDefault<std::string>(*config, "storagePath", defaultConfig.storage_));
  html_ = std::filesystem::weakly_canonical(
      GetOrDefault<std::string>(*config, "htmlPath", defaultConfig.html_));
  orphanScanInterval_ = 
      GetOrDefault<uint64_t>(*config, "orphanScanInterval", defaultConfig.orphanScanInterval_);
}

void ns_Publish::Config::Save(std::string const& name, rapidjson::Value& doc, 
    rapidjson::MemoryPoolAllocator<>& alloc) const {
  rapidjson::Value node(rapidjson::kObjectType);
  node.AddMember("storagePath", rapidjson::Value(storage_.c_str(), alloc), alloc);
  node.AddMember("htmlPath", rapidjson::Value(html_.c_str(), alloc), alloc);
  node.AddMember("orphanScanInterval", orphanScanInterval_, alloc);
  doc.AddMember(rapidjson::Value(name.c_str(), alloc), node, alloc);
}

void ns_Publish::Config::Validate(bool forceInstall) const {
  auto discard = std::filesystem::canonical(storage_);
  discard = std::filesystem::canonical(html_);
};
