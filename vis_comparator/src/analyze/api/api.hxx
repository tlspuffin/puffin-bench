#pragma once

#include "../analyze/config.hxx"
#include "../analyze/data_manager.hxx"
#include "../analyze/statistics.hxx"
#include <filesystem>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <unordered_map>
#include <unordered_set>

namespace ns_API {

// Thrown when a request targets a protocol whose data folder does not exist (or
// whose name is not a valid single path segment). Carries the offending name so
// the handler can build a clear 404 message.
struct UnknownProtocolError : std::runtime_error {
  explicit UnknownProtocolError(std::string const& protocol)
      : std::runtime_error("Unknown protocol '" + protocol + "'"),
        protocol_(protocol) {}
  std::string protocol_;
};

class AnalyzeAPI {
public:
  // Owns its Config: DataManager keeps a `Config const&`, so the config must
  // outlive it. Each protocol gets its own AnalyzeAPI with dataPath_ pointing at
  // that protocol's folder.
  AnalyzeAPI(ns_Analyze::Config config)
      : config_(std::move(config)), dataManager_(config_)
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
      std::vector<std::string> const& metrics, int ciPercent = 95) {
    std::unordered_map<std::string, std::vector<struct ns_Analyze::DataManager::SMetricValues>> data = dataManager_.CommitValues(
        type, commitID, timestamp, subject, min, max, step, runs, clients, metrics);
    for(std::string const& metric: metrics) {
      auto const it = data.find(metric);
      if (it == data.end() || it->second.empty()) {
        continue;
      }
      // Pool every client-run into a single distribution for mean/CI.
      data.merge(ns_Analyze::Statistics::ComputeStats(metric, it->second, nullptr, ciPercent));
    }
    return data;
  }

private:
  // Declared before dataManager_ so it is fully constructed when the DataManager
  // (which stores a reference to it) is built.
  ns_Analyze::Config config_;
  ns_Analyze::DataManager dataManager_;
};

// Holds one AnalyzeAPI per protocol, created lazily on first use. The base config
// carries dataPath_ = the parent folder that holds every protocol's data folder
// (e.g. .../experiments); a protocol's own root is dataPath_ / <protocol>.
struct APIS {
  APIS(ns_Analyze::Config const& baseConfig)
      : baseConfig_(baseConfig) {}

  // Resolves (creating on first request) the AnalyzeAPI for `protocol`. Throws
  // UnknownProtocolError if the name is not a single safe path segment or its
  // data folder does not exist.
  AnalyzeAPI& GetProtocol(std::string const& protocol) {
    if (!IsValidProtocolName(protocol)) {
      throw UnknownProtocolError(protocol);
    }
    std::lock_guard<std::mutex> lk(mutex_);
    auto it = byProtocol_.find(protocol);
    if (it != byProtocol_.end()) {
      return *it->second;
    }
    std::filesystem::path const root = baseConfig_.dataPath_ / protocol;
    std::error_code ec;
    if (!std::filesystem::is_directory(root, ec)) {
      throw UnknownProtocolError(protocol);
    }
    ns_Analyze::Config cfg = baseConfig_;
    cfg.dataPath_ = root;
    auto api = std::make_unique<AnalyzeAPI>(std::move(cfg));
    AnalyzeAPI& ref = *api;
    byProtocol_.emplace(protocol, std::move(api));
    return ref;
  }

  // Cheap existence check used by the static file server (no AnalyzeAPI built).
  bool ProtocolExists(std::string const& protocol) const {
    if (!IsValidProtocolName(protocol)) {
      return false;
    }
    std::error_code ec;
    return std::filesystem::is_directory(baseConfig_.dataPath_ / protocol, ec);
  }

  // A protocol name must be a single non-empty path segment: no separators, no
  // "..", no NUL — it is used verbatim to build filesystem paths.
  static bool IsValidProtocolName(std::string const& name) {
    if (name.empty()) return false;
    if (name.find('\0') != std::string::npos) return false;
    if (name.find('/') != std::string::npos) return false;
    if (name.find('\\') != std::string::npos) return false;
    if (name == "." || name == "..") return false;
    return true;
  }

  ns_Analyze::Config baseConfig_;

private:
  std::mutex mutex_;
  std::unordered_map<std::string, std::unique_ptr<AnalyzeAPI>> byProtocol_;
};

};
