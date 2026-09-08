#pragma once

#include "step_configurations.hxx"
#include "publish.hxx"
#include "archiver.hxx"
#include "ressources_summary.hxx"
#include "executor/executors_provider.hxx"
#include "executor/executor.hxx"
#include "../system/linux.hxx"
#include <cstdint>
#include <iostream>
#include <list>
#include <map>
#include <unordered_map>
#include <filesystem>
#include <fstream>
#include <mutex>
#include <rapidjson/document.h>

namespace ns_Executor {
  class Executor;
  class ExecutorTaskData;
}

namespace ns_Schedule {

class Schedule;
class Step;

class Task {
public:
  uint64_t id_;
  std::string name_;
  std::filesystem::path files_path_;
  std::filesystem::path functions_path_;
  std::filesystem::path tools_path_;
  std::filesystem::path run_root_path_;
  std::filesystem::path logs_path_;
  std::filesystem::path env_path_;
  std::filesystem::path outputs_path_;
  std::filesystem::path artefacts_path_;
  std::filesystem::path monitors_path_;

  std::unordered_map<std::string, std::string> args_;

  StepConfigurations configurations_;

  std::string executor_name_;
  ns_Executor::Executor* executor_;
  ns_Executor::ExecutorTaskData* executor_data_;

  std::list<ns_Schedule::Step*> root_steps_;

  std::ofstream steps_file_;

  std::string user_;
  std::string job_type_;

  bool request_cancel_;
  std::string cancel_source_;

  Publish publish_;

  std::map<std::string, std::string> md5_;

  enum class State { 
    Pending, 
    Running, 
    Done, 
    Cancelled, 
  } state_;
  std::string publish_link_;
  std::string flag_;

  std::string apiURL_;

  int64_t priority_;

  uint64_t estimatedEndTime_;

  std::string launcher_;

  std::mutex metadata_index_lock_;

  Task(uint64_t id, std::string const& name, 
      rapidjson::Value const& configJSON, 
      std::filesystem::path const& inDataPath, 
      std::filesystem::path const& functionsFile, 
      std::filesystem::path const& toolsFolders, 
      std::filesystem::path const& runRootPath, 
      std::filesystem::path const& monitorsRootPath, 
      std::unordered_map<std::string, PublisherConfig> const& publishersConfig, 
      std::unordered_map<std::string, std::string>& args, 
      std::string const& user, std::string const& jobType, 
      std::map<std::string, std::string> md5, std::string apiURL, 
      ns_Executor::ExecutorsProvider const& executorsProvider);
  Task(rapidjson::Value const& config, 
      std::unordered_map<std::string, PublisherConfig> const& publishersConfig, 
      ns_Executor::ExecutorsProvider const& executorsProvider, 
      std::list<ns_Schedule::Step*>& stepsPending, 
      std::list<ns_Schedule::Step*>& stepsRunning, 
      std::list<ns_Schedule::Step*>& stepsDone);
  ~Task();

  void Cancel(std::string const& source);

  void Execute(ns_Schedule::Step* step, bool uniqueStep);
  bool PrepareToRun();

  struct ArchiveJob FinalizeAndArchive(std::filesystem::path const& savePath);

  void ToJSON(rapidjson::Value& out, 
      rapidjson::Document::AllocatorType& alloc, 
      ns_Schedule::Step const* step);

  struct ns_Schedule::SRessourcesSummary UpdateStats(std::vector<ns_Schedule::Step*> steps);

  rapidjson::Value FlagJSON(rapidjson::Document::AllocatorType& alloc) const;

  bool AllOtherStepsProcessedAfterCancel(ns_Schedule::Step* step) const;

  void UpdateArgs(std::unordered_map<std::string, std::string>& newArgs);
  void ApplyPendingArgs();

private:
  bool CreateRunFolders();
  bool DeleteRunFolders();

  void CreateStepsFromJson(rapidjson::Value const& configJSON);

  void Destroy();

  bool IsPending() const;

  rapidjson::Value StringToJSON(rapidjson::Document::AllocatorType& alloc, std::string const& data) const;

  std::list<ns_Schedule::Step*> steps_;

  std::mutex argsMutex_;
  std::unordered_map<std::string, std::string> argsToUpdate_;

  static std::unordered_map<std::string, std::string> 
  LoadGlobalParameters(std::filesystem::path const& file);
  static void SaveGlobalParameters(
      std::unordered_map<std::string, std::string> const& parameters, 
      std::filesystem::path const& file);

  static std::string StateEnumToString(ns_Schedule::Task::State state);
  static State StateStringToEnum(std::string const& state);
};

inline rapidjson::Value Task::FlagJSON(rapidjson::Document::AllocatorType& alloc) const {
  return StringToJSON(alloc, flag_);
}

inline rapidjson::Value Task::StringToJSON(rapidjson::Document::AllocatorType& alloc, std::string const& data) const  {
  rapidjson::Document doc;
  doc.Parse((data.empty() ? "{}" : data).c_str());
  if (doc.HasParseError()) {
    doc.Parse("{}");
  }
  return rapidjson::Value(doc, alloc);
}

inline bool Task::IsPending() const {
  return executor_data_ == nullptr;
}

};
