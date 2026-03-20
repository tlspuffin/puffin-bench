#pragma once

#include "config.hxx"
#include "task.hxx"
#include "step.hxx"
#include "../../utils/file.hxx"
#include <mutex>
#include <rapidjson/document.h>

namespace ns_Schedule {

class Schedule;

class TasksManager {
public:
  TasksManager(ns_Schedule::Config const& config);
  ~TasksManager();

  ns_Schedule::Task* CreateTask(std::string const& name, 
      rapidjson::Value const& rootJSON, std::string const& functionsPath, 
      std::unordered_map<std::string, std::vector<uint8_t>>& files, 
      std::unordered_map<std::string, std::string>& args, 
      ns_Schedule::Schedule const& schedule);
  void DeleteTask(ns_Schedule::Task* task);
  void DeleteTasks();
  void TaskEnded(ns_Schedule::Task* task);

  void GetRunningOutput(std::string const& type, 
    uint64_t taskID, uint64_t stepUUID, 
    struct FileExtractedText& data);

  void ToJSON(rapidjson::Value &root, rapidjson::MemoryPoolAllocator<>& alloc);
  std::tuple<std::list<ns_Schedule::Step*>, std::list<ns_Schedule::Step*>, std::list<ns_Schedule::Step*>> 
  LoadStatus(rapidjson::Value const& tasksmanager, ns_Schedule::Schedule const* schedule);

private:
  ns_Schedule::Config const& config_;
  std::mutex lock_;
  uint64_t next_task_id_;
  std::list<ns_Schedule::Task*> tasks_;

  void DeleteTaskInternal(ns_Schedule::Task* task);
  void ToJSONInternal(rapidjson::Value& root, rapidjson::MemoryPoolAllocator<>& alloc) const;
};

inline void ns_Schedule::TasksManager::ToJSON(rapidjson::Value& root, 
    rapidjson::MemoryPoolAllocator<>& alloc) {
  std::lock_guard<std::mutex> lock(lock_);
  ToJSONInternal(root, alloc);
}

};
