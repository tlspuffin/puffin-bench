#pragma once
#include "server/config.hxx"

typedef struct Config {
  ns_Server::Config server_;
  bool Load(std::string const& filepath);
  void Save(std::string const& filepath) const;
  void Validate();
} Config;
