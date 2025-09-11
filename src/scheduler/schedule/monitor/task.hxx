#pragma once

#include <string>
#include <filesystem>
#include <chrono>
#include "rapidjson/document.h"

namespace ns_Schedule {
  class Step;
};

namespace ns_Monitor {

class Thread;

class Task {
public:
  std::filesystem::path monitorPath_;

  Task();
  Task(ns_Schedule::Step const* step, rapidjson::Value const& json);

  std::string GetMessage();

  std::string ToArgs();
  void ToJSON(rapidjson::Value& out, 
      rapidjson::Document::AllocatorType& alloc) const; 

private:
  std::string entryPoint_;
  std::string delayStartS_;
  std::string timeoutS_;
  std::string intervalS_;
};

inline std::string ns_Monitor::Task::ToArgs() {
  return entryPoint_ + " " + intervalS_ + " " + timeoutS_ + " " + delayStartS_ + 
      " " + monitorPath_.string();
}

};