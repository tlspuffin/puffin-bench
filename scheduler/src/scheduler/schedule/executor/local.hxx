#pragma once
#include <mutex>

#include "executor.hxx"
#include "../../system/linux.hxx"
#include "output_ring.hxx"
#include <cstdint>
#include <vector>

namespace ns_Executor {

class LocalTaskData : public ExecutorTaskData {
public:
  LocalTaskData();
  LocalTaskData(rapidjson::Value const& config);

  void ToJSON(rapidjson::Value& out, 
    rapidjson::Document::AllocatorType& alloc) const;

  std::filesystem::path cgroupPath_;

  int8_t os_memory_load_;
  int8_t os_cores_load_;
  int8_t os_memory_max_load_;
  int8_t os_cores_max_load_;

  std::filesystem::path run_path_;
  std::filesystem::path flag_file_;
};

class LocalData : public ExecutorData {
public:
  enum EProcessStatus {
    Internal,
    External,
    External_Running
  };

  LocalData(uint32_t nbCores);
  LocalData(rapidjson::Value const& config);
  void ToJSON(rapidjson::Value& out, 
    rapidjson::Document::AllocatorType& alloc) const;

  std::vector<uint64_t> cores_;
  std::filesystem::path run_path_;
  std::filesystem::path artefacts_file_;
  pid_t pid_;

  std::string launcher_file_;
  std::string user_state_file_;
  std::string step_parameters_file_;

  EProcessStatus process_status_;
  std::filesystem::path fatalerror_file_;
  std::filesystem::path done_file_;
  std::vector<std::string> arguments_;

  std::filesystem::path cgroup_path_;

  FDCaptureThread fdCaptureThread_;
  int pipeFDOut[2];
  int pipeFDErr[2];

  int8_t os_memory_load_;
  std::vector<int8_t> os_cores_load_;
  int8_t os_memory_max_load_;
  int8_t os_cores_max_load_;
};

class Local : public Executor {
public:
  Local(std::string const& name, ns_Executor::LocalConfig const& config, uint16_t serverPort, 
      ns_System::Linux& os);
  ~Local();

  bool CanRun(ns_Schedule::Step* step) const;

  bool TaskPrepareToRun(ns_Schedule::Task* task);
  bool TaskFinalize(ExecutorTaskData* data, ns_Schedule::Task* task);

  std::list<ns_Schedule::Step*> FindRunnableSteps(std::list<ns_Schedule::Step*> const& steps);
  void EstimatedStepsStartTime(std::list<ns_Schedule::Step*> const& steps) const;
  void Execute(ns_Schedule::Step& step);
  std::list<ns_Schedule::Step*> CheckFinishedSteps(std::list<ns_Schedule::Step*>& runningSteps);
  void Shutdown(ns_Schedule::Step& step);
  void GatherFilesToLocal(ns_Schedule::Step& step);
  void CheckReloadRunning(ns_Schedule::Step& step);

  void GetRunningOutput(ns_Schedule::Step const& step, 
      std::string const& type, struct FileExtractedText& data) const;

  ExecutorTaskData* CreateLocalTaskData(rapidjson::Value const& config) const;
  ExecutorData* CreateLocalData(rapidjson::Value const& config) const;

  std::pair<bool, bool> LimitsState();
  std::pair<int8_t, int8_t> UpdateTaskStats(ExecutorTaskData* data, std::vector<ExecutorData*> stepsData) const;
  void UpdateStepStats(ExecutorData* data) const;
  void ToJSON(rapidjson::Value &root, rapidjson::MemoryPoolAllocator<>& alloc) const;

  void SyncTaskEnvironment(ExecutorTaskData* data) const;
  void UpdateTaskEnvironment(ExecutorTaskData* data);

  bool SetMaxCores(uint64_t maxCores, uint64_t durationSec, std::string& error) override;

private:
  ns_Executor::LocalConfig const& config_;
  ns_System::Linux& os_;
  // cores: in use by the running steps; the maximum for the steps (the default of the configuration, or a temporary
  // one until nbCoresUntilMs_); the cores the executor may use at all (configuration: cores, excludeCores)
  uint64_t nbCoresUsed_;
  uint64_t nbCoresMax_;
  uint64_t nbCoresDefault_ = 0;
  uint64_t nbCoresLimit_ = 0;
  uint64_t nbCoresUntilMs_ = 0;
  // new steps wait: the run and export storage has less than diskMinimumGB free
  bool diskBlocked_ = false;
  uint64_t MinFreeDisk() const;
  uint64_t FreeCores() const { return nbCoresMax_ > nbCoresUsed_ ? nbCoresMax_ - nbCoresUsed_ : 0; }
  void CheckMaxCoresExpiry();
  std::vector<bool> coresFree_;
  uint64_t nbChild_;
  uint16_t serverPort_;
  std::filesystem::path cgroupRoot_;
  int32_t cgroupRootCapabilities_;
  std::string cgroupRootCapabilitiesString_;
  bool cgroupDisableUpdateSliceUser_;
  struct Executor::OSLoad stats_;
  uint8_t cpuMaxLoad_;
  uint64_t memMinAllowed_;
  // The cores bookkeeping, and the user.slice cpuset derived from it, is also updated by the
  // step shutdowns, which run in parallel when the scheduler stops.
  std::mutex coresLock_;

  void WaitSessionEnd(pid_t sessionID, ns_Schedule::Step* step, std::string const& label);
  void KillSession(pid_t sessionID, std::filesystem::path const& cgroupPath, 
      ns_Schedule::Step* step, std::string const& label);
  void KillCGroupSession(std::filesystem::path const& cgroupPath, 
      ns_Schedule::Step* step, std::string const& label);

  // waitpid() with a deadline: kills the session when it expires, so that one
  // unresponsive shutdown script cannot hold the scheduler's stop back for ever.
  pid_t WaitForPidOrKill(pid_t pid, std::filesystem::path const& cgroupPath,
      ns_Schedule::Step* step);

  pid_t RunShutdown(ns_Schedule::Step& step, LocalData* localData);
  void EndRun(ns_Schedule::Step& step, LocalData* localData, bool releaseCores);

  std::vector<uint64_t> AssignCores(uint64_t nbCores);
  void ReAssignCores(std::vector<uint64_t>& cores);
  void ReleaseCores(std::vector<uint64_t>& cores);
  void UpdateUserSliceCpuset();

  std::vector<std::string> BuildExecutorArgs(ns_Schedule::Step const& step);
  int16_t CheckExternalProcessIsRunning(pid_t pid, 
      std::vector<std::string> const& arguments, 
      std::string const& fatalFile, std::string const& doneFile, 
      std::stringstream& log);
  bool VerifyProcessArgs(pid_t pid, 
      std::vector<std::string> const& expectedArgs);

  int32_t DetectCGroupSupport(std::filesystem::path& cgroupRoot, std::string& capabilitiesString) const;
  bool CGroupMemoryUsed(std::filesystem::path const& cgroupMemoryPath, int8_t& usedMemory) const;

  void GatherStats();

  static bool PinCoresToProcess(std::vector<uint64_t> const& cores_);
  static void SaveArtefacts(ns_Schedule::Step& step);
  static uint64_t EstimatedFinishTime(ns_Schedule::Step const* step);
};

};
