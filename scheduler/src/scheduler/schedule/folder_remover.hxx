#pragma once

#include <atomic>
#include <condition_variable>
#include <deque>
#include <filesystem>
#include <mutex>
#include <string>
#include <thread>
#include <unordered_set>
#include <vector>

namespace ns_Schedule {

// Removes the run folder of a finished task in the background. The folder holds the task's checkouts and
// builds (several GB): removing it in place blocked the schedule loop, and the task submissions waiting
// for it, for minutes. Remove() renames the folder next to itself (".<name>.deleting", instant) and a
// thread deletes it; a folder left by a stop is deleted at the next start (RemoveLeftovers).
class FolderRemover {
public:
  static FolderRemover& Instance();

  // false when the folder can not be renamed (then it is left to the caller)
  bool Remove(std::filesystem::path const& path);
  void RemoveLeftovers(std::filesystem::path const& root);
  // the folders of tasks that no longer exist: every folder of root named by a task id that is not in known (none at
  // start: tasks are not restored); returns their names
  std::vector<std::string> RemoveOrphans(std::filesystem::path const& root, std::unordered_set<uint64_t> const& known);

private:
  FolderRemover();
  ~FolderRemover();
  void Enqueue(std::filesystem::path const& path);
  void ThreadLoop();
  // removes path entry by entry; false when stopped before the end (the rest is removed at the next start); ec: the
  // first error
  bool RemoveTree(std::filesystem::path const& path, std::uintmax_t& removed, std::error_code& ec);

  std::mutex lock_;
  std::condition_variable cv_;
  std::deque<std::filesystem::path> queue_;
  // read by the removal between two files: a stop does not wait for the end of a removal of several GB
  std::atomic<bool> running_;
  std::thread thread_;
};

}
