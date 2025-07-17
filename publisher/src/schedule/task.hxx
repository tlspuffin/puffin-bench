#pragma once

#include <cstdint>
#include <iostream>
#include <list>
#include <unordered_map>
#include <filesystem>
#include <rapidjson/document.h>

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
  std::list<ns_Schedule::Step*> root_steps_;
  std::unordered_map<std::string, std::string> args_;

  std::unordered_map<ns_Executor::Executor*, ns_Executor::ExecutorTaskData*> 
      executors_;

  ~Task();
  void FinalClean(std::filesystem::path const& savePath);

  void ToJSON(rapidjson::Value& out, 
    rapidjson::Document::AllocatorType& alloc, 
    ns_Schedule::Step const* step) const;
};

};