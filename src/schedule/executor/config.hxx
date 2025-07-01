#pragma once
#include <cstdint>
#include <string>
#include <filesystem>

namespace ns_Executor {

struct Config {
  virtual ~Config() {};
};

struct LocalConfig : public Config {
  uint64_t maxCPU_;
  std::filesystem::path scriptPath_;
  std::filesystem::path runPath_;
};

};