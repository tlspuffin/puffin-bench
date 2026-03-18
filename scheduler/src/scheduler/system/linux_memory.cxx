#include "linux_memory.hxx"
#include <fstream>
#include <string>
#include <stdexcept>

ns_System::Memory::Memory() : total_(0) {
  Update();
  total_ = stats_.total_kb * 1000;
}

void ns_System::Memory::Update() {
  std::ifstream ifs("/proc/meminfo");
  if (!ifs.is_open()) {
    throw std::runtime_error("MemoryMonitor::Update: failed to open /proc/meminfo");
  }

  MemoryStats s;
  std::string key;
  uint64_t value;
  std::string unit;

  while (ifs >> key >> value) {
    ifs >> unit; // consume "kB" (or nothing for some fields)
    if      (key == "MemTotal:")     s.total_kb      = value;
    else if (key == "MemFree:")      s.free_kb       = value;
    else if (key == "MemAvailable:") s.available_kb  = value;
    else if (key == "SwapTotal:")    s.swap_total_kb = value;
    else if (key == "SwapFree:")     s.swap_free_kb  = value;
  }

  std::lock_guard<std::mutex> lock(lock_);
  stats_ = s;
}

ns_System::Memory::MemoryStats ns_System::Memory::Stats() {
  std::lock_guard<std::mutex> lock(lock_);
  return stats_;
}
