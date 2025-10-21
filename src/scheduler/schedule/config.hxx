#pragma once
#include "executor/config.hxx"
#include <string>
#include <cstdint>
#include <unordered_map>
#include <filesystem>
#include <string>
#include <rapidjson/document.h>

namespace ns_Schedule {

struct Config {
  std::filesystem::path toolsPath_;
  std::filesystem::path runPath_;
  std::filesystem::path exportPath_;
  std::filesystem::path userPath_;
  std::unordered_map<std::string, ns_Executor::Config*> executors_;

  Config();
  ~Config();
  void Load(std::string const& name, rapidjson::Value& doc);
  void Save(std::string const& name, rapidjson::Value& doc, 
      rapidjson::MemoryPoolAllocator<>& alloc) const;
  void Validate() const;
};

};
