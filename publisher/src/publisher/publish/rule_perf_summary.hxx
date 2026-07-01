#pragma once
#include "rule.hxx"
#include "rule_perf_summary/generate_perf_zst.hxx"
#include <unordered_map>

namespace ns_Publish {

class RulePerfUseSummary : public Rule {
public:
  RulePerfUseSummary() : Rule(), folder_() {}
  RulePerfUseSummary(std::string const& name, std::string const& rulePath, 
      std::string const& ruleRelativePath, std::string const& filesFilter, 
      rapidjson::Value::ConstObject const& parameters);

  bool Apply(std::string const& file, std::filesystem::path const& outPath, 
      uint64_t& timestamp, std::string& outFile, std::unordered_set<std::string>& libsManaged, 
      bool generateArtefact);

protected:
  RulePerfUseSummary(std::string const& name, std::string const& rulePath, 
      std::string const& ruleRelativePath, std::string const& filesFilter, 
      rapidjson::Value::ConstObject const& parameters, std::string const& type, 
      std::filesystem::path const& folder, bool checkIDMatchFeature);

  bool BuildJSON(std::string const& taskDataFile, std::filesystem::path const& outputPath, 
      std::string& outFile, std::unordered_set<std::string>& libsManaged);
  virtual std::filesystem::path OutputName(TaskAnalysis const& analysis) const;

  std::string type_;
  std::filesystem::path folder_;
  bool checkIDMatchFeature_;
};

};
