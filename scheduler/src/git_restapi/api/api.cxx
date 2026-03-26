#include "api.hxx"
#include <unistd.h>
#include <cstring>

ns_API::APIS::APIS(ns_GIT::Config const& configGit) 
{
  for(auto const& repository: configGit.repositories_) {
    gitAPI_.try_emplace(
        repository.first, 
        configGit, repository.first, repository.second);
  }
}