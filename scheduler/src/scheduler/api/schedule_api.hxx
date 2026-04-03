#pragma once

#include "../schedule/schedule.hxx"
#include "../../utils/file.hxx"
#include <cstdint>
#include <vector>
#include <unordered_map>
#include <sstream>
#include <fstream>

namespace ns_API {

class ScheduleAPI {
public:
  ScheduleAPI(ns_Schedule::Config const& config, ns_System::Linux& os, uint16_t cache_port);

  uint64_t AddTask(std::string const& name, 
      std::vector<uint8_t> const& flow, 
      std::vector<uint8_t> const & functions, 
      std::unordered_map<std::string, std::vector<uint8_t>>& files,
      std::unordered_map<std::string, std::string>& args, 
      std::unordered_map<std::string, std::string>& runtimeConfig);
  void GetRunningTaskSummary();
  void GetTaskInfos(uint64_t task_id);
  std::filesystem::path ExportPath();
  void GetOutput(std::string const& type, 
    std::string const& taskID, uint64_t stepUUID, std::string const& stepID, 
    struct FileExtractedText& data);
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
  return schedule_.CancelTask(taskID, "rest api request");
}

};
