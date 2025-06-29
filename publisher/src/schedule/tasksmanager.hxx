#pragma once

#include "config.hxx"
#include "step.hxx"
#include <atomic>

namespace ns_Schedule {

class TasksManager {
public:
  TasksManager(ns_Schedule::Config const& config);

  std::pair<uint64_t, std::list<ns_Schedule::Step*>> CreateTask(
      rapidjson::Value const& rootJSON, std::string const& functionsPath);
  void DeleteTask(ns_Schedule::Step* rootStep);

private:
  ns_Schedule::Config const& config_;
  std::atomic<uint64_t> next_task_id_;

  std::list<ns_Schedule::Step*> CreateStepsFromJson(
      rapidjson::Value const& root, uint64_t task_id, 
      std::string const& functions);
  std::list<ns_Schedule::Step*> CreateRetrySteps(ns_Schedule::Step* base_step);
};

};