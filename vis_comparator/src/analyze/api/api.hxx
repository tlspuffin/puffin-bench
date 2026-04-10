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

  std::vector<std::string> GetCommits(std::string const& type) {
    return dataManager_.Commits(type);
  }

  std::vector<std::pair<std::string, uint64_t>> 
      GetCommitSubjects(std::string const& type, std::string const& commitID) {
    return dataManager_.CommitSubjects(type, commitID);
  }

  struct ns_Analyze::DataManager::SMetricsSummaries GetCommitMetrics(
      std::string const& type, std::string const& commitID, 
      std::string const& subject) {
    return dataManager_.CommitMetrics(type, commitID, subject);
  }

  std::unordered_map<std::string, std::vector<struct ns_Analyze::DataManager::SMetricValues>> GetCommitValues(
      std::string const& type, std::string const& commitID, 
      std::string const& subject, uint64_t min, uint64_t max, 
      uint64_t step, std::vector<uint64_t>& runs,
      std::vector<uint64_t> const& clients,
      std::vector<std::string> const& metrics, std::string const& aggregate) {
    std::unordered_map<std::string, std::vector<struct ns_Analyze::DataManager::SMetricValues>> data = dataManager_.CommitValues(
        type, commitID, subject, min, max, step, runs, clients, metrics, aggregate);
    uint64_t resultOffset = 0;
    std::vector<uint64_t> indexes(runs.size());
     std::vector<std::string> metricsRequired = metrics;
    for(std::string const& metric: metricsRequired) {
      auto const it = data.find(metric);
      if (it == data.end() || it->second.empty()) {
        continue;
      }
      bool acrossRun = metric.find("global.") == 0;
      if (acrossRun && (runs.size() < 2)) {
        continue;
      } else {
        acrossRun = it->second.size() == runs.size();
      }

      data.merge(ns_Analyze::Statistics::ComputeStats(metric, it->second, acrossRun ? nullptr : &runs));
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
