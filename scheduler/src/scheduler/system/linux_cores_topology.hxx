#pragma once

#include <cstdint>
#include <filesystem>
#include <string>
#include <vector>
#include <map>
#include <set>
#include <tuple>
#include <mutex>

namespace ns_System {

// How the logical CPUs of the machine map onto physical cores and NUMA nodes (Linux sysfs). With SMT
// (hyper-threading) a physical core runs two logical CPUs that share its execution units: a fuzzer client on one of
// them runs slower when the other one is busy, so where the CPUs of a step lie decides how fast it runs.
class CoresTopologyView {
public:
  static double constexpr InfiniteLoad = 9999.0;

  // sorted by cpuLoad, cpuID, load, coreID 
  struct sCoreInfos {
    int64_t id = -1;
    int64_t cpuID = -1;
    double load = InfiniteLoad;
    double cpuLoad = InfiniteLoad; // average cores load
    bool operator<(sCoreInfos const& other) const {
      return std::tie(cpuLoad, cpuID, load, id) < 
          std::tie(other.cpuLoad, other.cpuID, other.load, other.id);
    }
  };
  // sorted by load, numaID 
  struct sNumaInfos {
    uint64_t id = -1;
    double load = InfiniteLoad; // average cpu load
    std::map<std::pair<uint32_t, uint32_t>, std::vector<sCoreInfos>> cores;
    bool operator<(sNumaInfos const& other) const {
      return std::tie(load, id) < std::tie(other.load, other.id);
    }
  };
  std::vector<sNumaInfos> nodes_;

  CoresTopologyView() = default;
  CoresTopologyView(std::vector<CoresTopologyView::sNumaInfos> const& nodes);
  CoresTopologyView(std::vector<CoresTopologyView::sNumaInfos> const& nodes, std::vector<bool> const* cores_included);
};

class CoresTopology {
public:
  static uint32_t NbCPU();
  static uint32_t NbThreadPerCore();

  CoresTopology() = delete;
  CoresTopology(int64_t fallbackMaxCPU);
  std::vector<CoresTopologyView::sNumaInfos>& Nodes();

private:
#ifdef BUILD_TESTSUITS
protected:
#endif
  CoresTopologyView view_;
  static std::mutex lock__;
  static std::vector<CoresTopologyView::sNumaInfos> nodes__;
  static int32_t nbCPU__;
  // the largest number of logical CPUs of a physical core (2 with SMT, 1 without)
  static int32_t threadPerCore__;
  // from sysfs (<sysCpu>/cpuN/topology/thread_siblings_list, <sysCpu>/cpuN/nodeK); nbCpus: the CPUs to describe
  // fallback on one physical core per logical CPU, one node: the layout assumed when sysfs cannot be read
  static void Init(int64_t fallbackMaxCPU, std::filesystem::path const& systemFS ="/sys/devices/system");
  static void ReInit(int64_t fallbackMaxCPU, std::filesystem::path const& systemFS);
};

inline std::vector<CoresTopologyView::sNumaInfos>& CoresTopology::Nodes() {
  return view_.nodes_;
}

inline uint32_t CoresTopology::NbCPU() {
  return nbCPU__;
}

inline uint32_t CoresTopology::NbThreadPerCore() {
  return threadPerCore__;
}

inline void CoresTopology::ReInit(int64_t fallbackMaxCPU, std::filesystem::path const& systemFS) {
  std::lock_guard lock(lock__);
  nodes__.clear();
  Init(fallbackMaxCPU, systemFS);
}

}
