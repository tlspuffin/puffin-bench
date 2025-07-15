#include "config.hxx"
#include "../../utils/rapidjson.hxx"

#include "embeded/executor_sh.h"
#include "embeded/get_file_sh.h"

#include <iostream>
#include <fstream>
#include <tuple>
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

void ns_Executor::LocalConfig::Validate() const {
  auto discard = std::filesystem::canonical(scriptPath_);
  discard = std::filesystem::canonical(runPath_);
  for(auto const& [ file, data, size ] : { 
      std::tuple{ "executor.sh", Executor_Script_data, Executor_Script_size }, 
      std::tuple{ "get_file.sh", GetFile_Script_data, GetFile_Script_size }
    }) {
    std::filesystem::path filePath = 
        std::filesystem::weakly_canonical(scriptPath_ / file);
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
}

void ns_Executor::LocalConfig::DoLoad(rapidjson::Value const& node) {
  maxCPU_ = 0;
  cpus_.clear();
  if (node.HasMember("core") && node["core"].IsArray()) {
    const rapidjson::Value& arr = node["core"];
    uint64_t maxIndex = 0;
    std::vector<uint64_t> indexes;
    for (rapidjson::SizeType i = 0; i < arr.Size(); ++i) {
      if (!arr[i].IsUint64()) {
        throw std::runtime_error("Config of Local executor require uint64 in core list");
      }
      uint64_t cpu = arr[i].GetUint64();
      indexes.push_back(cpu);
      if (cpu > maxIndex) {
        maxIndex = cpu;
      }
    }
    cpus_.assign(maxIndex+1, false);
    for (auto const& index : indexes) {
      cpus_[index] = true;
    }
  } else if (node.HasMember("maxCPU") && node["maxCPU"].IsUint64()){
    maxCPU_ = GetOrDefault<uint64_t>(node, "maxCPU", defaultLocalConfig.maxCPU_);
    cpus_.assign(maxCPU_, true);
  } else {
    cpus_.assign(1, true);
  }
  scriptPath_ = std::filesystem::weakly_canonical(
      GetOrDefault<std::string>(node, "scriptPath", defaultLocalConfig.scriptPath_))
      .string();
  runPath_ = std::filesystem::weakly_canonical(
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
    node.AddMember("core", cpuArray, alloc);
  }
  node.AddMember("scriptPath", 
      rapidjson::Value(scriptPath_.c_str(), alloc), alloc);
  node.AddMember("runPath", 
      rapidjson::Value(runPath_.c_str(), alloc), alloc);
}