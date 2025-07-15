#pragma once

#include <cstdint>
#include <list>
#include <filesystem>

namespace ns_Schedule {

class Step;

class Task {
public:
  uint64_t id_;
  std::filesystem::path files_path_;
  std::filesystem::path functions_path_;
  std::filesystem::path run_root_path_;
  std::list<ns_Schedule::Step *> root_steps_;
};

};