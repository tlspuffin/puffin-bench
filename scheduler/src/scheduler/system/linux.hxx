#pragma once

#include "linux_cores.hxx"
#include "linux_process.hxx"
#include "linux_memory.hxx"
#include <thread>
#include <mutex>
#include <atomic>
#include <unordered_map>
#include <filesystem>

namespace ns_System {

class Linux {
public:
  Linux(uint64_t time_interval, std::unordered_map<std::string, std::filesystem::path> storages);
  ~Linux();

  CoresMonitor const& Cores();
  ProcessMonitor const& Process();
  MemoryMonitor const& Memory();

  void GetLoad(CoreStats& global, std::vector<CoreStats>& perCores, 
      ns_System::MemoryMonitor::MemoryStats& memory, 
      std::unordered_map<std::string, std::pair<uint64_t, uint64_t>>& storages);

private:
  CoresMonitor cores_;
  ProcessMonitor process_;
  MemoryMonitor memory_;
  std::unordered_map<std::string, std::filesystem::path> storages_;

  uint64_t time_interval_;
  std::thread thread_;
  std::mutex lock_;
  std::atomic<bool> threadRunning_;

  void ThreadLoop();
  bool ThreadWaitOrStop(uint64_t wait_time_s);
};

inline CoresMonitor const& Linux::Cores() {
  std::lock_guard<std::mutex> lock(lock_);
  return cores_;
}

inline ProcessMonitor const& Linux::Process() {
  return process_;
}

inline MemoryMonitor const& Linux::Memory() {
  std::lock_guard<std::mutex> lock(lock_);
  return memory_;
}

}
