#pragma once
#include <filesystem>
#include <string>
#include <rapidjson/document.h>

namespace ns_Cache {

struct Config {
  std::filesystem::path storagePath_;
  std::filesystem::path mappingFile_;
  Config();
  void Load(std::string const& name, rapidjson::Value& doc);
  void Save(std::string const& name, rapidjson::Value& doc, 
      rapidjson::MemoryPoolAllocator<>& alloc) const;
  void Validate();
};

};