#include "config.hxx"
#include "../../utils/rapidjson.hxx"

#include <iostream>
#include <rapidjson/stringbuffer.h>
#include <rapidjson/writer.h>

ns_Executor::Config::Config(enum ns_Executor::Config::Type type, std::string const& name) 
    : type_(type), name_(name)
{}

ns_Executor::Config* ns_Executor::Config::BuildConfig(rapidjson::Value const& node) {
  enum Type type = (enum Type)GetOrDefault<int>(node, "type", 
      (int)Config::Type::Local);
  std::string name = GetOrDefault<std::string>(node, "name", "");
  if (name.empty()) {
    throw std::runtime_error("Executor config missing name");
  }
  Config* config = nullptr;
  switch (type) {
    case Config::Type::Local:
      config = new LocalConfig(name);
      config->DoLoad(node);
      break;
    case Config::Type::None:
    default:
      throw std::runtime_error("Executor config type unknown: " + 
          std::to_string(type));
      break;
  }
  return config;
}

void ns_Executor::Config::Save(std::string const& name, rapidjson::Value& doc, 
    rapidjson::MemoryPoolAllocator<>& alloc) const {
  rapidjson::Value node(rapidjson::kObjectType);
  node.AddMember("name", rapidjson::Value(name.c_str(), alloc), alloc);
  node.AddMember("type", type_, alloc);
  DoSave(node, alloc);
  doc.AddMember(rapidjson::Value(name.c_str(), alloc), node, alloc);
}

static ns_Executor::LocalConfig defaultLocalConfig("local");

ns_Executor::LocalConfig::LocalConfig(std::string const& name) 
    : Config(Config::Type::Local, name), maxCPU_(0), cpus_(1, true), 
    scriptPath_("scripts"), runPath_("runs")
{}

void ns_Executor::LocalConfig::DoLoad(rapidjson::Value const& node) {
  maxCPU_ = 0;
  cpus_.clear();
  if (node.HasMember("cpus") && node["cpus"].IsArray()) {
    const rapidjson::Value& arr = node["cpus"];
    uint64_t maxIndex = 0;
    std::vector<uint64_t> indexes;
    for (rapidjson::SizeType i = 0; i < arr.Size(); ++i) {
      if (!arr[i].IsUint64()) {
        throw std::runtime_error("Config of Local executor require uint64 for cpus list");
      }
      uint64_t cpu = arr[i].GetUint64();
      indexes.push_back(cpu);
      if (cpu > maxIndex) {
        maxIndex = cpu;
      }
    }
    cpus_.assign(maxIndex, false);
    for (auto const& index : indexes) {
      cpus_[index] = true;
    }
  } else if (node.HasMember("maxCPU") && node["maxCPU"].IsUint64()){
    maxCPU_ = GetOrDefault<uint64_t>(node, "maxCPU", defaultLocalConfig.maxCPU_);
    cpus_.assign(maxCPU_, true);
  } else {
    cpus_.assign(1, true);
  }
  scriptPath_ = std::filesystem::canonical(
      GetOrDefault<std::string>(node, "scriptPath", defaultLocalConfig.scriptPath_))
      .string();
  runPath_ = std::filesystem::canonical(
      GetOrDefault<std::string>(node, "runPath", defaultLocalConfig.runPath_))
      .string();
}

void ns_Executor::LocalConfig::DoSave(rapidjson::Value& node, 
    rapidjson::MemoryPoolAllocator<>& alloc) const {
  if (maxCPU_ > 0) {
    node.AddMember("maxCPU", maxCPU_, alloc);
  } else {
    rapidjson::Value cpuArray(rapidjson::kArrayType);
    for (size_t i = 0; i < cpus_.size(); ++i) {
      if (cpus_[i]) {
        cpuArray.PushBack(static_cast<uint64_t>(i), alloc);
      }
    }
    node.AddMember("CPU", cpuArray, alloc);
  }
  node.AddMember("scriptPath", 
      rapidjson::Value(scriptPath_.c_str(), alloc), alloc);
  node.AddMember("runPath", 
      rapidjson::Value(runPath_.c_str(), alloc), alloc);
}