#pragma once

#include <filesystem>
#include <rapidjson/document.h>

namespace ns_Analyze {

class Config {
public:
  std::filesystem::path dataPath_;
  std::filesystem::path analyzeTools_;

  Config();
  void Load(std::string const& name, rapidjson::Value& doc);
  void Save(std::string const& name, rapidjson::Value& doc,
      rapidjson::MemoryPoolAllocator<>& alloc) const;
  void Validate() const;
};

};
