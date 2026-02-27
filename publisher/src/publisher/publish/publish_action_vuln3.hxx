#pragma once
#include "publish_action.hxx"
#include <unordered_map>
#include <rapidjson/document.h>

namespace ns_Publish {

class PublishActionVuln3 : public PublishAction {
private:
  struct LibSummary {
    int cputs;
    int success_count;
    int total_runs;
    std::vector<uint64_t> success_total_execs;
    std::vector<uint64_t> success_durations_s;
    std::vector<uint64_t> fail_total_execs;
    std::vector<uint64_t> fail_durations_s;
    LibSummary() : cputs(0), success_count(0), total_runs(0) {}
  };

  std::unordered_set<std::string> MergeResults(rapidjson::Document& lastResults, 
      rapidjson::Document const& newResults);

public:
  PublishActionVuln3() : PublishAction() {}
  PublishActionVuln3(std::string const& basePath, std::string const& relativePath, 
      std::string const& name, std::string const& filesFilter) 
      : PublishAction(basePath, relativePath, name, filesFilter) {}
  bool Analyze(std::string const& taskDataFile, std::string const& taskInfoFile, 
      PublishAction::TaskAnalysis& analysis, 
      std::unordered_map<std::string, struct LibSummary>& libSummaries);
  bool GenerateCommitJson(PublishAction::TaskAnalysis const& analysis, 
      std::unordered_map<std::string, struct LibSummary> const& libSummaries,
      std::filesystem::path const& outputPath, std::string& outFile, 
      std::unordered_set<std::string>& libsManaged);
  bool CheckRule(std::vector<std::filesystem::path>& inputFiles);
  bool Process(std::vector<std::filesystem::path> const& inputFiles, 
      std::filesystem::path const& outputPath, std::string& outFile, 
      std::unordered_set<std::string>& libsManaged);
};

inline bool PublishActionVuln3::CheckRule(std::vector<std::filesystem::path>& inputFiles) {
  std::filesystem::path jsonFile = std::filesystem::path(inputFiles.back()).replace_extension("json");
  return std::filesystem::exists(jsonFile) && (inputFiles.insert(inputFiles.end()-1, jsonFile), true);
}

inline bool PublishActionVuln3::Process(std::vector<std::filesystem::path> const& inputFiles, 
    std::filesystem::path const& outputPath, std::string& outFile, 
    std::unordered_set<std::string>& libsManaged) {
  if (inputFiles.size() < 2) {
    return false;
  }
  PublishActionVuln3::TaskAnalysis analyze;
  std::unordered_map<std::string, struct LibSummary> libSummaries;
  std::filesystem::path taskDataFile = inputFiles.back();
  std::filesystem::path taskJSONFile = inputFiles[inputFiles.size() - 2];
  return taskDataFile.extension() == ".tgz" && taskJSONFile.extension() == ".json" &&
      Analyze(taskDataFile, taskJSONFile, analyze, libSummaries) && 
      GenerateCommitJson(analyze, libSummaries, outputPath, outFile, libsManaged);
};

};