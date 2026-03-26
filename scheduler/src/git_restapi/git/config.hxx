#pragma once
#include <cstdint>
#include <string>
#include <vector>
#include <filesystem>
#include <rapidjson/document.h>

namespace ns_GIT {

struct Config {
  std::filesystem::path scriptsPath_;
  std::filesystem::path storage_;
  std::vector<std::pair<std::string, std::string>> repositories_;
  std::filesystem::path tmpStorage_;

  Config(std::filesystem::path const& tmpStorage);
  void Load(std::string const& name, rapidjson::Value& doc);
  void Save(std::string const& name, rapidjson::Value& doc, 
      rapidjson::MemoryPoolAllocator<>& alloc) const;
  void Validate(bool forceInstall) const;
};

};