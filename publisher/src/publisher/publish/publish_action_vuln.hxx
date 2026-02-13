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
  PublishActionVuln(std::string const& relativePath, std::string const& name, 
      std::string const& filesFilter) 
      : PublishAction(relativePath, name, filesFilter) {}
  bool Analyze(std::string jsonTaskFile, PublishAction::TaskAnalysis& experiments,
      std::unordered_map<std::string, LibSummary>& libSummaries);
  bool GenerateCommitJson(PublishAction::TaskAnalysis const& analysis, 
      std::unordered_map<std::string, LibSummary> const& libSummaries,
      std::filesystem::path const& outputPath, std::string& outFile, 
      std::unordered_set<std::string>& libsManaged);
  bool Run(std::filesystem::path const& inputPath, std::filesystem::path const& outputPath, 
    std::string& outFile, std::unordered_set<std::string>& libsManaged) {
    outFile = "";
    libsManaged.clear();
    if (targets_.find(inputPath) == targets_.end()) {
      return false;
    }
    PublishAction::TaskAnalysis analyze;
    std::unordered_map<std::string, LibSummary> libSummaries;
    if (!Analyze(inputPath, analyze, libSummaries)) {
      return false;
    };
    return GenerateCommitJson(analyze, libSummaries, outputPath, outFile, libsManaged);
  };
};

};