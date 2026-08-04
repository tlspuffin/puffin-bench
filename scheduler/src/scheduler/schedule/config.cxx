#include "config.hxx"
#include "../../utils/logs.hxx"
#include "../../utils/rapidjson.hxx"
#include <iostream>
#include <fstream>

static ns_Schedule::Config defaultConfig;

ns_Schedule::Config::Config() 
    : toolsPath_("tools"), runPath_("runs"), 
    exportPath_("exports"), exportCanceledPath_(exportPath_ / "Canceled"), 
    userPath_("users_data"), executors_(), monitorsPath_(runPath_ / "monitors"),
    apiURL_()
{}

ns_Schedule::Config::~Config() {
  for(auto& it : executors_) {
    delete it.second;
  }
}

void ns_Schedule::Config::Load(std::string const& name, rapidjson::Value& doc, 
    std::string const& apiURL) {
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
  exportCanceledPath_ = exportPath_ / "Canceled";

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
      publisherConfig.baseURL_ = Get<std::string>(jsonConfig, "base_url");
      publisherConfig.notifyEndpoint_ = Get<std::string>(jsonConfig, "notify_endpoint");
      publisherConfig.viewEndpoint_ = Get<std::string>(jsonConfig, "view_endpoint");
      publisherConfig.storage_ = GetPath(jsonConfig, "storage");
      publisherConfig.checkServerCertificat_ = GetOrDefault<bool>(jsonConfig, "check_server_certificat", false);
      publishers_.emplace(key.GetString(), publisherConfig);
    }
  }

  apiURL_ = apiURL;
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

  rapidjson::Value publishersJSONConfig(rapidjson::kObjectType);
  for(auto const&[publisherName, publisherConfig]: publishers_) {
    rapidjson::Value publisherJSONConfig(rapidjson::kObjectType);
    publisherJSONConfig.AddMember("base_url", rapidjson::Value(publisherConfig.baseURL_.c_str(), alloc), alloc);
    publisherJSONConfig.AddMember("notify_endpoint", rapidjson::Value(publisherConfig.notifyEndpoint_.c_str(), alloc), alloc);
    publisherJSONConfig.AddMember("view_endpoint", rapidjson::Value(publisherConfig.viewEndpoint_.c_str(), alloc), alloc);
    publisherJSONConfig.AddMember("storage", rapidjson::Value(publisherConfig.storage_.c_str(), alloc), alloc);
    publisherJSONConfig.AddMember("check_server_certificat", publisherConfig.checkServerCertificat_, alloc);
    publishersJSONConfig.AddMember(rapidjson::Value(publisherName.c_str(), alloc), publisherJSONConfig, alloc);
  }
  node.AddMember("publisher", publishersJSONConfig, alloc);

  doc.AddMember(rapidjson::Value(name.c_str(), alloc), node, alloc);
}

void ns_Schedule::Config::Validate(bool forceInstall) const {
  auto discard = std::filesystem::canonical(toolsPath_);

  discard = std::filesystem::canonical(runPath_);
  discard = std::filesystem::canonical(userPath_);
  discard = std::filesystem::canonical(exportPath_);
  std::error_code ec;
  std::filesystem::create_directory(exportCanceledPath_, ec);
  for (auto const& [name, executorConfig] : executors_) {
    executorConfig->Validate(forceInstall);
  }
}
