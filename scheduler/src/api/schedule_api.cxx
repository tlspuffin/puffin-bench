#include "schedule_api.hxx"

ns_API::ScheduleAPI::ScheduleAPI(ns_Schedule::Config const& config)
    : config_(config), schedule_(config)
{
}

uint64_t ns_API::ScheduleAPI::AddTask(std::vector<uint8_t> const& flow, 
    std::vector<uint8_t> const& functions) {
  std::string flowStr(flow.begin(), flow.end());
  std::string functionstr(functions.begin(), functions.end());
  std::vector<std::string> files;
  return schedule_.AddTask(flowStr, functionstr, files);
}

bool ns_API::ScheduleAPI::CancelTask(uint64_t task_id) {
  return false;
}

void ns_API::ScheduleAPI::GetRunningTaskSummary() {
}

void ns_API::ScheduleAPI::GetTaskInfos(uint64_t task_id) {
}