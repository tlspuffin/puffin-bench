#pragma once
#include "server/config.hxx"
#include "schedule/config.hxx"
#include "cache/config.hxx"

typedef struct Config {
  unsigned int logsLevel_;
  ns_Server::Config server_;
  ns_Schedule::Config schedule_;
  ns_Cache::Config cache_;
  Config();
  bool Load(std::string const& filepath);
  void Save(std::string const& filepath) const;
  void Validate(bool forceInstall);
} Config;
