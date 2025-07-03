#pragma once
#include "server/config.hxx"
#include "schedule/config.hxx"
#include "cache/config.hxx"

typedef struct Config {
  ns_Server::Config server_;
  ns_Schedule::Config schedule_;
  ns_Cache::Config cache_;
} Config;