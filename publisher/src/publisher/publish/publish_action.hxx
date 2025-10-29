#pragma once
#include <string>
#include <cstdint>
#include <vector>
#include <unordered_map>
#include <filesystem>
#include <regex>
#include <unordered_set>

namespace ns_Publish {

class PublishAction {
public:
  struct ExperimentResult {
    std::string id;
    std::string state;
    uint64_t duration_ms;
    uint64_t attempt;
    uint64_t exit_code;
  };
  struct LibSummary {
    int success_count;
    int total_runs;
    std::vector<uint64_t> success_durations_ms;
    std::vector<uint64_t> fail_durations_ms;
  };
  struct TaskAnalysis {
    std::string commit_id;
    std::string task_name;
    uint64_t task_id;
    std::vector<ExperimentResult> experiments;

    std::unordered_map<std::string, LibSummary> libs_summary;
    std::string date;
    std::string global_status;
  };

  PublishAction();
  PublishAction(std::string const& name, std::string const& filesFilter);
  virtual ~PublishAction();
  bool RegisterPath(std::string const& relativePath, std::string const& absolutePath);
  TaskAnalysis ExtractExperiments(std::string const& jsonTaskFile);
  virtual bool Run(std::filesystem::path const& inputPath, std::filesystem::path const& outputPath) = 0;
  static PublishAction* Build(std::string const& action, std::string const& name, std::string const& onFiles);
protected:
  std::string name_;
  std::regex filesFilter_;
  std::unordered_set<std::string> targets_;
};

inline PublishAction::~PublishAction() {}

inline bool PublishAction::RegisterPath(std::string const& relativePath, std::string const& absolutePath) {
  if (!std::regex_match(relativePath, filesFilter_)) {
    return false;
  }
  targets_.insert(absolutePath);
  return true;
}

};