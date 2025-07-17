#pragma once

#include <cstdint>
#include <vector>
#include <string>
#include <thread>
#include <mutex>
#include <atomic>

namespace ns_Executor {

class CoreStats {
public:
  static size_t const IDLE_INDEX = 3;

  uint64_t id_;
  std::vector<double> values_;

  bool excluded_;

  CoreStats(uint64_t nb_values);
  CoreStats(uint64_t nb_values, std::string const& data);
  CoreStats& operator-=(CoreStats const& other);
  void ComputeRatio();
};

class CoresStats {
public:
  CoresStats();

  uint64_t NbCores() const;

  void GatherInfos(std::vector<CoreStats>& cores_infos);
  std::vector<CoreStats> CoresValuesRatio(
      std::vector<CoreStats> const& cores_infos_t0, 
      std::vector<CoreStats> const& cores_infos_t1);
  std::vector<CoreStats> SortCoresValuesRatio(uint64_t sort_index, 
      std::vector<CoreStats> const& cores_infos_t0, 
      std::vector<CoreStats> const& cores_infos_t1,
      std::vector<bool> const* cores_included =nullptr);

  static void SortCoresValuesRatio(uint64_t sort_index, 
      std::vector<CoreStats>& cores_infos, std::vector<bool> const* cores_included);
private:
  uint64_t nb_cores_;
  uint64_t nb_values_per_core_;
};

class CoresMonitor {
public:
  CoresMonitor(uint64_t time_interval);
  ~CoresMonitor();

  std::vector<uint64_t> SelectMostIdleCores(uint64_t nb_cores, 
      std::vector<bool> const* cores_included);
  std::vector<CoreStats> CoresValuesRatio();

  CoresStats cores_infos_;

private:
  uint64_t time_interval_;
  std::thread thread_;
  std::mutex lock_;
  std::atomic<bool> threadRunning_;
  std::vector<CoreStats> cores_ratio_infos_;

  void ThreadLoop();
  bool ThreadWaitOrStop(uint64_t wait_time_s);
};

};