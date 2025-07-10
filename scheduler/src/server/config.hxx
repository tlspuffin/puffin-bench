#pragma once
#include <cstdint>
#include <string>
#include <rapidjson/document.h>

namespace ns_Server {

struct Config {
  uint16_t port_;
  bool secure_;
  std::string key_;
  std::string cert_;
  std::string CA_;
  Config();
  void Load(std::string const& name, rapidjson::Value& doc);
  void Save(std::string const& name, rapidjson::Value& doc, 
      rapidjson::MemoryPoolAllocator<>& alloc) const;
};

};