#include "config.hxx"
#include "linux_cores.hxx"
#include "../../../utils/rapidjson.hxx"

#include "../../../embeded/scheduler/executor_sh.h"
#include "../../../embeded/scheduler/functions_sh.h"

#include <iostream>
#include <fstream>
#include <tuple>
#include <rapidjson/stringbuffer.h>
#include <rapidjson/writer.h>

ns_Executor::Config::Config(enum ns_Executor::Config::Type type, std::string const& name) 
    : type_(type), name_(name)
{}

ns_Executor::Config* ns_Executor::Config::BuildConfig(std::string const& name, rapidjson::Value const& node) {
  enum Type type = (enum Type)GetOrDefault<int>(node, "type", 
      (int)Config::Type::Local);
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
    : Config(Config::Type::Local, name), nbCores_(1), cores_(), 
    scriptPath_("scripts"), logsSize_(16*1024*1024)
{
  CoresStats coresStats;
  uint64_t maxNbCores = coresStats.NbCores();
  cores_.assign(maxNbCores, true);
  if (maxNbCores > 1) {
    cores_[0] = false;
  }
}

void ns_Executor::LocalConfig::Validate(bool forceInstall) const {
  CoresStats coresStats;
  uint64_t maxNbCores = coresStats.NbCores();
  if ((cores_.size() > maxNbCores) || ((nbCores_ > maxNbCores))) {
    throw std::runtime_error("Config of Local executor requires more cores than system have (" + 
        std::to_string(maxNbCores) + ")");
  }
  auto discard = std::filesystem::canonical(scriptPath_);
  for(auto const& [ file, data, size ] : { 
      std::tuple{ "executor.sh", Executor_Script_data, Executor_Script_size },
      std::tuple{ "functions.sh", Functions_Script_data, Functions_Script_size },
    }) {
    std::filesystem::path filePath = 
        std::filesystem::weakly_canonical(scriptPath_ / file);
    if (forceInstall || (!std::filesystem::exists(filePath))) {
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
  nbCores_ = 0;
  cores_.clear();
  CoresStats coresStats;
  if (node.HasMember("cores") && node["cores"].IsArray()) {
    const rapidjson::Value& arr = node["cores"];
    std::vector<uint64_t> indexes;
    for (rapidjson::SizeType i = 0; i < arr.Size(); ++i) {
      if (!arr[i].IsUint64()) {
        throw std::runtime_error("Config of Local executor require uint64 in cores list");
      }
      uint64_t coreIndex = arr[i].GetUint64();
      indexes.push_back(coreIndex);
    }
    cores_.assign(coresStats.NbCores(), false);
    for (auto const& index : indexes) {
      cores_[index] = true;
    }
  } else if (node.HasMember("excludeCores") && node["excludeCores"].IsArray()) {
    uint64_t maxNbCores = coresStats.NbCores();
    cores_.assign(maxNbCores, true);

    if (node.HasMember("nbCores") && node["nbCores"].IsUint64()) {
      nbCores_ = GetOrDefault<uint64_t>(node, "nbCores", defaultLocalConfig.nbCores_);
    } else {
      nbCores_ = maxNbCores;
    }

    const rapidjson::Value& arr = node["excludeCores"];
    for (rapidjson::SizeType i = 0; i < arr.Size(); ++i) {
      if (!arr[i].IsUint64()) {
        throw std::runtime_error("Config of Local executor require uint64 in cores list");
      }
      uint64_t coreIndex = arr[i].GetUint64();
      if (coreIndex >= maxNbCores) {
        throw std::runtime_error("Config of Local executor requires more cores than system have (" + 
            std::to_string(maxNbCores) + ")");
      }
      cores_[coreIndex] = false;
    }
  } else {
    uint64_t maxNbCores = coresStats.NbCores();
    nbCores_ = 1;
    cores_.assign(maxNbCores, true);
    if (maxNbCores > 1) {
      cores_[0] = false;
    }
  }
  scriptPath_ = std::filesystem::weakly_canonical(
      GetOrDefault<std::string>(node, "scriptPath", defaultLocalConfig.scriptPath_))
      .string();
  logsSize_ = GetOrDefault(node, "logsSize", defaultLocalConfig.logsSize_);
}

void ns_Executor::LocalConfig::DoSave(rapidjson::Value& node, 
    rapidjson::MemoryPoolAllocator<>& alloc) const {
  if (nbCores_ > 0) {
    node.AddMember("nbCores", nbCores_, alloc);
    rapidjson::Value coresArray(rapidjson::kArrayType);
    for (size_t i = 0; i < cores_.size(); ++i) {
      if (!cores_[i]) {
        coresArray.PushBack(static_cast<uint64_t>(i), alloc);
      }
    }
    node.AddMember("excludeCores", coresArray, alloc);
  } else {
    rapidjson::Value coresArray(rapidjson::kArrayType);
    for (size_t i = 0; i < cores_.size(); ++i) {
      if (cores_[i]) {
        coresArray.PushBack(static_cast<uint64_t>(i), alloc);
      }
    }
    node.AddMember("cores", coresArray, alloc);
  }
  node.AddMember("scriptPath", 
      rapidjson::Value(scriptPath_.c_str(), alloc), alloc);
  node.AddMember("logsSize", logsSize_, alloc);
}