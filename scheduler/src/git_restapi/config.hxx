#pragma once
#include "server/config.hxx"
#include "git/config.hxx"

typedef struct Config {
  ns_Server::Config server_;
  ns_GIT::Config git_;
  Config(std::string const& tmpStorage);
  bool Load(std::string const& filepath);
  void Save(std::string const& filepath) const;
  void Validate(bool forceInstall);
} Config;
