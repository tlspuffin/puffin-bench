#pragma once

#include "step.hxx"
#include <atomic>

namespace ns_Schedule {

class TasksManager {
public:
  TasksManager(std::string const& run_path);
  std::list<ns_Schedule::Step*> ReadJsonConfig(const rapidjson::Value& root);
  void DeleteTask(ns_Schedule::Step* rootStep);

private:
  std::string run_path_;
  std::atomic<uint64_t> next_task_id_;

  std::list<ns_Schedule::Step*> CreateRetrySteps(ns_Schedule::Step* base_step);
};

};