#pragma once

#include "config.hxx"
#include "step.hxx"
#include "tasksmanager.hxx"
#include <vector>
#include <list>
#include <string>
#include <mutex>
#include <thread>
#include <rapidjson/document.h>

namespace ns_Schedule {

class Schedule {
public:
  Schedule(ns_Schedule::Config const& config);
  ~Schedule();
  uint64_t AddTask(std::string const& tasksList, 
      std::string const& functions, std::vector<std::string> files);

private:
  void ScheduleLoop();
  pid_t Execute(ns_Schedule::Step* step);
  void ProcessDelayedCleanup(std::list<ns_Schedule::Step*>& steps, std::list<ns_Schedule::Step*>& delayedSteps);
  void ManageEndOfStep(std::list<ns_Schedule::Step*>& steps, ns_Schedule::Step* step);

  static void DeleteTask(ns_Schedule::Step* rootStep);
  static std::list<ns_Schedule::Step*> SearchTaskToRun(uint64_t nbCPUsFree, std::list<ns_Schedule::Step*>& task);

  ns_Schedule::TasksManager tasksManager_;

  std::string script_path_;
  std::string run_path_;

  uint64_t maxCPU_;
  std::mutex lockThread_;
  std::thread thread_;
  bool threadRunning_;
  std::list<ns_Schedule::Step*> tasks_;
  std::list<ns_Schedule::Step*> steps_;
};

};