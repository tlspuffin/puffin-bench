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
  ScheduleAPI(ns_Schedule::Config const& config, ns_API::UsersAPI& users, 
      ns_System::Linux& os, uint16_t cache_port);

  std::string TaskManagerStateFile() const;
  uint64_t AddTask(std::string const& name, 
      std::vector<uint8_t> const& flow, 
      std::vector<uint8_t> const & functions, 
      std::unordered_map<std::string, std::vector<uint8_t>>& files,
      std::unordered_map<std::string, std::string>& args, 
      std::unordered_map<std::string, std::string>& runtimeConfig, 
      std::string const& user, std::string const& jobType);
  void GetRunningTaskSummary();
  void GetTaskInfos(uint64_t task_id);
  void GetOutput(std::string const& type, 
    std::string const& taskID, uint64_t stepUUID, std::string const& stepID, 
    struct FileExtractedText& data);
  bool CancelStep(uint64_t taskID, uint64_t stepID);
  bool CancelTask(uint64_t taskID);
  bool GetTaskFinalData(std::string const& task_id, std::string& fileStateJSON, std::string& fileArtefacts) const;

private:
  ns_Schedule::Config const& config_;
  ns_Schedule::Schedule schedule_;
};

inline std::string ScheduleAPI::TaskManagerStateFile() const {
  return schedule_.TaskManagerStateFile();
}

inline bool ScheduleAPI::CancelStep(uint64_t taskID, uint64_t stepUUID) {
  return schedule_.CancelStep(taskID, stepUUID);
}

inline bool ScheduleAPI::CancelTask(uint64_t taskID) {
  return schedule_.CancelTask(taskID, "rest api request");
}

inline bool ScheduleAPI::GetTaskFinalData(std::string const& task_id, 
    std::string& fileStateJSON, std::string& fileArtefacts) const {
  return schedule_.GetTaskFinalData(task_id, fileStateJSON, fileArtefacts);
}

};
