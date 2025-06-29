#include "schedule_api.hxx"

ns_API::ScheduleAPI::ScheduleAPI(ns_Schedule::Config const& config)
    : config_(config), schedule_(config)
{
}

uint64_t ns_API::ScheduleAPI::AddTask(std::vector<uint8_t> const& flow, 
    std::vector<uint8_t> const& functions) {
  std::vector<std::string> files;
  return schedule_.AddTask((char const*)flow.data(), 
      (char const*)functions.data(), files);
}