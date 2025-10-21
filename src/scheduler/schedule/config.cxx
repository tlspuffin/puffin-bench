#include "config.hxx"
#include "../utils/rapidjson.hxx"
#include <iostream>
#include <fstream>

static ns_Schedule::Config defaultConfig;

ns_Schedule::Config::Config() 
    : toolsPath_("tools"), runPath_("runs"), 
    exportPath_(std::filesystem::path("exports") / "schedule"), 
    userPath_("users_data")
{}

ns_Schedule::Config::~Config() {
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

  doc.AddMember(rapidjson::Value(name.c_str(), alloc), node, alloc);
}

void ns_Schedule::Config::Validate() const {
  auto discard = std::filesystem::canonical(toolsPath_);
  discard = std::filesystem::canonical(runPath_);
  discard = std::filesystem::canonical(userPath_);
  discard = std::filesystem::canonical(exportPath_);
}