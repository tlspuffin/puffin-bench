#pragma once

#include "config.hxx"
#include "step.hxx"
#include "tasksmanager.hxx"
#include "archiver.hxx"
#include "executor/executors_provider.hxx"
#include "executor/executor.hxx"
#include "monitor/monitor.hxx"
#include "../system/linux.hxx"
#include "../../utils/file.hxx"
#include <vector>
#include <list>
#include <string>
#include <mutex>
#include <thread>
#include <unordered_map>
#include <rapidjson/document.h>

namespace ns_Schedule {

class Schedule : public ns_Executor::ExecutorsProvider {
public:
  Schedule(ns_Schedule::Config const& config, ns_System::Linux& os, uint16_t cachePort);
  ~Schedule();
  uint64_t AddTask(std::string const& name, std::string const& tasksList, 
      std::string const& functions, 
      std::unordered_map<std::string, std::vector<uint8_t>>& files,
      std::unordered_map<std::string, std::string>& args);
  bool CancelStep(uint64_t taskID, uint64_t stepUUID);
  bool CancelTask(uint64_t taskID);

  ns_Executor::Executor* GetExecutor(std::string const& name) const;
  void GetOutput(
      std::string const& type, std::string const& taskID,
      uint64_t stepUUID, std::string const& stepID, 
      struct FileExtractedText& data);

private:
  void ScheduleLoop();
  std::list<ns_Schedule::Step*> SearchTasksToRun();
  bool ProcessDelayedCleanup(std::list<ns_Schedule::Step*>& delayedSteps, 
      std::ofstream& stepsDoneFile);
  void ManageEndOfStep(ns_Schedule::Step* step, std::ofstream& stepsDoneFile);
  void ExportRunningSteps(
      std::string const& filename, std::list<ns_Schedule::Step*> const& steps) const;
  void SaveStatus(bool exportRunningSteps);
  static void AppendStepToFinishLog(std::ofstream& log, ns_Schedule::Step const& step);

  ns_Schedule::Config const& config_;
  std::filesystem::path exportPath_;

  ns_Schedule::TasksManager tasksManager_;

  std::mutex lockThread_;
  std::thread thread_;
  bool threadRunning_;
  std::list<ns_Schedule::Step*> steps_;
  std::list<ns_Schedule::Step*> stepsRunning_;
  std::list<ns_Schedule::Step*> stepsDone_;
  std::string defaultExecutor_;
  std::unordered_map<std::string, ns_Executor::Executor*> executors_;

  ns_Monitor::Monitor monitor_;

  Archiver archiver_;

  ns_System::Linux& os_;

  static bool shutdownTasksAtExit__;
  static void HandlerUSR1(int sig);
  static int InstallSigUSRHandler();
};

};
