#pragma once
#include "config.hxx"
#include <thread>
#include <mutex>
#include <unordered_map>
#include <queue>
#include <condition_variable>

namespace ns_Cache {

class Cache {
public:
  enum class GetStatus {
    OK,
    PARTIAL,
    NO,
  };
  Cache(ns_Cache::Config const& config);
  ~Cache();

  bool Put(std::filesystem::path const& path, std::string const& id, bool force, bool computeMD5);
  enum GetStatus Get(std::string const& id, std::filesystem::path& path);

private:
  struct FileInformations {
    std::filesystem::path path_;
    uint64_t md5_;
    bool full_;
  };
  struct FileToStore {
    std::string id_;
    std::filesystem::path srcPath_;
    bool md5_;
  };
  ns_Cache::Config const& config_;
  bool threadRunning_;
  std::thread thread_;
  std::mutex dataLock_;
  std::unordered_map<std::string, struct FileInformations> data_;
  std::mutex cacheThreadLock_;
  std::condition_variable cacheThreadCV_;
  std::queue<struct FileToStore> dataToAdd_;

  void CacheLoop();
  void SaveData();
  void LoadData();
};

};