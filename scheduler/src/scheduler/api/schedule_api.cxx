#include "schedule_api.hxx"

ns_API::ScheduleAPI::ScheduleAPI(ns_Schedule::Config const& config)
    : config_(config), schedule_(config)
{
}

uint64_t ns_API::ScheduleAPI::AddTask(std::string const& name, 
    std::vector<uint8_t> const& flow, 
    std::vector<uint8_t> const& functions, 
    std::unordered_map<std::string, std::vector<uint8_t>>& files, 
    std::unordered_map<std::string, std::string>& args) {
  std::string flowStr(flow.begin(), flow.end());
  std::string functionstr(functions.begin(), functions.end());
  return schedule_.AddTask(name, flowStr, functionstr, files, args);
}

void ns_API::ScheduleAPI::GetRunningTaskSummary() {
}

void ns_API::ScheduleAPI::GetTaskInfos(uint64_t task_id) {
}

std::string ns_API::ScheduleAPI::GetOutput(
    std::string const& type, std::string const& taskID, std::string const& stepID,
    std::string const& rankID, std::string const& attemptID, size_t readSize, 
    ssize_t readOffset, ns_Schedule::OutputState& state) {
  return schedule_.GetOutput(type, taskID, stepID, rankID, attemptID, 
      readSize, readOffset, state);
}
