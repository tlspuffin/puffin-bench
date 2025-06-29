#pragma once
#include <string>
#include <cstdint>

namespace ns_Schedule {

struct Config {
  uint64_t maxCPU_;
  std::string userPath_;  
  std::string scriptPath_;
  std::string runPath_;
};

};