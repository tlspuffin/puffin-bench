#include "folder_remover.hxx"
#include <algorithm>
#include <cctype>
#include "../../utils/logs.hxx"
#include <chrono>
#include <string>
#include <vector>

namespace {
constexpr char const* suffix_ = ".deleting";
}

ns_Schedule::FolderRemover& ns_Schedule::FolderRemover::Instance() {
  static FolderRemover instance;
  return instance;
}

ns_Schedule::FolderRemover::FolderRemover() : running_(true) {
  thread_ = std::thread(&FolderRemover::ThreadLoop, this);
}

ns_Schedule::FolderRemover::~FolderRemover() {
  {
    std::lock_guard lock(lock_);
    running_ = false;
  }
  cv_.notify_one();
  if (thread_.joinable()) {
    thread_.join();
  }
}

bool ns_Schedule::FolderRemover::Remove(std::filesystem::path const& path) {
  std::error_code ec;
  if (!std::filesystem::exists(path, ec)) {
    return true;
  }
  std::filesystem::path trash = path.parent_path() / ("." + path.filename().string() + suffix_);
  // a folder of that name still waiting for its removal: another name, not a removal here (it can take minutes)
  for (int i = 1; std::filesystem::exists(std::filesystem::symlink_status(trash, ec)); ++i) {
    trash = path.parent_path() / ("." + path.filename().string() + "." + std::to_string(i) + suffix_);
  }
  std::filesystem::rename(path, trash, ec);
  if (ec) {
    LOGW << "Unable to move " << path.string() << " away to remove it: " << ec.message() << Log::Flags::End;
    return false;
  }
  Enqueue(trash);
  return true;
}

void ns_Schedule::FolderRemover::RemoveLeftovers(std::filesystem::path const& root) {
  std::error_code ec;
  for (auto const& entry : std::filesystem::directory_iterator(root, ec)) {
    std::string const name = entry.path().filename().string();
    std::string const end(suffix_);
    if ((name.size() > end.size() + 1) && (name[0] == '.') &&
        (name.compare(name.size() - end.size(), end.size(), end) == 0)) {
      Enqueue(entry.path());
    }
  }
}

std::vector<std::string> ns_Schedule::FolderRemover::RemoveOrphans(std::filesystem::path const& root,
    std::unordered_set<uint64_t> const& known) {
  std::vector<std::string> removed;
  std::vector<std::filesystem::path> orphans;
  std::error_code ec;
  for (auto const& entry : std::filesystem::directory_iterator(root, ec)) {
    std::string const name = entry.path().filename().string();
    // a task folder is named by its id (digits only, 13 today); other folders (monitors, .<name>.deleting) are not;
    // at most 18 digits, which always fit in 64 bits
    if (name.empty() || (name.size() > 18) || !std::all_of(name.begin(), name.end(), ::isdigit) ||
        !entry.is_directory(ec)) {
      continue;
    }
    if (known.count(std::stoull(name)) == 0) {
      orphans.push_back(entry.path());
    }
  }
  for (auto const& path : orphans) {
    if (Remove(path)) {
      removed.push_back(path.filename().string());
    }
  }
  return removed;
}

void ns_Schedule::FolderRemover::Enqueue(std::filesystem::path const& path) {
  {
    std::lock_guard lock(lock_);
    queue_.push_back(path);
  }
  cv_.notify_one();
}

bool ns_Schedule::FolderRemover::RemoveTree(std::filesystem::path const& path, std::uintmax_t& removed,
    std::error_code& ec) {
  if (!running_) {
    return false;
  }
  std::error_code ignored;
  // a directory (not a link to one): its entries first
  if (std::filesystem::is_directory(std::filesystem::symlink_status(path, ignored))) {
    std::vector<std::filesystem::path> entries;
    for (auto const& entry : std::filesystem::directory_iterator(path, ignored)) {
      entries.push_back(entry.path());
    }
    for (auto const& entry : entries) {
      if (!RemoveTree(entry, removed, ec)) {
        return false;
      }
    }
  }
  // the first error is kept (a later removal that succeeds would clear it)
  std::error_code error;
  if (std::filesystem::remove(path, error)) {
    ++removed;
  } else if (error && !ec) {
    ec = error;
  }
  return true;
}

void ns_Schedule::FolderRemover::ThreadLoop() {
  while (true) {
    std::filesystem::path path;
    {
      std::unique_lock lock(lock_);
      cv_.wait(lock, [this] { return !queue_.empty() || !running_; });
      if (!running_) {
        return;  // what is left is removed at the next start
      }
      path = queue_.front();
      queue_.pop_front();
    }
    std::error_code ec;
    auto const start = std::chrono::steady_clock::now();
    std::uintmax_t removed = 0;
    if (!RemoveTree(path, removed, ec)) {
      LOGI << "Removal of " << path.string() << " stopped (the scheduler stops), resumed at the next start"
           << Log::Flags::End;
      return;
    }
    if (ec) {
      LOGE << "Error while removing " << path.string() << ": " << ec.message() << Log::Flags::End;
    } else {
      LOGI << "Removed " << path.string() << " (" << static_cast<uint64_t>(removed) << " entries, " <<
          static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::seconds>(
              std::chrono::steady_clock::now() - start).count()) << " s)" << Log::Flags::End;
    }
  }
}
