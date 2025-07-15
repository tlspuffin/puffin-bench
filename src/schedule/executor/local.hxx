#pragma once

#include "executor.hxx"
#include <cstdint>
#include <vector>

namespace ns_Executor {

class LocalData : public ExecutorData {
public:
  void ToJSON(rapidjson::Value& out, 
    rapidjson::Document::AllocatorType& alloc) const;

  pid_t pid_;
  std::filesystem::path run_root_path_;
};

class Local : public Executor {
public:
  Local(std::string const& name, ns_Executor::LocalConfig const& config);
  ~Local();

  std::list<ns_Schedule::Step*> FindRunnableSteps(std::list<ns_Schedule::Step*> const& tasks) const;
  void Execute(ns_Schedule::Step& step);
  std::list<ns_Schedule::Step*> CheckFinishedSteps(std::list<ns_Schedule::Step*>& runningSteps);
  void Shutdown(ns_Schedule::Step& step, bool wait =false);
  void FinalClean(std::filesystem::path const& savePath, ns_Schedule::Task& task);

private:
  ns_Executor::LocalConfig const& config_;
  uint64_t nbCPUsFree_;
  std::vector<bool> cpusFree_;
  uint64_t nbChild_;

  std::vector<uint64_t> AssignCPU(uint64_t nbCPU);
  void ReleaseCPU(std::vector<uint64_t>& cpus);
  void CreateRunFolders(std::filesystem::path const& path);
  static bool PinCoreToProcess(std::vector<uint64_t> const& cores_);
};

inline Local::~Local() {}

};