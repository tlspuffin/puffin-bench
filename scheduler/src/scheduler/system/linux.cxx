#include "linux.hxx"
#include <filesystem>
#include <map>
#include <sys/stat.h>

ns_System::Linux::Linux(uint64_t time_interval, std::unordered_map<std::string, std::filesystem::path> storages) 
    : storages_(), time_interval_(time_interval), threadRunning_(true)
{
  cores_.Init();

  std::map<dev_t, std::string> partitions;
  for(auto const& [name, path]: storages) {
    struct stat infos {};
    if (::stat(path.c_str(), &infos) != 0) {
      continue;
    }
    auto [it, inserted] = partitions.try_emplace(infos.st_dev, name);
    if (inserted) {
      storages_[name] = path;
    } else {
      std::string oldName = it->second;
      it->second += " / " + name;
      storages_[it->second] = storages_[oldName];
      storages_.erase(oldName);
    }
  }

  if (!ThreadWaitOrStop(2)) {
    return;
  }
  cores_.Update();
  memory_.Update();
  thread_ = std::thread(&Linux::ThreadLoop, this);
}

ns_System::Linux::~Linux() {
  threadRunning_.store(false);
  thread_.join();
}

void ns_System::Linux::GetLoad(CoreStats& global, std::vector<CoreStats>& perCores, 
      ns_System::MemoryMonitor::MemoryStats& memory, 
      std::unordered_map<std::string, std::pair<uint64_t, uint64_t>>& storages) {
  for(auto const& [name, path]: storages_) {
    std::error_code ec;
    std::filesystem::space_info storageState = std::filesystem::space(path, ec);
    if (ec) {
      storages[name] = { 0, 0 };
      continue;
    }
    storages[name] = { storageState.capacity, storageState.available };
  }
  std::lock_guard lock(lock_);
  cores_.CoresValuesRatio(global, perCores);
  memory = memory_.Stats();
}

void ns_System::Linux::ThreadLoop() {
  while(true) {
    if (!ThreadWaitOrStop(time_interval_)) {
      return;
    }
    lock_.lock();

    cores_.Update();
    memory_.Update();

    lock_.unlock();
  }
}

bool ns_System::Linux::ThreadWaitOrStop(uint64_t wait_time_s) {
  for (uint64_t i=0; i<wait_time_s; ++i) {
    std::this_thread::sleep_for(std::chrono::seconds(1));
    if (!threadRunning_.load()) return false;
  }
  return true;
}
