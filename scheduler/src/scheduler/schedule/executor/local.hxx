#pragma once

#include "executor.hxx"
#include "linux_cores.hxx"
#include <cstdint>
#include <vector>

namespace ns_Executor {

class LocalData : public ExecutorData {
public:
  enum EProcessStatus {
    Internal,
    External,
    External_Running
  };

  LocalData();
  LocalData(rapidjson::Value const& config);
  void ToJSON(rapidjson::Value& out, 
    rapidjson::Document::AllocatorType& alloc) const;

  std::vector<uint64_t> cores_;
  std::filesystem::path run_path_;
  std::filesystem::path artefacts_path_;
  pid_t pid_;

  std::string launcher_file_;
  std::string user_state_file_;
  std::string step_parameters_file_;

  EProcessStatus process_status_;
  std::filesystem::path fatalerror_path_;
  std::filesystem::path done_path_;
  std::vector<std::string> arguments_;
};

class Local : public Executor {
public:
  Local(std::string const& name, ns_Executor::LocalConfig const& config, uint16_t cachePort);
  ~Local();

  std::list<ns_Schedule::Step*> FindRunnableSteps(std::list<ns_Schedule::Step*> const& steps) const;
  void Execute(ns_Schedule::Step& step);
  std::list<ns_Schedule::Step*> CheckFinishedSteps(std::list<ns_Schedule::Step*>& runningSteps);
  void Shutdown(ns_Schedule::Step& step);
  void GatherFilesToLocal(ns_Schedule::Step& step);
  void CheckReloadRunning(ns_Schedule::Step& step);

  enum ns_Schedule::OutputState GetRunningOutput(ns_Schedule::Step const& step, 
      std::string const& type, 
      size_t readSize, ssize_t readOffset, 
      struct FileExtractedText& data) const;

  ExecutorTaskData* CreateLocalTaskData(rapidjson::Value const& config) const;
  ExecutorData* CreateLocalData(rapidjson::Value const& config) const;

private:
  ns_Executor::LocalConfig const& config_;
  ns_Executor::CoresMonitor coresMonitor_;
  uint64_t nbCoresFree_;
  std::vector<bool> coresFree_;
  uint64_t nbChild_;
  uint16_t cachePort_;

  void WaitSessionEnd(pid_t sessionID, ns_Schedule::Step* step, std::string const& label);
  void KillSession(pid_t sessionID, ns_Schedule::Step* step, std::string const& label);

  pid_t RunShutdown(ns_Schedule::Step& step, LocalData* localData);
  void EndRun(ns_Schedule::Step& step, LocalData* localData, bool releaseCores);

  std::vector<uint64_t> AssignCores(uint64_t nbCores);
  void ReAssignCores(std::vector<uint64_t>& cores);
  void ReleaseCores(std::vector<uint64_t>& cores);

  std::vector<std::string> BuildExecutorArgs(ns_Schedule::Step const& step);
  int16_t CheckExternalProcessIsRunning(pid_t pid, 
      std::vector<std::string> const& arguments, 
      std::string const& fatalFile, std::string const& doneFile, 
      std::stringstream& log);
  bool VerifyProcessArgs(pid_t pid, 
      std::vector<std::string> const& expectedArgs);

  static bool PinCoresToProcess(std::vector<uint64_t> const& cores_);
  static void SaveArtefacts(ns_Schedule::Step& step);
};

inline Local::~Local() {}

};
