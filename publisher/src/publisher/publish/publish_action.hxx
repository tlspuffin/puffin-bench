#pragma once
#include "file.hxx"
#include "../../utils/dir.hxx"
#include "../../utils/rapidjson.hxx"
#include <string>
#include <cstdint>
#include <vector>
#include <unordered_map>
#include <filesystem>
#include <regex>
#include <unordered_set>
#include <iostream>
#include <rapidjson/document.h>

namespace ns_Publish {

class PublishAction {
public:
  struct ExperimentResult {
    std::string id;
    std::string state;
    std::string user_run_state;
    uint64_t duration_ms;
    uint64_t attempt;
    uint64_t exit_code;
  };
  struct TaskAnalysis {
    std::string task_infos;
    std::string task_data;
    std::string commit_id;
    std::string task_name;
    uint64_t task_id;
    std::vector<ExperimentResult> experiments;
    std::string date;
    std::string global_status;
  };

  PublishAction();
  PublishAction(std::string const& basePath, 
      std::string const& relativePath, std::string const& name, 
      std::string const& filesFilter, std::string const& finalTrigger);
  virtual ~PublishAction();
  std::string Name() const;
  std::string ProjectRelativePath() const;
  std::string FinalTrigger() const;
  virtual bool CopyRemote() const;
  bool RegisterPath(std::string const& relativePath, std::string const& absolutePath);
  TaskAnalysis ExtractExperimentsFromFile(std::string const& jsonTaskFile, 
      std::string const& taskDataFileName);
  TaskAnalysis ExtractExperimentsFromBuffer(std::string const& jsonTaskBuffer, 
      std::filesystem::path taskInfos, std::filesystem::path taskData);

  virtual bool CheckRule(std::vector<File>& inputFiles) = 0;
  virtual bool Process(std::vector<File> const& inputFiles, 
      std::filesystem::path const& destPath, std::filesystem::path const& outputPath, 
      std::string& outFile, std::unordered_set<std::string>& libsManaged) = 0;
  bool Run(std::vector<File>& inputFiles,  std::filesystem::path const& destPath, 
      std::filesystem::path const& outputPath, std::string& outFile, 
      std::unordered_set<std::string>& libsManaged);

  static PublishAction* Build(std::string const& basePath, std::string const& relativePath, 
      std::string const& action, std::string const& name, std::string const& onFiles, 
      std::string const& finalTrigger);

protected:
  std::string const name_;
  std::string const basePath_;
  std::string const relativePath_;
  std::regex const filesFilter_;
  std::string const debugFilesFilter_;
  std::unordered_set<std::string> targets_;
  std::string const finalTrigger_;

  static bool UpdateJSON(std::string const& jsonPath, 
    rapidjson::Document& newJSON, std::unordered_set<std::string>& libsManaged);

private:
  static std::unordered_set<std::string> MergeResults(
    rapidjson::Document& lastResults, rapidjson::Document const& newResults);
};

inline PublishAction::~PublishAction() {}

inline std::string PublishAction::Name() const {
  return name_;
}

inline std::string PublishAction::ProjectRelativePath() const {
  return relativePath_;
}

inline std::string PublishAction::FinalTrigger() const {
  return finalTrigger_;
}

inline bool PublishAction::CopyRemote() const {
  return true;
}

inline bool PublishAction::RegisterPath(std::string const& projectRelativePath, std::string const& absolutePath) {
  if (!IsSubDir(relativePath_, projectRelativePath)) {
    return false;
  }
  std::string ruleRelativePath = std::filesystem::relative(projectRelativePath, relativePath_);
  if (!std::regex_match(ruleRelativePath, filesFilter_)) {
    //std::cerr << ruleRelativePath << " does not match " << debugFilesFilter_ << '\n';
    return false;
  }
  targets_.insert(absolutePath);
  return true;
}

inline bool PublishAction::Run(std::vector<File>& inputFiles, 
    std::filesystem::path const& destPath, std::filesystem::path const& outputPath, 
    std::string& outFile, std::unordered_set<std::string>& libsManaged) {
  outFile = "";
  libsManaged.clear();
  return (targets_.find(inputFiles.back().AbsolutePath()) != targets_.end()) && 
      CheckRule(inputFiles) && Process(inputFiles, destPath, outputPath, outFile, libsManaged);
}

};
