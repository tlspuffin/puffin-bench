#pragma once

#include "publish.hxx"
#include <thread>
#include <mutex>
#include <condition_variable>
#include <unordered_map>
#include <queue>
#include <string>
#include <vector>
#include <atomic>
#include <filesystem>

namespace ns_Schedule {

struct ArchiveJob {
  Publish publish_;
  std::unordered_map<std::string, std::string> variables_;
  std::filesystem::path archivePath_;
  std::vector<std::filesystem::path> sources_; //1st always the task.json
  std::filesystem::path deleteDir_;  
  std::filesystem::path baseDir_;
  
  ArchiveJob() : publish_(), variables_({}), archivePath_(""), sources_({}), 
      deleteDir_(""), baseDir_("") {}
  ArchiveJob(Publish& publish, std::unordered_map<std::string, std::string> variables, 
      std::filesystem::path const& archivePath, 
      std::vector<std::filesystem::path> const& sources,
      std::filesystem::path const& deleteDir = "",
      std::filesystem::path const& baseDir = "")
      : publish_(publish), variables_(variables), archivePath_(archivePath), 
        sources_(sources), deleteDir_(deleteDir), baseDir_(baseDir) {}
  };

class Archiver {
public:
  Archiver();
  ~Archiver();
    
  void AddJob(struct ArchiveJob& job);
    
  size_t PendingJobs();
    
  void WaitForCompletion();
    
private:
  void ThreadLoop();
  bool ProcessJob(ArchiveJob const& job);
    
  std::thread thread_;
  std::mutex queueMutex_;
  std::condition_variable queueCV_;
  std::queue<ArchiveJob> jobs_;
  std::atomic<bool> threadRunning_;
  std::atomic<size_t> jobsProcessed_;
  std::atomic<size_t> jobsFailed_;
};

}
