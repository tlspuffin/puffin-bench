#pragma once

#include "config.hxx"
#include <filesystem>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace ns_Publish {

class Publish {
public:
  Publish(Config const& config);

  bool Notify(std::string const& newPath, std::string& error);
  void StorageScan();

private:
  class StepInfo {
  public:
    std::string name_;
    std::string status_;
    int exit_code_;
    uint64_t duration_ms_;

    struct RunInfo {
        int rank_id_;
        std::unordered_map<std::string, std::string> args_;
        std::string status_;
        int exit_code_;
        uint64_t duration_ms_;
    };
    std::vector<RunInfo> runs_;

    std::vector<int> cores_used_;
    std::filesystem::path stdout_path_;
    std::filesystem::path stderr_path_;
  };
  class ReportInfos {
  public:
    enum class Origin { Normal, Orphan };
    enum class Status { Valid, ParseError };
    std::string commit_id_;
    uint64_t epoch_;
    std::filesystem::path report_path_;
    std::filesystem::path steps_json_path_;

    std::string task_id_;
    uint64_t total_duration_ms_;
    std::vector<StepInfo> steps_;

    Origin origin_;
    Status status_;
    std::string error_message_;
  };

  bool Notify(std::string const& newPath, bool isOrphelin);
  void LoadNotifiedList();
  void SaveNotifiedList();
  bool IsOrphelin(std::filesystem::path const& epoch_dir, std::string const& key) const;
  ReportInfos ParseReport(std::filesystem::path const& fullPath, std::string const& key) const;
  void GenerateStaticHTML() const;
  void GenerateReportCard(std::ofstream& html, 
      std::string const& key, ReportInfos const& info) const;
  void GenerateStepDetails(std::ofstream& html, const std::vector<StepInfo>& steps) const;

  Config const& config_;
  std::unordered_map<std::string, ReportInfos> infos_;
  std::unordered_set<std::string> notifiedKeys_;
};

inline bool Publish::IsOrphelin(
    std::filesystem::path const& epoch_dir, std::string const& key) const {
  return notifiedKeys_.find(key) == notifiedKeys_.end();
}

}
