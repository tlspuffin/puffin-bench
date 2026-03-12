#pragma once
#include "publish_action.hxx"
#include <unordered_map>

namespace ns_Publish {

class PublishActionVuln : public PublishAction {
private:
  struct LibSummary {
    int cputs;
    int success_count;
    int total_runs;
    std::vector<uint64_t> success_durations_ms;
    std::vector<uint64_t> fail_durations_ms;
    LibSummary() : cputs(0), success_count(0), total_runs(0) {}
  };

public:
  PublishActionVuln() : PublishAction() {}
  PublishActionVuln(std::string const& basePath, std::string const& relativePath, 
      std::string const& name, std::string const& filesFilter, std::string const& finalTrigger) 
      : PublishAction(basePath, relativePath, name, filesFilter, finalTrigger) {}
  bool Analyze(std::string const& inputFiles, std::string const& dataTaskFile, 
      PublishAction::TaskAnalysis& experiments,
      std::unordered_map<std::string, LibSummary>& libSummaries);
  bool GenerateCommitJson(PublishAction::TaskAnalysis const& analysis, 
      std::unordered_map<std::string, LibSummary> const& libSummaries,
      std::filesystem::path const& outputPath, std::string& outFile, 
      std::unordered_set<std::string>& libsManaged);
  bool CheckRule(std::vector<File>& inputFiles);
  bool Process(std::vector<File> const& inputFiles, 
      std::filesystem::path const& destPath, std::filesystem::path const& outputPath, 
      std::string& outFile, std::unordered_set<std::string>& libsManaged);
};

inline bool PublishActionVuln::CheckRule(std::vector<File>& inputFiles) {
  File dataFile = std::filesystem::path(inputFiles.back().AbsolutePath()).replace_extension("tgz");
  return dataFile.Exist() && (inputFiles.insert(inputFiles.end()-1, dataFile), true);
}

inline bool PublishActionVuln::Process(std::vector<File> const& inputFiles, 
    std::filesystem::path const& destPath, std::filesystem::path const& outputPath, 
    std::string& outFile, std::unordered_set<std::string>& libsManaged) {
  if (inputFiles.size() < 2) {
    return false;
  }
  PublishAction::TaskAnalysis analyze;
  std::unordered_map<std::string, struct LibSummary> libSummaries;
  std::filesystem::path taskJSONFile = inputFiles[inputFiles.size() - 2].AbsolutePath();
  std::filesystem::path taskDataFile = inputFiles.back().AbsolutePath();
  return taskDataFile.extension() == ".tgz" && taskJSONFile.extension() == ".json" &&
      Analyze(taskJSONFile, taskDataFile, analyze, libSummaries) && 
      GenerateCommitJson(analyze, libSummaries, outputPath, outFile, libsManaged);

}

};
