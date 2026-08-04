#pragma once

#include "config.hxx"
#include "project.hxx"
#include <unordered_map>
#include <filesystem>
#include <vector>
#include <string>
#include <memory>
#include <mutex>
#include <shared_mutex>
#include <thread>
#include <atomic>
#include <condition_variable>
#include <queue>
#include <any>

namespace ns_Publish {

class Publish { 
public:
  Publish(Config const& config);
  ~Publish();

  bool NotifyFiles(std::vector<std::filesystem::path>& srcFiles, 
      std::filesystem::path dstPath, std::string& error);
  bool ProjectListData(std::string const& projectName, std::vector<std::string>& list);
  std::string RulesIndex(std::filesystem::path path);
  std::unordered_map<std::string, std::unordered_map<std::string, std::vector<std::pair<std::string,std::string>>>> 
      ProjectListCampaigns(std::string const& projectName);

  bool RegenerateDataCache(std::string const& projectName, std::filesystem::path directory);
  bool DeleteData(std::string const& projectName, std::string const& cacheFile);
  int DeleteResults(uint64_t taskID);

private:
  struct SCommandNotify {
    std::vector<std::filesystem::path> files;
  };
  struct SCommandRegenerateCache {
    std::string directory;
  };
  struct SCommandDeleteEntry {
    std::string cacheFile;
  };
  struct SCommandDeleteFiles {
    uint64_t taskID;
  };
  Config config_;
  std::condition_variable threadWait_;
  std::thread thread_;
  std::atomic_bool running_;
  std::vector<Project> projects_;
  std::shared_mutex lockProjects_;
  std::queue<std::pair<std::string,std::any>> pendingCommands_;
  std::mutex lockPendingCommands_;

  void ScanProjects();
  void Main();
};

}
