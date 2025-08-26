#pragma once

#include "../schedule/schedule.hxx"
#include <sstream>
#include <fstream>

namespace ns_API {

class ScheduleAPI {
public:
  ScheduleAPI(ns_Schedule::Config const& config);

  uint64_t AddTask(std::vector<uint8_t> const& flow, 
      std::vector<uint8_t> const & functions, 
      std::unordered_map<std::string, std::vector<uint8_t>>& files,
      std::unordered_map<std::string, std::string>& args);
  void GetRunningTaskSummary();
  void GetTaskInfos(uint64_t task_id);
  std::filesystem::path ExportPath();
  std::string GetOutput(std::string const& type, 
      std::string const& taskID, std::string const& stepID,
      std::string const& rankID, std::string const& attemptID, 
      size_t readSize, ssize_t readOffset, ns_Schedule::OutputState& state);
  bool CancelStep(uint64_t taskID, uint64_t stepID);
  bool CancelTask(uint64_t taskID);

private:
  ns_Schedule::Config const& config_;
  ns_Schedule::Schedule schedule_;
};

inline std::filesystem::path ScheduleAPI::ExportPath() {
  return config_.exportPath_;
}

inline bool ScheduleAPI::CancelStep(uint64_t taskID, uint64_t stepUUID) {
  return schedule_.CancelStep(taskID, stepUUID);
}

inline bool ScheduleAPI::CancelTask(uint64_t taskID) {
  return schedule_.CancelTask(taskID);
}

};
