#pragma once

#include <string>
#include <filesystem>
#include <rapidjson/document.h>

namespace ns_Publish {

class Config {
public:
  Config();
  void Load(std::string const& name, rapidjson::Value& doc);
  void Save(std::string const& name, rapidjson::Value& doc, 
      rapidjson::MemoryPoolAllocator<>& alloc) const;
  void Validate(bool forceInstall) const;

  std::filesystem::path storage_;
  std::filesystem::path html_;
  uint64_t orphanScanInterval_;
};

};
