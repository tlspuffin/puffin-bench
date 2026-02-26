#pragma once
#include "publish_action.hxx"

namespace ns_Publish {

class PublishActionVuln2 : public PublishAction {
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
  PublishActionVuln2() : PublishAction() {}
  PublishActionVuln2(std::string const& basePath, std::string const& relativePath, 
      std::string const& name, std::string const& filesFilter) 
      : PublishAction(basePath, relativePath, name, filesFilter) {}
  bool Analyze(std::vector<std::filesystem::path>& inputFiles, PublishAction::TaskAnalysis& experiments, 
      std::unordered_map<std::string, struct LibSummary>& libSummaries);
  bool GenerateCommitJson(PublishAction::TaskAnalysis const& analysis, 
      std::unordered_map<std::string, struct LibSummary> const& libSummaries, 
      std::filesystem::path const& outputPath, std::string& outFile, 
      std::unordered_set<std::string>& libsManaged);
  bool Run(std::vector<std::filesystem::path>& inputFiles, std::filesystem::path const& outputPath, 
      std::string& outFile, std::unordered_set<std::string>& libsManaged) {
    outFile = "";
    libsManaged.clear();
    if (targets_.find(inputFiles.back()) == targets_.end()) {
      return false;
    }
    PublishAction::TaskAnalysis analyze;
    std::unordered_map<std::string, struct LibSummary> libSummaries;
    if (!Analyze(inputFiles, analyze, libSummaries)) {
      return false;
    }
    return GenerateCommitJson(analyze, libSummaries, outputPath, outFile, libsManaged);
  };
};

};