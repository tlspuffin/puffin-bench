#pragma once

#include <string>
#include <filesystem>
#include <rapidjson/document.h>

namespace ns_Publish {

class Config {
public:
  Config(bool forceInstall);
  void Load(std::string const& name, rapidjson::Value& doc);
  void Save(std::string const& name, rapidjson::Value& doc, 
      rapidjson::MemoryPoolAllocator<>& alloc) const;
  void Validate() const;

  std::filesystem::path storage_;
  std::filesystem::path weboutput_;
  uint64_t orphanScanInterval_;
  std::filesystem::path tmpPath_;
  bool forceInstall_;
};

};
