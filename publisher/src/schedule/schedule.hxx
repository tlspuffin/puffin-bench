#pragma once

#include "config.hxx"
#include "step.hxx"
#include "tasksmanager.hxx"
#include "executor/executor.hxx"
#include <vector>
#include <list>
#include <string>
#include <mutex>
#include <thread>
#include <unordered_map>
#include <rapidjson/document.h>

namespace ns_Schedule {

class Schedule {
public:
  Schedule(ns_Schedule::Config const& config);
  ~Schedule();
  uint64_t AddTask(std::string const& tasksList, std::string const& functions, 
      std::unordered_map<std::string, std::vector<uint8_t>>& files,
      std::unordered_map<std::string, std::string>& args);

private:
  void ScheduleLoop();
  std::list<ns_Schedule::Step*> SearchTasksToRun();
  void ProcessDelayedCleanup(std::list<ns_Schedule::Step*>& steps, std::list<ns_Schedule::Step*>& delayedSteps);
  void ManageEndOfStep(std::list<ns_Schedule::Step*>& steps, ns_Schedule::Step* step);
  void ExportRunningSteps(std::string const& filename, std::list<ns_Schedule::Step*> const& steps) const;
  static void AppendStepToFinishLog(std::ofstream& log, ns_Schedule::Step const& step);

  ns_Schedule::Config const& config_;
  std::filesystem::path exportPath_;

  ns_Schedule::TasksManager tasksManager_;

  std::mutex lockThread_;
  std::thread thread_;
  bool threadRunning_;
  std::list<ns_Schedule::Step*> steps_;
  std::string defaultExecutor_;
  std::unordered_map<std::string, ns_Executor::Executor*> executors_;
};

};