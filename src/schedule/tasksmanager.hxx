#pragma once

#include "config.hxx"
#include "task.hxx"
#include "step.hxx"
#include <mutex>
#include <rapidjson/document.h>

namespace ns_Schedule {

class TasksManager {
public:
  TasksManager(ns_Schedule::Config const& config);

  ns_Schedule::Task* CreateTask(
      rapidjson::Value const& rootJSON, std::string const& functionsPath, 
      std::unordered_map<std::string, std::vector<uint8_t>>& files, 
      std::string const& defaultExecutor, 
      std::unordered_map<std::string, ns_Executor::Executor*>& executors);
  void DeleteTask(ns_Schedule::Task* task);
  void DeleteTasks();
  void TaskEnded(ns_Schedule::Task* task);

  void SaveStatus() const;
  void ReadSavedStatus();

private:
  ns_Schedule::Config const& config_;
  std::mutex lock_;
  uint64_t next_task_id_;
  std::list<ns_Schedule::Task*> tasks_;

  void DeleteTaskInternal(ns_Schedule::Task* task);
  std::list<ns_Schedule::Step*> CreateStepsFromJson(
      rapidjson::Value const& root, ns_Schedule::Task* task, 
      std::string const& defaultExecutor, 
      std::unordered_map<std::string, ns_Executor::Executor*>& executors);
  std::list<ns_Schedule::Step*> CreateRetrySteps(ns_Schedule::Step* base_step, 
      uint64_t& run_id);
  std::list<ns_Schedule::Step*> ConfigureStep(ns_Schedule::Step* step, 
      uint64_t step_id, uint64_t rank_id, uint64_t& run_id, 
      std::list<ns_Schedule::Step*>& parent_stack, std::string const& defaultExecutor, 
      std::unordered_map<std::string, ns_Executor::Executor*>& executors);
};

};