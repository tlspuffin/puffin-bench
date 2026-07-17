#include "rule_campaign_summary.hxx"

ns_Publish::RuleCampaignUseSummary::RuleCampaignUseSummary(std::string const& name, 
    std::string const& rulePath, std::string const& ruleRelativePath, 
    std::string const& filesFilter, rapidjson::Value const& parameters) 
    : RulePerfUseSummary(name, rulePath, ruleRelativePath, "[^/]+/[^/]+/"+filesFilter, parameters, 
    "Campaign", "Campaign", false)
{
  if((!parameters.HasMember("dataPath")) || (!parameters["dataPath"].IsString())) {
    throw std::runtime_error("Required parameter \"dataPath\" for campaign rules");
  }
  dataPath_ = parameters["dataPath"].GetString();
  debugFilesFilter_ = dataPath_.string() + "/" + debugFilesFilter_;
  filesFilter_ = std::regex(debugFilesFilter_);
}

std::filesystem::path ns_Publish::RuleCampaignUseSummary::OutputName(TaskAnalysis const& analysis) const {
  return std::filesystem::path(analysis.user) / 
      (analysis.campaign_id + "-" + std::to_string(analysis.task_id) + ".json");
}
