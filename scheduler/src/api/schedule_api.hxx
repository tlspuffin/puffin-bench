#pragma once

#include "../schedule/schedule.hxx"

namespace ns_API {

class ScheduleAPI {
public:
  ScheduleAPI(ns_Schedule::Config const& config);

  uint64_t AddTask(std::vector<uint8_t> const& flow, 
      std::vector<uint8_t> const & functions);

private:
  ns_Schedule::Config const& config_;
  ns_Schedule::Schedule schedule_;
};

};