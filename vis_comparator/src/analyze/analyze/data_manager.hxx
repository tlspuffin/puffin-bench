#pragma once

#include "config.hxx"
#include "../../utils/file_tar_zst.hxx"
#include <string>
#include <filesystem>
#include <unordered_map>
#include <unordered_set>
#include <map>
#include <vector>
#include <variant>
#include <mutex>
#include <optional>
#include <chrono>
#include <cmath>

#include <iostream>

namespace ns_Analyze {

class DataManager {
public:
  enum class DataType : uint8_t { INT32, UINT32, INT64, UINT64, DOUBLE };
  struct SMetricInfos {
    std::string name_;
    DataType type_;
    size_t nbElement_;
    std::string file_;
  };
  struct SMetricsSummary {
    uint64_t id_;
    uint64_t nbClient_;
    uint64_t runTime_;
    std::vector<std::unordered_map<std::string, struct SMetricInfos>> summary_;
  };
  struct SMetricsSummaries {
    uint64_t nbRun_;
    std::vector<struct SMetricsSummary> runSummary_;
  };
  struct SMetricValues {
    uint64_t runID_;
    uint64_t clientID_;
    std::variant<std::vector<uint64_t>, std::vector<double>> values_;
  };

  // One indexed run (a single .zst archive). The runId is (type, commit, timestamp);
  // `timestamp` is the filename (= task.id) and is globally unique.
  struct RunEntry {
    std::string kind;                  // "commit" | "campaign"
    std::string type;                  // "Perf"/"Vuln" (commit) | "Campaign"
    std::string commit;                // commit hash (commit) | COMMIT_ID (campaign)
    uint64_t timestamp;                // filename stem (= task.id)
    std::string user;                  // task.user ("" when absent)
    std::string campaign;              // campaign name (campaigns; "" otherwise)
    std::filesystem::path relpath;     // zst path w/o extension, relative to rootpath_
    std::vector<std::string> subjects; // keys of the archive top-level metadata.json
    int64_t mtime;                     // .zst last_write_time (cache fingerprint)
    uint64_t size;                     // .zst file size (cache fingerprint)
  };

  // One commit of a given type, with its latest run and how many runs it has.
  struct SCommitInfo {
    std::string commit;
    uint64_t latest;  // newest timestamp of this (type, commit)
    uint64_t count;   // number of runs of this (type, commit)
  };

  DataManager(Config const& config);
  // Re-scans the data root and rebuilds the run index (thread-safe).
  void Refresh();
  // Local commit runs of `type`, each with its latest timestamp and run count.
  std::vector<SCommitInfo> Commits(std::string const& type);
  // Every run of `commit` across all types, as (timestamp, type) pairs, newest
  // first. Type-agnostic: lets the commit picker list all runs regardless of type.
  std::vector<std::pair<uint64_t, std::string>> Runs(std::string const& commit);
  // Snapshot copy of every indexed campaign run.
  std::vector<RunEntry> Campaigns();
  // Runs are addressed by the runId (type, commit, timestamp).
  std::vector<std::pair<std::string, uint64_t>>
      CommitSubjects(std::string const& type, std::string const& commitID,
      uint64_t timestamp);
  struct ns_Analyze::DataManager::SMetricsSummaries CommitMetrics(
      std::string const& type, std::string const& commitID,
      uint64_t timestamp, std::string const& subject);
  std::unordered_map<std::string, std::vector<struct SMetricValues>> CommitValues(
      std::string const& type, std::string const& commitID, uint64_t timestamp,
      std::string const& subject, uint64_t min, uint64_t max,
      uint64_t step, std::vector<uint64_t>& runs,
      std::vector<uint64_t> const& clients,
      std::vector<std::string> const& metrics, std::string const& aggregate);
  // "mtime:size" fingerprint for cache keying ("" if the run is unknown).
  std::string RunTag(std::string const& type, std::string const& commitID,
      uint64_t timestamp);

private:
  struct SInterpolations {
    std::pair<double, double> ratios;
    std::pair<uint64_t, uint64_t> offsets;
  };
  Config const& config_;
  std::filesystem::path const rootpath_;

  // Guards runIndex_ and runsByTriple_ against concurrent reads/refreshes.
  std::mutex mutex_;
  // Last successful index build; debounces the burst of listing calls a single
  // page load triggers (epoch => the first Refresh() always rebuilds).
  std::chrono::steady_clock::time_point lastRefresh_{};
  // Flat list of every indexed run.
  std::vector<RunEntry> runIndex_;
  // runId resolution: type -> commit -> timestamp -> index into runIndex_.
  // std::map keeps timestamps ordered so commit-mode "latest" = rbegin().
  std::unordered_map<std::string,
      std::unordered_map<std::string, std::map<uint64_t, size_t>>> runsByTriple_;

  void BuildIndex();
  // Returns a copy of the resolved run (caller-owned, safe across refreshes).
  std::optional<RunEntry> Resolve(std::string const& type,
      std::string const& commit, uint64_t timestamp);
  // Computes the metrics summary for a subject from an already-open archive.
  struct SMetricsSummaries CommitMetrics(FileTARZST& archive,
      std::string const& subject);

  std::vector<struct SInterpolations> ExtractDataTS(FileTARZST& archive, 
      std::filesystem::path const& prefixPath, 
      struct SMetricInfos const& metricInfos, uint64_t min, uint64_t max, 
      uint64_t step);
  template<typename T>
  std::vector<T> ExtractData(FileTARZST& archive, std::string filename, 
      std::vector<struct ns_Analyze::DataManager::SInterpolations> dataPoints);

};

template<typename T>
inline std::vector<T> DataManager::ExtractData(FileTARZST& archive, 
    std::string filename, std::vector<struct ns_Analyze::DataManager::SInterpolations> dataPoints) {
  std::vector<T> result;
  result.reserve(dataPoints.size());

  std::vector<T> values(4*1024*1024);
  uint64_t fileOffset = 0;
  uint64_t nbElementRead = 0;
  uint64_t lastElement = 0;

  std::vector<uint64_t> inOffset(2);
  std::vector<T> dataPointValues(2);

  for(struct ns_Analyze::DataManager::SInterpolations const& dataPoint: dataPoints) {
    // special code for out of range TS
    if ((dataPoint.ratios.first == 0.0) && (dataPoint.ratios.second == 0.0)) {
      result.push_back(0);
      continue;
    }

    inOffset = { dataPoint.offsets.first, dataPoint.offsets.second };
    for(int i=0; i<2; ++i) {
      uint64_t elementOffset = inOffset[i];
      if (elementOffset >= lastElement) {
        fileOffset = elementOffset;
        nbElementRead = archive.ExtractFileData(filename, values.size() * sizeof(T), 
            fileOffset * sizeof(T), (char*)(values.data()), nullptr) / sizeof(T);
        if (nbElementRead == 0) {
          uint64_t nbMissingElement = result.capacity() - result.size();
          result.insert(result.end(), nbMissingElement, T(0));
          return result;
        }
        if (nbElementRead != values.size()) {
          values.resize(nbElementRead);
        }
        lastElement = fileOffset + values.size();
      }
      dataPointValues[i] = values[elementOffset - fileOffset];
    }
    if (inOffset[0] == inOffset[1]) {
      result.push_back(dataPointValues[0] * dataPoint.ratios.first);
    } else {
      result.push_back(dataPointValues[0] * dataPoint.ratios.first + dataPointValues[1] * dataPoint.ratios.second);
    }
  }

  return result;
}

};
