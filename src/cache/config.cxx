#include "config.hxx"
#include "../utils/rapidjson.hxx"

static ns_Cache::Config defaultConfig;

ns_Cache::Config::Config()
    : storagePath_("users_data"), mappingFile_("cache.json")
{}

void ns_Cache::Config::Load(std::string const& name, rapidjson::Value& doc) {
  rapidjson::Value emptyCacheConfig(rapidjson::kObjectType);
  rapidjson::Value const* cacheConfig = &emptyCacheConfig;
  if (doc.HasMember(name.c_str()) && (doc[name.c_str()].IsObject())) {
    cacheConfig = &doc[name.c_str()];
  }
  storagePath_ = std::filesystem::weakly_canonical(
      GetOrDefault<std::string>(*cacheConfig, "storagePath", defaultConfig.storagePath_))
      .string();
  std::string mapFile = GetOrDefault<std::string>(*cacheConfig, "mappingFile", 
      defaultConfig.mappingFile_);
  mappingFile_ = std::filesystem::weakly_canonical(storagePath_ / mapFile).string();
}

void ns_Cache::Config::Save(std::string const& name, rapidjson::Value& doc, 
    rapidjson::MemoryPoolAllocator<>& alloc) const {
  rapidjson::Value node(rapidjson::kObjectType);
  node.AddMember("storagePath",
      rapidjson::Value(storagePath_.c_str(), alloc), alloc);
  node.AddMember("mappingFile",
      rapidjson::Value(mappingFile_.c_str(), alloc), alloc);
  doc.AddMember(rapidjson::Value(name.c_str(), alloc), node, alloc);
}