#pragma once
#include "../../utils/dir.hxx"
#include <string>
#include <cstdint>
#include <vector>
#include <unordered_map>
#include <filesystem>
#include <regex>
#include <unordered_set>
#include <iostream>

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
      std::string const& filesFilter);
  virtual ~PublishAction();
  std::string Name() const;
  std::string ProjectRelativePath() const;
  bool RegisterPath(std::string const& relativePath, std::string const& absolutePath);
  TaskAnalysis ExtractExperimentsFromFile(std::vector<std::filesystem::path>& jsonTaskFile);
  TaskAnalysis ExtractExperimentsFromBuffer(std::string const& jsonTaskBuffer, 
      std::filesystem::path taskInfos, std::filesystem::path taskData);
  virtual bool Run(std::vector<std::filesystem::path>& inputFiles, 
      std::filesystem::path const& outputPath, std::string& outFile, 
      std::unordered_set<std::string>& libsManaged) = 0;
  static PublishAction* Build(std::string const& basePath, std::string const& relativePath, 
      std::string const& action, std::string const& name, std::string const& onFiles);

protected:
  std::string const name_;
  std::string const basePath_;
  std::string const relativePath_;
  std::regex const filesFilter_;
  std::string const debugFilesFilter_;
  std::unordered_set<std::string> targets_;
};

inline PublishAction::~PublishAction() {}

inline std::string PublishAction::Name() const {
  return name_;
}

inline std::string PublishAction::ProjectRelativePath() const {
  return relativePath_;
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

};