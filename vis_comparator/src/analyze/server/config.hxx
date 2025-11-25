#pragma once
#include <cstdint>
#include <string>
#include <filesystem>
#include <rapidjson/document.h>

namespace ns_Server {

struct Config {
  uint16_t port_;
  bool secure_;
  std::filesystem::path key_;
  std::filesystem::path cert_;
  std::filesystem::path CA_;
  std::filesystem::path html_;

  Config();
  void Load(std::string const& name, rapidjson::Value& doc);
  void Save(std::string const& name, rapidjson::Value& doc, 
      rapidjson::MemoryPoolAllocator<>& alloc) const;
  void Validate() const;
};

};