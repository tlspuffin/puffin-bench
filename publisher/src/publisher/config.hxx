#pragma once
#include "server/config.hxx"
#include "publish/publish.hxx"

typedef struct Config {
  ns_Server::Config server_;
  ns_Publish::Config publish_;
  Config(bool forceInstall);
  bool Load(std::string const& filepath);
  void Save(std::string const& filepath) const;
  void Validate();
} Config;
