#pragma once
#include "rule.hxx"
#include <unordered_map>

namespace ns_Publish {

class RuleVuln3 : public Rule {
private:
  struct LibSummary {
    int cputs;
    int success_count;
    int total_runs;
    std::vector<uint64_t> success_total_execs;
    std::vector<uint64_t> success_durations_s;
    std::vector<uint64_t> fail_total_execs;
    std::vector<uint64_t> fail_durations_s;
    std::vector<std::string> fail_comment;
    LibSummary() : cputs(0), success_count(0), total_runs(0) {}
  };
  std::filesystem::path folder_;

public:
  RuleVuln3() : Rule(), folder_() {}
  RuleVuln3(std::string const& name, std::string const& rulePath, 
      std::string const& ruleRelativePath, std::string const& filesFilter, 
      rapidjson::Value const& parameters);
  
  bool Apply(std::string const& file, std::filesystem::path const& outPath, 
      uint64_t& timestamp, std::string& outFile, std::unordered_set<std::string>& libsManaged, 
      bool generateArtefact);
  
protected:
  bool BuildSummary(std::string const& taskDataFile, Rule::TaskAnalysis& analysis, 
      std::unordered_map<std::string, struct LibSummary>& libSummaries);
  bool BuildJSON(Rule::TaskAnalysis const& analysis, 
      std::unordered_map<std::string, struct LibSummary> const& libSummaries,
      std::filesystem::path const& outputPath, std::string& outFile, 
      std::unordered_set<std::string>& libsManaged);
};

inline bool RuleVuln3::Apply(std::string const& file, std::filesystem::path const& outPath, 
    uint64_t& timestamp, std::string& outFile, std::unordered_set<std::string>& libsManaged, 
    bool generateArtefact) {
  try {
    timestamp = std::stoull(std::filesystem::path(file).stem());
  } catch(...) {
    LOGE << "Unable to get timestamp from " << file << Log::Flags::End;
    return false;
  }
  Rule::TaskAnalysis summary;
  std::unordered_map<std::string, struct LibSummary> libSummaries;     
  bool success = BuildSummary(file, summary, libSummaries) && 
      BuildJSON(summary, libSummaries, outPath, outFile, libsManaged);
  if ((!generateArtefact) && (!success)) {
    throw std::runtime_error("Unable to generate informations for " + file);
  }
  return success;
}

};
