#pragma once

#include <cstdint>
#include <vector>
#include <string>
#include <thread>
#include <mutex>
#include <atomic>

namespace ns_System {

class CoreStats {
public:
  static size_t const IDLE_INDEX = 3;

  uint64_t id_;
  std::vector<double> values_;

  bool excluded_;

  CoreStats();
  CoreStats(std::string const& data);
  static uint64_t NbCores();
  static uint64_t NbInfoPerCores();
  void Swap(CoreStats&& other);
  void Update(std::string const& data);
  CoreStats& operator-=(CoreStats const& other);
  void ComputeRatio();

private:
  static void Init();
  static std::mutex lock_;
  static uint64_t nb_cores__;
  static uint64_t nb_values_per_core__;
};

inline uint64_t CoreStats::NbCores() {
  std::lock_guard lock(CoreStats::lock_);
  if (CoreStats::nb_cores__ == std::numeric_limits<uint64_t>::max()) { CoreStats::Init(); }
  return CoreStats::nb_cores__;
}

inline uint64_t CoreStats::NbInfoPerCores() {
  std::lock_guard lock(CoreStats::lock_);
  if (CoreStats::nb_values_per_core__ == std::numeric_limits<uint64_t>::max()) { CoreStats::Init(); }
  return CoreStats::nb_values_per_core__;
}

class CoresStats {
public:
  CoresStats();

  void Swap(CoresStats&& other);

  void GatherInfos();
  std::vector<CoreStats> CoresValuesRatio(CoresStats const& coresStatsTNnew) const;
  std::vector<CoreStats> SortCoresValuesRatio(uint64_t sort_index, 
      CoresStats const& coresStatsTNnew, 
      std::vector<bool> const* cores_included =nullptr) const;
  CoreStats GlobalValuesRatio(CoresStats const& coresStatsTNnew) const;

  static void SortCoresValuesRatio(uint64_t sort_index, 
      std::vector<CoreStats>& cores_infos, std::vector<bool> const* cores_included);

private:
  std::vector<CoreStats> cores_infos_;
  CoreStats cores_global_infos_;
};

class CoresMonitor {
public:
  CoresMonitor();
  ~CoresMonitor();

  uint64_t NbCores() const;

  std::vector<uint64_t> SelectMostIdleCores(uint64_t nb_cores, 
      std::vector<bool> const* cores_included);
  void CoresValuesRatio(CoreStats& global, std::vector<CoreStats>& perCores);

  void Init();
  void Update();

private:
  std::mutex lock_;
  CoresStats t0_;
  CoresStats t1_;
  std::vector<CoreStats> cores_ratio_infos_;
  CoreStats cores_global_ratio_infos_;
};

};