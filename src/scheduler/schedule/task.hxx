#pragma once

#include "step_configurations.hxx"
#include "publish.hxx"
#include <cstdint>
#include <iostream>
#include <list>
#include <unordered_map>
#include <filesystem>
#include <fstream>
#include <mutex>
#include <rapidjson/document.h>

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

  std::unordered_map<std::string, std::string> args_;

  StepConfigurations configurations_;

  std::list<ns_Schedule::Step*> root_steps_;

  std::ofstream steps_file_;

  bool request_cancel_;

  Publish publish_;

  std::mutex metadata_index_lock_;

  Task(uint64_t id, std::string const& name, 
      rapidjson::Value const& configJSON, 
      std::filesystem::path const& inDataPath, 
      std::filesystem::path const& functionsFile, 
      std::filesystem::path const& toolsFolders, 
      std::filesystem::path const& runRootPath, 
      std::unordered_map<std::string, std::string>& args);
  Task(rapidjson::Value const& config, 
      std::list<ns_Schedule::Step*>& stepsPending, 
      std::list<ns_Schedule::Step*>& stepsRunning, 
      std::list<ns_Schedule::Step*>& stepsDone);
  ~Task();

  void Cancel();

  bool PrepareToRun();

  void FinalizeAndArchive(std::filesystem::path const& savePath);

  void ToJSON(rapidjson::Value& out, 
      rapidjson::Document::AllocatorType& alloc, 
      ns_Schedule::Step const* step) const;

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
