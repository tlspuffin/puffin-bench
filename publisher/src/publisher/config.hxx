#pragma once

#include "server/config.hxx"
#include "publish/config.hxx"
#include <string>

typedef struct Config {
  unsigned int logsLevel_;
  ns_Server::Config server_;
  ns_Publish::Config publish_;
  Config();
  bool Load(std::string const& filepath);
  void Save(std::string const& filepath) const;
  void Validate(bool forceInstall);
} Config;
