#pragma once

#include "linux_cores.hxx"
#include "linux_process.hxx"
#include "linux_memory.hxx"
#include <thread>
#include <mutex>
#include <atomic>

namespace ns_System {

class Linux {
public:
  Linux(uint64_t time_interval);
  ~Linux();
  CoresMonitor cores_;
  Process process_;
  Memory memory_;

  void GetLoad(CoreStats& global, std::vector<CoreStats>& perCores, 
      ns_System::Memory::MemoryStats& memory);

private:
  uint64_t time_interval_;
  std::thread thread_;
  std::mutex lock_;
  std::atomic<bool> threadRunning_;

  void ThreadLoop();
  bool ThreadWaitOrStop(uint64_t wait_time_s);
};

}
