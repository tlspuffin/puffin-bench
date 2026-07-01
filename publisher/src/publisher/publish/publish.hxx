#pragma once

#include "config.hxx"
#include "project.hxx"
#include <filesystem>
#include <unordered_map>
#include <unordered_set>
#include <vector>
#include <memory>
#include <mutex>
#include <shared_mutex>
#include <thread>
#include <atomic>
#include <condition_variable>
#include <queue>
#include <unordered_set>

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

  bool RegenerateDataCache(std::string const& projectName, std::string const& directory);
  bool DeleteData(std::string const& projectName, std::string const& cacheFile);

private:
  struct SNotifyFiles {
    std::string projectName;
    std::vector<std::filesystem::path> files;
  };
  Config config_;
  std::condition_variable threadWait_;
  std::thread thread_;
  std::atomic_bool running_;
  std::vector<Project> projects_;
  std::shared_mutex lockProjects_;
  std::queue<SNotifyFiles> pendingNotifyFiles_;
  std::mutex lockPendingNotifyFiles_;

  void ScanProjects();
  void Main();
  void ProcessANotifyFilesRequest(std::queue<SNotifyFiles>& requests);
};

}
