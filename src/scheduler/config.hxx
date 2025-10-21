#pragma once
#include "server/config.hxx"
#include "cache/config.hxx"

typedef struct Config {
  ns_Server::Config server_;
  ns_Cache::Config cache_;
  bool Load(std::string const& filepath);
  void Save(std::string const& filepath) const;
  void Validate();
} Config;
