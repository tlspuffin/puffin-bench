#pragma once
#include "server/config.hxx"
#include "schedule/config.hxx"

typedef struct Config {
  ns_Server::Config server_;
  ns_Schedule::Config schedule_;
} Config;