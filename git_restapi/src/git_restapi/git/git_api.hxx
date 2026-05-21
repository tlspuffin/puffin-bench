#pragma once

#include "config.hxx"
#include <vector>
#include <string>
#include <filesystem>
#include <shared_mutex>
#include <thread>
#include <condition_variable>
#include <atomic>
#include "../../utils/httpsclient.hxx"

namespace ns_GIT {

class GitAPI {
public:
  enum ERefresh { None, Local, All };
  GitAPI(Config const config, std::string const& name, 
    std::unordered_map<std::string, std::string> const& parameters);
  bool History(std::string& result, enum ERefresh refresh);
  bool Logs(std::vector<std::string> commitIDs, std::string& result);

private:
  bool SaveFile(std::string const& file, std::string const& content);
  bool ManageExternalPR(rapidjson::Document& json, std::string& result, 
    enum ERefresh refresh);

  std::filesystem::path directory_;
  std::filesystem::path scriptsPath_;
  std::shared_mutex lock_;

  std::chrono::steady_clock::time_point historyBufferTS_;
  std::string historyBuffer_;

  HTTPSClient prClient_;
  std::string prURLPath_;
  uint64_t apiResetTS_;
  uint64_t apiRemaining_;
};

};