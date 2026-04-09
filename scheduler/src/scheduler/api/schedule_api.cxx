#include "schedule_api.hxx"

ns_API::ScheduleAPI::ScheduleAPI(ns_Schedule::Config const& config, ns_API::UsersAPI& users, 
    ns_System::Linux& os, uint16_t cache_port)
    : config_(config), schedule_(config, users, os, cache_port)
{
}

uint64_t ns_API::ScheduleAPI::AddTask(std::string const& name, 
    std::vector<uint8_t> const& flow, 
    std::vector<uint8_t> const& functions, 
    std::unordered_map<std::string, std::vector<uint8_t>>& files, 
    std::unordered_map<std::string, std::string>& args, 
    std::unordered_map<std::string, std::string>& runtimeConfig, 
    std::string const& user, std::string const& jobType) {
  std::string flowStr(flow.begin(), flow.end());
  std::string functionstr(functions.begin(), functions.end());
  return schedule_.AddTask(name, flowStr, functionstr, files, args, runtimeConfig, 
      user, jobType);
}

void ns_API::ScheduleAPI::GetRunningTaskSummary() {
}

void ns_API::ScheduleAPI::GetTaskInfos(uint64_t task_id) {
}

void ns_API::ScheduleAPI::GetOutput(
    std::string const& type, std::string const& taskID, uint64_t stepUUID, 
    std::string const& stepID, struct FileExtractedText& data) {
  return schedule_.GetOutput(type, taskID, stepUUID, stepID, data);
}
