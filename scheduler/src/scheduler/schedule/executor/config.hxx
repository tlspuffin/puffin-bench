#pragma once
#include <cstdint>
#include <string>
#include <vector>
#include <filesystem>
#include <rapidjson/document.h>

namespace ns_Executor {

struct Config {
  enum Type {
    None,
    Local,
  };
  enum Type type_;
  std::string name_;
  Config(enum Type type, std::string const& name);
  virtual ~Config() {};
  static Config* BuildConfig(std::string const& name, rapidjson::Value const& node);
  void Save(std::string const& name, rapidjson::Value& node, 
      rapidjson::MemoryPoolAllocator<>& alloc) const;
  virtual void Validate(bool forceInstall) const = 0;

protected:
  virtual void DoLoad(rapidjson::Value const& node) = 0;
  virtual void DoSave(rapidjson::Value& node, 
      rapidjson::MemoryPoolAllocator<>& alloc) const = 0;
};

struct LocalConfig : public Config {
  uint64_t nbCores_;
  std::vector<bool> cores_;
  std::filesystem::path scriptPath_;
  uint64_t logsSize_;
  void Validate(bool forceInstall) const;

  LocalConfig(std::string const& name);
  void DoLoad(rapidjson::Value const& node);
  void DoSave(rapidjson::Value& node, 
      rapidjson::MemoryPoolAllocator<>& alloc) const;
};

};