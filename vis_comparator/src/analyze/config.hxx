#pragma once

#include "server/server.hxx"
#include "api/api.hxx"
#include <string>

class Config {
public:
  ns_Server::Config server_;
  ns_Analyze::Config analyze_;

  Config();
  bool Load(std::string const& filename);
  void Save(std::string const& filename) const;
  void Validate(bool forceInstall) const;
};
