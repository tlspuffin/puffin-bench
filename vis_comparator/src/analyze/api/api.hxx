#pragma once

#include "../analyze/config.hxx"
#include "../analyze/data_manager.hxx"
#include "../analyze/statistics.hxx"
#include <memory>
#include <unordered_set>

namespace ns_API {

class AnalyzeAPI {
public:
  AnalyzeAPI(ns_Analyze::Config const& config)
      : dataManager_(config)
  {}

  std::vector<ns_Analyze::DataManager::SCommitInfo> GetCommits(std::string const& type) {
    return dataManager_.Commits(type);
  }

  std::vector<std::pair<uint64_t, std::string>> GetRuns(std::string const& commit) {
    return dataManager_.Runs(commit);
  }

  std::vector<ns_Analyze::DataManager::RunEntry> GetCampaigns() {
    return dataManager_.Campaigns();
  }

  std::string GetRunTag(std::string const& type, std::string const& commitID,
      uint64_t timestamp) {
    return dataManager_.RunTag(type, commitID, timestamp);
  }

  std::vector<std::pair<std::string, uint64_t>>
      GetCommitSubjects(std::string const& type, std::string const& commitID,
      uint64_t timestamp) {
    return dataManager_.CommitSubjects(type, commitID, timestamp);
  }

  struct ns_Analyze::DataManager::SMetricsSummaries GetCommitMetrics(
      std::string const& type, std::string const& commitID,
      uint64_t timestamp, std::string const& subject) {
    return dataManager_.CommitMetrics(type, commitID, timestamp, subject);
  }

  std::unordered_map<std::string, std::vector<struct ns_Analyze::DataManager::SMetricValues>> GetCommitValues(
      std::string const& type, std::string const& commitID, uint64_t timestamp,
      std::string const& subject, uint64_t min, uint64_t max,
      uint64_t step, std::vector<uint64_t>& runs,
      std::vector<uint64_t> const& clients,
      std::vector<std::string> const& metrics) {
    std::unordered_map<std::string, std::vector<struct ns_Analyze::DataManager::SMetricValues>> data = dataManager_.CommitValues(
        type, commitID, timestamp, subject, min, max, step, runs, clients, metrics);
    for(std::string const& metric: metrics) {
      auto const it = data.find(metric);
      if (it == data.end() || it->second.empty()) {
        continue;
      }
      // Pool every client-run into a single distribution for mean/CI.
      data.merge(ns_Analyze::Statistics::ComputeStats(metric, it->second, nullptr));
    }
    return data;
  }

private:
  ns_Analyze::DataManager dataManager_;
};

struct APIS {
  ns_API::AnalyzeAPI analyzeAPI_;

  APIS(ns_Analyze::Config const& configAnalyze)
      : analyzeAPI_(configAnalyze) {}
};

};
