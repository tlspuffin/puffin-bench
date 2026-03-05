#pragma once

#include "config.hxx"
#include "index.hxx"
#include "publish_action.hxx"
#include <filesystem>
#include <unordered_map>
#include <unordered_set>
#include <vector>
#include <memory>
#include <mutex>
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

  bool NotifyFiles(std::vector<std::filesystem::path>&& srcFiles, std::filesystem::path const& dstPath, std::string& error);
  std::string GetFilePath(std::string const& projectName, std::filesystem::path const& file);

private:
  struct Project {
    std::string name_;
    std::filesystem::path path_;
    std::filesystem::path outputPath_;
    Index indexed_;
    std::vector<std::shared_ptr<PublishAction>> rules_;
    std::unordered_map<std::string, std::string> variablesValues_;

    Project(std::string const& name, std::filesystem::path const& path, std::filesystem::path const& outputPath, 
        std::unordered_map<std::string, std::string> const& variablesValues);
    bool Save();
    bool ExecuteTriggers(std::unordered_set<std::string> const& triggers) const;
  };
  struct NotifyFilesRequest {
    std::vector<std::filesystem::path> srcFiles;
    std::filesystem::path dstPath;
  };

  Config config_;
  std::vector<Project> projects_;
  std::mutex lock_;
  std::thread thread_;
  std::atomic_bool running_;
  std::condition_variable threadWait_;
  std::queue<struct NotifyFilesRequest> pendingNotifyFiles_;
  std::unordered_map<std::string, std::string> variablesValues_;

  std::vector<Project> ScanProjects();
  bool ScanRules(ns_Publish::Publish::Project& project, std::filesystem::path const& directory);
  std::unordered_set<std::string> LoadIndex(std::string const& indexFilename);
  void SaveIndex(std::unordered_set<std::string> indexed, std::string const& indexFilename);

  void ProjectStorageScan(Project& project);

  void Main();
  void ProcessANotifyFilesRequest(std::unique_lock<std::mutex>& lock);
};

}
