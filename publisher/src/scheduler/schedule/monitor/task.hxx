#pragma once

#include <string>
#include <filesystem>
#include <chrono>
#include "rapidjson/document.h"

namespace ns_Monitor {

class Thread;

class Task {
public:
  Task();
  Task(rapidjson::Value const& json);
  std::filesystem::path moduleFile;
  std::filesystem::path rootPath;
  std::string entryPoint;
  std::filesystem::path monitorFile;
  uint64_t delayStartMS;
  uint64_t timeoutS;
  uint64_t intervalS;

  std::chrono::time_point<std::chrono::steady_clock> executionTime;
  std::unique_ptr<Thread> thread;

  void ToJSON(rapidjson::Value& out, 
      rapidjson::Document::AllocatorType& alloc) const; 

  void CreateExecutionTime();
  bool UpdateExecutionTime();

  struct SharedPtrTaskCompare {
    bool operator()(std::shared_ptr<Task> const& lhs,
        std::shared_ptr<Task> const& rhs) const;
  };
};

inline void Task::CreateExecutionTime() {
  executionTime = std::chrono::steady_clock::now() + 
      std::chrono::milliseconds(delayStartMS);
}

inline bool Task::UpdateExecutionTime() {
  executionTime += std::chrono::seconds(intervalS);
  return intervalS != 0;
}

inline bool Task::SharedPtrTaskCompare::operator()(
    std::shared_ptr<Task> const& lhs, std::shared_ptr<Task> const& rhs) const {
  if (lhs->executionTime != rhs->executionTime) {
    return lhs->executionTime < rhs->executionTime;
  }
  return lhs.get() < rhs.get();
}


};