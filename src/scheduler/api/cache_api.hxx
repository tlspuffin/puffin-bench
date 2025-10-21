#pragma once

#include <filesystem>
#include <string>

namespace ns_API {

class CacheAPI {
public:
  CacheAPI();

  bool Put(std::filesystem::path const& path, std::string const& id, bool 
      force, bool computeMD5);
  std::string Get(std::string const& id, std::filesystem::path& path);

private:
};

inline CacheAPI::CacheAPI() {}

inline bool CacheAPI::Put(std::filesystem::path const& path, std::string const& id, bool 
    force, bool computeMD5) {
  return true;
}

inline std::string CacheAPI::Get(std::string const& id, std::filesystem::path& path) {
  return "Not Available";
}

};