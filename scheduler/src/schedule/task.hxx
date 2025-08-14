#pragma once

#include "step_configurations.hxx"
#include "publisher.hxx"
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

class Step;

class Task {
public:
  uint64_t id_;
  std::filesystem::path files_path_;
  std::filesystem::path functions_path_;
  std::filesystem::path run_root_path_;
  std::unordered_map<std::string, std::string> args_;
  Publisher publisher_;

  std::filesystem::path logs_path_;
  std::filesystem::path env_path_;
  std::filesystem::path outputs_path_;

  StepConfigurations configurations_;

  std::list<ns_Schedule::Step*> root_steps_;

  std::unordered_map<ns_Executor::Executor*, ns_Executor::ExecutorTaskData*> 
      executors_;

  std::ofstream steps_file_;

  Task(uint64_t id, 
    std::filesystem::path const& inDataPath, 
    std::filesystem::path const& functionsFile, 
    std::filesystem::path const& runRootPath, 
    std::unordered_map<std::string, std::string>& args, 
    rapidjson::Value const* publisherConfiguration, 
    rapidjson::Value const* configurations);
  ~Task();

  bool PrepareToRun();

  void FinalizeAndArchive(std::filesystem::path const& savePath);

  void ToJSON(rapidjson::Value& out, 
    rapidjson::Document::AllocatorType& alloc, 
    ns_Schedule::Step const* step) const;

private:
  bool CreateRunFolders();
  std::unordered_map<std::string, std::string> 
      ReadGlobalParameters(std::filesystem::path const& envFile);
  std::string ResolveVariables(std::string const& pattern, 
    std::unordered_map<std::string, std::string> const& taskVariables);
};

};
