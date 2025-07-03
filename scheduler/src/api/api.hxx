#pragma once

#include "schedule_api.hxx"
#include "cache_api.hxx"

namespace ns_API {

struct APIS {
  ns_API::ScheduleAPI scheduleAPI_;
  ns_API::CacheAPI cacheAPI_;
  APIS(ns_Schedule::Config const& configSchedule, ns_Cache::Config const& configCache) 
      : scheduleAPI_(configSchedule), cacheAPI_(configCache) {}
};

};