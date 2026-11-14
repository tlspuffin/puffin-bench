#pragma once

#include "config.hxx"
#include <vector>
#include <string>
#include <filesystem>
#include <shared_mutex>
#include <mutex>
#include <unordered_map>
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
  // The vendor presets at a commit (tlspuffin_presets.sh), cached for ever per commit (presets_cache.json): false
  // with notFound when the commit is unknown, even after a fetch
  bool Presets(std::string const& commitID, std::string& result, bool& notFound);
  // The vulnerability catalogue at a commit (tlspuffin_catalogue.sh), cached the same way (catalogue_cache.json);
  // fetch: fetch the repository first, for dev or main (their latest heads)
  bool Catalogue(std::string const& commitID, std::string& result, bool& notFound, bool fetch = false);

private:
  // What a script prints for a commit, cached for ever per full commit in `<storage>/<name>/<cacheName>`
  struct PerCommitCache {
    std::mutex lock;
    bool loaded = false;
    std::unordered_map<std::string, std::string> answers;  // full commit -> JSON
  };
  bool PerCommit(std::string const& script, std::string const& cacheName, PerCommitCache& cache,
    std::string const& commitID, std::string& result, bool& notFound, bool fetch = false);

  bool SaveFile(std::string const& file, std::string const& content);
  void AddPullRequests(std::string const& commitID, rapidjson::Value& commit,
    rapidjson::MemoryPoolAllocator<>& alloc);
  bool ManageExternalPR(rapidjson::Document& json, std::string& result, 
    enum ERefresh refresh);

  std::filesystem::path directory_;
  std::filesystem::path scriptsPath_;
  std::shared_mutex lock_;
  bool pullRefs_;  // the PR heads are fetched (refs/remotes/origin/pull/<number>): see AddPullRequests

  PerCommitCache presets_;
  PerCommitCache catalogue_;

  std::chrono::steady_clock::time_point historyBufferTS_;
  std::string historyBuffer_;

  HTTPSClient prClient_;
  std::string prURLPath_;
  uint64_t apiResetTS_;
  uint64_t apiRemaining_;
};

};