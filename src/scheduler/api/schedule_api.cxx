#include "schedule_api.hxx"

ns_API::ScheduleAPI::ScheduleAPI()
{
}

uint64_t ns_API::ScheduleAPI::AddTask(std::string const& name, 
    std::vector<uint8_t> const& flow, 
    std::vector<uint8_t> const& functions, 
    std::unordered_map<std::string, std::vector<uint8_t>>& files, 
    std::unordered_map<std::string, std::string>& args) {
  std::string flowStr(flow.begin(), flow.end());
  std::string functionstr(functions.begin(), functions.end());
  return 0;
}

void ns_API::ScheduleAPI::GetRunningTaskSummary() {
}

void ns_API::ScheduleAPI::GetTaskInfos(uint64_t task_id) {
}

ns_Schedule::OutputState ns_API::ScheduleAPI::GetOutput(
    std::string const& type, std::string const& taskID, uint64_t stepUUID, 
    std::string const& stepID, size_t readSize, ssize_t readOffset, 
    struct FileExtractedText& data) {
  return ns_Schedule::OutputState::UNKNOWN;
}
