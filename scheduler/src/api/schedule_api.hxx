#pragma once

#include "../schedule/schedule.hxx"

namespace ns_API {

class ScheduleAPI {
public:
  ScheduleAPI(ns_Schedule::Config const& config);

  uint64_t AddTask(std::vector<uint8_t> const& flow, 
      std::vector<uint8_t> const & functions, 
      std::unordered_map<std::string, std::vector<uint8_t>>& files);
  bool CancelTask(uint64_t task_id);
  void GetRunningTaskSummary();
  void GetTaskInfos(uint64_t task_id);
  std::filesystem::path ExportPath();

private:
  ns_Schedule::Config const& config_;
  ns_Schedule::Schedule schedule_;
};

inline std::filesystem::path ScheduleAPI::ExportPath() {
  return config_.exportPath_;
}

};