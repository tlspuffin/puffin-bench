#pragma once

#include "schedule_api.hxx"
#include "cache_api.hxx"
#include "../system/linux.hxx"

namespace ns_API {

struct APIS {
  ns_System::Linux OSAPI_;
  ns_API::CacheAPI cacheAPI_;
  ns_API::ScheduleAPI scheduleAPI_;
  APIS(ns_Schedule::Config const& configSchedule, ns_Cache::Config const& configCache, int16_t cachePort) 
      : OSAPI_(15), cacheAPI_(configCache), scheduleAPI_(configSchedule, OSAPI_, cachePort) {}
};

};