#pragma once

#include "step_configurations.hxx"
#include "publish.hxx"
#include <cstdint>
#include <iostream>
#include <list>
#include <unordered_map>
#include <filesystem>
#include <fstream>
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

  std::unordered_map<std::string, std::string> args_;

  StepConfigurations configurations_;

  std::unordered_map<ns_Executor::Executor*, ns_Executor::ExecutorTaskData*> 
      executors_;

  std::list<ns_Schedule::Step*> root_steps_;

  std::ofstream steps_file_;

  bool request_cancel_;

  Publish publish_;

  Task(uint64_t id, std::string const& name, 
      std::filesystem::path const& inDataPath, 
      std::filesystem::path const& functionsFile, 
      std::filesystem::path const& toolsFolders, 
      std::filesystem::path const& runRootPath, 
      std::unordered_map<std::string, std::string>& args, 
      rapidjson::Value const* publishConfiguration, 
      rapidjson::Value const* configurations);
  Task(rapidjson::Value const& config, 
      ns_Schedule::Schedule const* schedule, 
      std::list<ns_Schedule::Step*>& stepsPending, 
      std::list<ns_Schedule::Step*>& stepsRunning, 
      std::list<ns_Schedule::Step*>& stepsDone);
  ~Task();

  bool PrepareToRun();

  void FinalizeAndArchive(std::filesystem::path const& savePath);

  void ToJSON(rapidjson::Value& out, 
      rapidjson::Document::AllocatorType& alloc, 
      ns_Schedule::Step const* step) const;

private:
  bool CreateRunFolders();

  static std::unordered_map<std::string, std::string> 
  LoadGlobalParameters(std::filesystem::path const& file);
  static void SaveGlobalParameters(
      std::unordered_map<std::string, std::string> const& parameters, 
      std::filesystem::path const& file);
};

};
