#pragma once

#include "config.hxx"
#include "../../system/linux.hxx"
#include "../../../utils/file.hxx"
#include <string>
#include <list>
#include <unordered_map>
#include <rapidjson/document.h>

namespace ns_Schedule {
  class Task;
  class Step;
}

namespace ns_Executor {

class ExecutorData {
public:
  virtual ~ExecutorData();
  virtual void ToJSON(rapidjson::Value& out, 
    rapidjson::Document::AllocatorType& alloc) const = 0;
};

inline ExecutorData::~ExecutorData() {}

class ExecutorTaskData {
public:
  virtual ~ExecutorTaskData();
  virtual void ToJSON(rapidjson::Value& out, 
    rapidjson::Document::AllocatorType& alloc) const = 0;
};

inline ExecutorTaskData::~ExecutorTaskData() {}

class Executor {
public:
  struct OSLoad {
    int8_t memory = -1;
    int8_t cores = -1;
    std::vector<int8_t> perCores;
    uint64_t freeMemory;
    uint64_t totalMemory;
    std::unordered_map<std::string, std::pair<uint64_t, uint64_t>> storages;
  };

  static Executor* Build(ns_Executor::Config* config, uint16_t cachePort, ns_System::Linux& os);
  virtual ~Executor();

  std::string Name() const;

  virtual bool TaskPrepareToRun(ns_Schedule::Task* task) = 0;
  virtual bool TaskFinalize(ExecutorTaskData* data) = 0;

  virtual std::list<ns_Schedule::Step*> FindRunnableSteps(std::list<ns_Schedule::Step*> const& tasks) = 0;
  virtual void Execute(ns_Schedule::Step& step) = 0;
  virtual std::list<ns_Schedule::Step*> CheckFinishedSteps(std::list<ns_Schedule::Step*>& runningSteps) = 0;
  virtual void Shutdown(ns_Schedule::Step& step) = 0;
  virtual void GatherFilesToLocal(ns_Schedule::Step& step) = 0;
  virtual void CheckReloadRunning(ns_Schedule::Step& step) = 0;

  virtual void GetRunningOutput(ns_Schedule::Step const& step, 
      std::string const& type, struct FileExtractedText& data) const = 0;

  virtual ExecutorTaskData* CreateLocalTaskData(rapidjson::Value const& config) const = 0;
  virtual ExecutorData* CreateLocalData(rapidjson::Value const& config) const = 0;

  virtual std::pair<bool, bool> LimitsState() = 0;
  virtual std::pair<int8_t, int8_t> UpdateTaskStats(ExecutorTaskData* data, std::vector<ns_Executor::ExecutorData*> stepsData) const = 0;
  virtual void UpdateStepStats(ExecutorData* data) const = 0;
  virtual void ToJSON(rapidjson::Value &root, rapidjson::MemoryPoolAllocator<>& alloc) const = 0;

protected:
  Executor(std::string const& name);

private:
  std::string name_;
};

inline Executor::Executor(std::string const& name)
    : name_(name)
{}

inline Executor::~Executor() {}

inline std::string Executor::Name() const {
  return name_;
}

};
