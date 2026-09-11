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
      ns_System::Linux& os, uint16_t serverPort);

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
  bool CancelOrDeleteTask(uint64_t taskID);
  bool TaskUpdatePriority(uint64_t taskID, int64_t newPriority);
  bool TaskUpdateArgs(uint64_t taskID, std::unordered_map<std::string, std::string>& newArgs);
  bool GetTaskData(std::string const& taskID, std::string& fileStateJSON, std::string& fileArtefacts);
  bool GetTaskFinalData(std::string const& taskID, std::string& fileStateJSON, std::string& fileArtefacts) const;

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

inline bool ScheduleAPI::CancelOrDeleteTask(uint64_t taskID) {
  return schedule_.CancelTask(taskID, "rest api request") || schedule_.DeleteTaksDone(taskID);
}

inline bool ScheduleAPI::TaskUpdatePriority(uint64_t taskID, int64_t newPriority) {
  return schedule_.TaskUpdatePriority(taskID, newPriority);
}

inline bool ScheduleAPI::TaskUpdateArgs(uint64_t taskID, 
    std::unordered_map<std::string, std::string>& newArgs) {
  return schedule_.TaskUpdateArgs(taskID, newArgs);
}

inline bool ScheduleAPI::GetTaskData(std::string const& taskID, 
    std::string& fileStateJSON, std::string& fileArtefacts) {
  return schedule_.GetTaskData(taskID, fileStateJSON, fileArtefacts);
}

inline bool ScheduleAPI::GetTaskFinalData(std::string const& taskID, 
    std::string& fileStateJSON, std::string& fileArtefacts) const {
  return schedule_.GetTaskFinalData(taskID, fileStateJSON, fileArtefacts);
}

};
