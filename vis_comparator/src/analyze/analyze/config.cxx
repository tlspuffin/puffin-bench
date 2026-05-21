#include "config.hxx"
#include "../../utils/rapidjson.hxx"

static ns_Analyze::Config defaultConfig;

ns_Analyze::Config::Config()
    : dataPath_("data")
{}

void ns_Analyze::Config::Load(std::string const& name, rapidjson::Value& doc) {
  rapidjson::Value emptySrv(rapidjson::kObjectType);
  rapidjson::Value const* srv = &emptySrv;
  if (doc.HasMember(name.c_str()) && (doc[name.c_str()].IsObject())) {
    srv = &(doc[name.c_str()]);
  }
  dataPath_ = GetOrDefaultPath(*srv, "data", defaultConfig.dataPath_);
}

void ns_Analyze::Config::Save(std::string const& name, rapidjson::Value& doc,
    rapidjson::MemoryPoolAllocator<>& alloc) const {
  rapidjson::Value node(rapidjson::kObjectType);
  node.AddMember("data", rapidjson::Value(dataPath_.c_str(), alloc), alloc);
  doc.AddMember(rapidjson::Value(name.c_str(), alloc), node, alloc);
}

void ns_Analyze::Config::Validate() const {
  auto discard = std::filesystem::canonical(dataPath_);
}
