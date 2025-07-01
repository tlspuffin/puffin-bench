#pragma once
#include "executor/config.hxx"
#include <string>
#include <cstdint>
#include <unordered_map>
#include <filesystem>

namespace ns_Schedule {

struct Config {
  std::filesystem::path exportPath_;
  std::filesystem::path userPath_;
  std::unordered_map<std::string, ns_Executor::Config*> executors_;
};

};