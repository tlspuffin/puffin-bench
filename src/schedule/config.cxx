#include "config.hxx"
#include "../utils/rapidjson.hxx"

static ns_Schedule::Config defaultConfig;

ns_Schedule::Config::Config() 
    : exportPath_("users_data"), userPath_("users_data"), executors_()
{}

ns_Schedule::Config::~Config() {
  for(auto& it : executors_) {
    delete it.second;
  }
}

void ns_Schedule::Config::Load(std::string const& name, rapidjson::Value& doc) {
  rapidjson::Value emptyScheduleConfig(rapidjson::kObjectType);
  rapidjson::Value const* scheduleConfig = &emptyScheduleConfig;
  if (doc.HasMember(name.c_str()) && (doc[name.c_str()].IsObject())) {
    scheduleConfig = &doc[name.c_str()];
  }

  if (scheduleConfig->HasMember("executors") && 
      (*scheduleConfig)["executors"].IsObject()) {
    for (auto const& [ found, executor ] : (*scheduleConfig)["executors"].GetObject()) {
      ns_Executor::Config* executorConfig = ns_Executor::Config::BuildConfig(executor);
      executors_.emplace(executorConfig->name_, executorConfig);
    }
  }
  if (executors_.empty()) {
    ns_Executor::LocalConfig* localConfig = new ns_Executor::LocalConfig("local");
    executors_.emplace(localConfig->name_, localConfig);
  }
  userPath_  = std::filesystem::weakly_canonical(
      GetOrDefault<std::string>(*scheduleConfig, "userPath", defaultConfig.userPath_))
      .string();
  exportPath_ = std::filesystem::weakly_canonical(
      GetOrDefault<std::string>(*scheduleConfig, "exportPath", defaultConfig.exportPath_))
      .string();
}

void ns_Schedule::Config::Save(std::string const& name, rapidjson::Value& doc, 
      rapidjson::MemoryPoolAllocator<>& alloc) const {
  rapidjson::Value node(rapidjson::kObjectType);
  rapidjson::Value executorsConfig(rapidjson::kObjectType);
  for (auto const& [name, executor] : executors_) {
    executor->Save(name, executorsConfig, alloc);
  }
  node.AddMember("executors", executorsConfig, alloc);
  node.AddMember("userPath",
      rapidjson::Value(userPath_.c_str(), alloc), alloc);
  node.AddMember("exportPath",
      rapidjson::Value(exportPath_.c_str(), alloc), alloc);
  doc.AddMember(rapidjson::Value(name.c_str(), alloc), node, alloc);
}