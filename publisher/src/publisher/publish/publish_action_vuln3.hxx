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
  PublishActionVuln3(
      std::string const& relativePath, std::string const& name, std::string const& filesFilter) 
      : PublishAction(relativePath, name, filesFilter) {}
  bool Analyze(std::string taskResultsFile, PublishAction::TaskAnalysis& analysis, 
      std::unordered_map<std::string, struct LibSummary>& libSummaries);
  bool GenerateCommitJson(PublishAction::TaskAnalysis const& analysis, 
      std::unordered_map<std::string, struct LibSummary> const& libSummaries,
      std::filesystem::path const& outputPath, std::string& outFile, 
      std::unordered_set<std::string>& libsManaged);
  bool Run(std::filesystem::path const& inputPath, std::filesystem::path const& outputPath, 
      std::string& outFile, std::unordered_set<std::string>& libsManaged) {
    outFile = "";
    libsManaged.clear();
    if (targets_.find(inputPath) == targets_.end()) {
      return false;
    }
    PublishActionVuln3::TaskAnalysis analyze;
    std::unordered_map<std::string, struct LibSummary> libSummaries;
    if (!Analyze(inputPath, analyze, libSummaries)) {
      return false;
    }
    return GenerateCommitJson(analyze, libSummaries, outputPath, outFile, libsManaged);
  };
};

};