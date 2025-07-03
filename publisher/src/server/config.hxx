#pragma once
#include <string>
#include <cstdint>

namespace ns_Server {

struct Config {
  uint16_t port_;
  bool secure_;
  std::string key_;
  std::string cert_;
  std::string CA_;
};

};