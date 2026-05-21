#pragma once

#include <cstdint>
#include <mutex>

namespace ns_System {

class MemoryMonitor {
public:
  struct MemoryStats {
    uint64_t total_kb = 0;
    uint64_t available_kb = 0;
    uint64_t free_kb = 0;
    uint64_t swap_total_kb = 0;
    uint64_t swap_free_kb = 0;

    uint64_t UsedKb() const { return total_kb - available_kb; }
    double UsedRatio() const { return total_kb ? double(UsedKb()) / total_kb : 0.0; }
    double FreeRatio() const { return 1.0 - UsedRatio(); }
  };

  MemoryMonitor();
  void Update();
  MemoryStats Stats() const;
  uint64_t Total() const;

private:
  mutable std::mutex lock_;
  MemoryStats stats_;
  uint64_t total_;
};


inline uint64_t MemoryMonitor::Total() const {
  return total_;
}

}
