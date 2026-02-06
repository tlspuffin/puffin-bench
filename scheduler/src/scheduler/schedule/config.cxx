#include "config.hxx"
#ifdef STATIC
#include "reserve_port-static.h"
#else
#include "reserve_port.h"
#endif
#include "../../utils/rapidjson.hxx"
#include <iostream>
#include <fstream>

static ns_Schedule::Config defaultConfig;

ns_Schedule::Config::Config() 
    : toolsPath_("tools"), runPath_("runs"), 
    exportPath_(std::filesystem::path("exports") / "schedule"), 
    userPath_("users_data"), executors_(), monitorsPath_(runPath_ / "monitors")
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

  toolsPath_  = std::filesystem::weakly_canonical(
      GetOrDefault<std::string>(*scheduleConfig, "toolsPath", defaultConfig.toolsPath_))
      .string();
  userPath_  = std::filesystem::weakly_canonical(
      GetOrDefault<std::string>(*scheduleConfig, "userPath", defaultConfig.userPath_))
      .string();
  runPath_  = std::filesystem::weakly_canonical(
      GetOrDefault<std::string>(*scheduleConfig, "runPath", defaultConfig.runPath_))
      .string();
  exportPath_ = std::filesystem::weakly_canonical(
      GetOrDefault<std::string>(*scheduleConfig, "exportPath", defaultConfig.exportPath_))
      .string();

  monitorsPath_ = runPath_ / "monitors";

  if (scheduleConfig->HasMember("executors") && 
      (*scheduleConfig)["executors"].IsObject()) {
    for (auto const& [ key, jsonConfig ] : (*scheduleConfig)["executors"].GetObject()) {
      ns_Executor::Config* executorConfig = ns_Executor::Config::BuildConfig(key.GetString(), jsonConfig);
      executors_.emplace(executorConfig->name_, executorConfig);
    }
  }
  if (executors_.empty()) {
    ns_Executor::LocalConfig* localConfig = new ns_Executor::LocalConfig("local");
    executors_.emplace(localConfig->name_, localConfig);
  }

  if (scheduleConfig->HasMember("publisher") && (*scheduleConfig)["publisher"].IsObject()) {
    for (auto const& [ key, jsonConfig ] : (*scheduleConfig)["publisher"].GetObject()) {
      struct PublisherConfig publisherConfig;
      publisherConfig.uri_ = Get<std::string>(jsonConfig, "uri");
      publisherConfig.storage_ = GetPath(jsonConfig, "storage");
      publisherConfig.checkServerCertificat_ = GetOrDefault<bool>(jsonConfig, "check_server_certificat", false);
      publishers_.emplace(key.GetString(), publisherConfig);
    }
  }

}

void ns_Schedule::Config::Save(std::string const& name, rapidjson::Value& doc, 
      rapidjson::MemoryPoolAllocator<>& alloc) const {
  rapidjson::Value node(rapidjson::kObjectType);

  node.AddMember("toolsPath",
    rapidjson::Value(toolsPath_.c_str(), alloc), alloc);
  node.AddMember("runPath",
    rapidjson::Value(runPath_.c_str(), alloc), alloc);
  node.AddMember("userPath",
      rapidjson::Value(userPath_.c_str(), alloc), alloc);
  node.AddMember("exportPath",
      rapidjson::Value(exportPath_.c_str(), alloc), alloc);

  rapidjson::Value executorsConfig(rapidjson::kObjectType);
  for (auto const& [name, executorConfig] : executors_) {
    executorConfig->Save(name, executorsConfig, alloc);
  }
  node.AddMember("executors", executorsConfig, alloc);

  doc.AddMember(rapidjson::Value(name.c_str(), alloc), node, alloc);
}

void ns_Schedule::Config::Validate(bool forceInstall) const {
  auto discard = std::filesystem::canonical(toolsPath_);

  for(auto const& [ file, data, size ] : { 
      std::tuple{ "reserve_port", (char const*)ReservePort_Binary, (size_t)ReservePort_Binary_len }
  }) {
    std::filesystem::path filePath = 
        std::filesystem::weakly_canonical(toolsPath_ / file);
    if (!std::filesystem::exists(filePath)) {
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

  discard = std::filesystem::canonical(runPath_);
  discard = std::filesystem::canonical(userPath_);
  discard = std::filesystem::canonical(exportPath_);
  for (auto const& [name, executorConfig] : executors_) {
    executorConfig->Validate(forceInstall);
  }
}