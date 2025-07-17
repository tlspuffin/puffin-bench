#pragma once

#include <cstdint>
#include <iostream>
#include <list>
#include <unordered_map>
#include <filesystem>

namespace ns_Executor {
  class Executor;
  class ExecutorTaskData;
}

namespace ns_Schedule {

class Step;

class Task {
public:
  uint64_t id_;
  std::filesystem::path files_path_;
  std::filesystem::path functions_path_;
  std::filesystem::path run_root_path_;
  std::list<ns_Schedule::Step *> root_steps_;

  ~Task();
  void FinalClean(std::filesystem::path const& savePath);
  std::unordered_map<ns_Executor::Executor*, ns_Executor::ExecutorTaskData*> 
      executors_;
};

};