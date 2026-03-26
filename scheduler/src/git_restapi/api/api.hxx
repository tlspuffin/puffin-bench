#pragma once
#include "../git/config.hxx"
#include "../git/git_api.hxx"
#include <string>
#include <filesystem>
#include <unordered_map>

namespace ns_API {

struct APIS {
  APIS(ns_GIT::Config const& configGit);

  std::unordered_map<std::string, ns_GIT::GitAPI> gitAPI_;
};

};