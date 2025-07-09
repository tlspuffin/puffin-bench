#pragma once
#include "config.hxx"
#include <thread>
#include <atomic>
#include <shared_mutex>
#include <unordered_map>
#include <vector>
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
    std::string md5_;
    std::atomic<bool> full_;

    FileInformations() : full_(false) {}

    FileInformations(const FileInformations& other)
        : path_(other.path_), md5_(other.md5_), full_(other.full_.load()) {}

    FileInformations& operator=(const FileInformations& other) {
        if (this != &other) {
            path_ = other.path_;
            md5_ = other.md5_;
            full_.store(other.full_.load());
        }
        return *this;
    }
  };
  struct FileToStore {
    std::string id_;
    std::filesystem::path srcPath_;
    bool md5_;
  };
  ns_Cache::Config const& config_;
  bool threadRunning_;
  std::thread thread_;
  std::shared_mutex dataLock_;
  std::unordered_map<std::string, struct FileInformations> data_;
  std::mutex cacheThreadLock_;
  std::condition_variable cacheThreadCV_;
  std::vector<struct FileToStore> dataToAdd_;

  void CacheLoop();
  void SaveData() const;
  void SaveCopyLog(std::string const& id, std::string const& path, std::string const& md5) const;
  void DeleteCopyLog();
  void LoadData();
};

};