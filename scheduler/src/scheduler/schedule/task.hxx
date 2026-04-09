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
      std::map<std::string, std::string> md5, 
      ns_Executor::ExecutorsProvider const& executorsProvider);
  Task(rapidjson::Value const& config, 
      std::unordered_map<std::string, PublisherConfig> const& publishersConfig, 
      ns_Executor::ExecutorsProvider const& executorsProvider, 
      std::list<ns_Schedule::Step*>& stepsPending, 
      std::list<ns_Schedule::Step*>& stepsRunning, 
      std::list<ns_Schedule::Step*>& stepsDone);
  ~Task();

  void Cancel(std::string const& source);

  bool PrepareToRun();

  struct ArchiveJob FinalizeAndArchive(std::filesystem::path const& savePath);

  void ToJSON(rapidjson::Value& out, 
      rapidjson::Document::AllocatorType& alloc, 
      ns_Schedule::Step const* step) const;

  struct ns_Schedule::SRessourcesSummary UpdateStats(std::vector<ns_Schedule::Step*> steps);

private:
  bool CreateRunFolders();

  void CreateStepsFromJson(rapidjson::Value const& configJSON);

  std::list<ns_Schedule::Step*> steps_;

  static std::unordered_map<std::string, std::string> 
  LoadGlobalParameters(std::filesystem::path const& file);
  static void SaveGlobalParameters(
      std::unordered_map<std::string, std::string> const& parameters, 
      std::filesystem::path const& file);
};

};
