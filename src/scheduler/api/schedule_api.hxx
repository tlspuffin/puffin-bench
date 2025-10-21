#pragma once

#include "../utils/file.hxx"
#include <cstdint>
#include <vector>
#include <unordered_map>
#include <sstream>
#include <fstream>

namespace ns_Schedule {
enum OutputState { UNKNOWN, POSSIBLE_MORE_DATA };
};

namespace ns_API {

class ScheduleAPI {
public:
  ScheduleAPI();

  uint64_t AddTask(std::string const& name, 
      std::vector<uint8_t> const& flow, 
      std::vector<uint8_t> const & functions, 
      std::unordered_map<std::string, std::vector<uint8_t>>& files,
      std::unordered_map<std::string, std::string>& args);
  void GetRunningTaskSummary();
  void GetTaskInfos(uint64_t task_id);
  std::filesystem::path ExportPath();
  ns_Schedule::OutputState GetOutput(std::string const& type, 
    std::string const& taskID, uint64_t stepUUID, std::string const& stepID, 
    size_t readSize, ssize_t readOffset, struct FileExtractedText& data);
  bool CancelStep(uint64_t taskID, uint64_t stepID);
  bool CancelTask(uint64_t taskID);

private:
};

inline std::filesystem::path ScheduleAPI::ExportPath() {
  return "";
}

inline bool ScheduleAPI::CancelStep(uint64_t taskID, uint64_t stepUUID) {
  return true;
}

inline bool ScheduleAPI::CancelTask(uint64_t taskID) {
  return true;
}

};
