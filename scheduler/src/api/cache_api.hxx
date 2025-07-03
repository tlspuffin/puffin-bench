#pragma once

#include "../cache/cache.hxx"

namespace ns_API {

class CacheAPI {
public:
  CacheAPI(ns_Cache::Config const& config);

  bool Put(std::filesystem::path const& path, std::string const& id, bool 
      force, bool computeMD5);
  bool Get(std::string const& id, std::filesystem::path& path);

private:
  ns_Cache::Cache cache_;
};

inline CacheAPI::CacheAPI(ns_Cache::Config const& config) : cache_(config) {}

inline bool CacheAPI::Put(std::filesystem::path const& path, std::string const& id, bool 
    force, bool computeMD5) {
  return cache_.Put(path, id, force, computeMD5);
}

inline bool CacheAPI::Get(std::string const& id, std::filesystem::path& path) {
  ns_Cache::Cache::GetStatus status = cache_.Get(id, path);
  return status == ns_Cache::Cache::GetStatus::OK;
}

};