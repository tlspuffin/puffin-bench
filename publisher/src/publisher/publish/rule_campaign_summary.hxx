#pragma once

#include "rule_perf_summary.hxx"

namespace ns_Publish {

class RuleCampaignUseSummary : public RulePerfUseSummary {
public:
  RuleCampaignUseSummary() : RulePerfUseSummary() {}
  RuleCampaignUseSummary(std::string const& name, std::string const& rulePath, 
      std::string const& ruleRelativePath, std::string const& filesFilter, 
      rapidjson::Value::ConstObject const& parameters);
  std::filesystem::path DataPath() const;

protected:
  std::filesystem::path OutputName(TaskAnalysis const& analysis) const;

private:
  std::filesystem::path dataPath_;
};

inline std::filesystem::path RuleCampaignUseSummary::DataPath() const {
  return dataPath_;
}

};