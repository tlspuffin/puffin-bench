#pragma once

#include "config.hxx"
#include <vector>
#include <string>
#include <filesystem>
#include <mutex>

namespace ns_GIT {

class GitAPI {
public:
  GitAPI(Config const config, std::string const& name, std::string const& url);
  bool History(std::string& result);
  bool Logs(std::vector<std::string> commitIDs, std::string& result);

private:
  std::filesystem::path directory_;
  std::filesystem::path scriptsPath_;
  std::mutex lock_;
};

};