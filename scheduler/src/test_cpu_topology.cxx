// Checks of the choice of whole physical cores (ns_System::AllocatePhysicalCores) on the layouts of cassis, pesto and
// cacio, and of the reading of a layout from sysfs (a fake one): exit status 0 when every check passes.
#include "scheduler/system/cpu_topology.hxx"
#include <filesystem>
#include <fstream>
#include <iostream>
#include <set>
#include <string>
#include <utility>
#include <vector>

using namespace ns_System;

int failures = 0;

void Check(std::string const& label, bool cond) {
  std::cerr << (cond ? "OK   " : "FAIL ") << label << '\n';
  if (!cond) ++failures;
}

// nbCpus logical CPUs, two threads per physical core: the twin of CPU c is c + nbCpus / 2; the NUMA node of each CPU
// from nodeOf
template <class NodeOf>
CpuTopology Machine(uint64_t nbCpus, NodeOf nodeOf) {
  uint64_t const half = nbCpus / 2;
  CpuTopology topology;
  topology.coreOf_.assign(nbCpus, -1);
  topology.nodeOf_.assign(nbCpus, 0);
  for (uint64_t cpu = 0; cpu < half; ++cpu) {
    topology.coreOf_[cpu] = topology.coreOf_[cpu + half] = static_cast<int64_t>(topology.coreCpus_.size());
    topology.coreCpus_.push_back({ cpu, cpu + half });
  }
  for (uint64_t cpu = 0; cpu < nbCpus; ++cpu) {
    topology.nodeOf_[cpu] = nodeOf(cpu);
  }
  return topology;
}

// the free CPUs: those of the ranges [first, last]
std::vector<bool> Pool(uint64_t nbCpus, std::vector<std::pair<uint64_t, uint64_t>> const& ranges) {
  std::vector<bool> free(nbCpus, false);
  for (auto const& [first, last] : ranges) {
    for (uint64_t cpu = first; cpu <= last; ++cpu) {
      free[cpu] = true;
    }
  }
  return free;
}

// the CPUs of an allocation (given and idle) taken from the free ones
void Take(std::vector<bool>& free, CpuAllocation const& allocation) {
  for (uint64_t cpu : allocation.cpus_) free[cpu] = false;
  for (uint64_t cpu : allocation.idle_) free[cpu] = false;
}

// every physical core an allocation touches is wholly in it (given or idle)
bool WholeCores(CpuTopology const& topology, CpuAllocation const& allocation) {
  std::set<uint64_t> held(allocation.cpus_.begin(), allocation.cpus_.end());
  held.insert(allocation.idle_.begin(), allocation.idle_.end());
  for (uint64_t cpu : held) {
    for (uint64_t twin : topology.coreCpus_[topology.coreOf_[cpu]]) {
      if (held.count(twin) == 0) return false;
    }
  }
  return true;
}

std::set<int64_t> Nodes(CpuTopology const& topology, CpuAllocation const& allocation) {
  std::set<int64_t> nodes;
  for (uint64_t cpu : allocation.cpus_) nodes.insert(topology.nodeOf_[cpu]);
  return nodes;
}

// a sysfs CPU folder (cpuN/topology/thread_siblings_list, cpuN/nodeK) for 4 CPUs: cores {0, 2} on node 0, {1, 3} on
// node 1
std::filesystem::path FakeSysfs() {
  std::filesystem::path const root = std::filesystem::temp_directory_path() / "test_cpu_topology";
  std::filesystem::remove_all(root);
  for (uint64_t cpu = 0; cpu < 4; ++cpu) {
    std::filesystem::path const dir = root / ("cpu" + std::to_string(cpu));
    std::filesystem::create_directories(dir / "topology");
    std::filesystem::create_directories(dir / ("node" + std::to_string(cpu % 2)));
    std::ofstream(dir / "topology" / "thread_siblings_list") << ((cpu % 2 == 0) ? "0,2" : "1-1,3") << '\n';
  }
  return root;
}

int main() {
  CpuAllocation a;

  // cassis: 2 sockets of 10 cores of 2 threads, twin +20, NUMA node by parity; the pool: every CPU but 0
  CpuTopology const cassis = Machine(40, [](uint64_t cpu) { return static_cast<int64_t>(cpu % 2); });
  std::vector<bool> const cassisPool = Pool(40, { { 1, 39 } });
  Check("cassis, pairs 4: 2 whole cores, nothing idle",
      AllocatePhysicalCores(cassis, cassisPool, 4, SmtMode::Pairs, a) && (a.cpus_.size() == 4) && a.idle_.empty() &&
      WholeCores(cassis, a));
  Check("cassis, pairs 4: one NUMA node", Nodes(cassis, a).size() == 1);
  Check("cassis, pairs 4: not CPU 20, the twin of CPU 0 (out of the pool)",
      std::set<uint64_t>(a.cpus_.begin(), a.cpus_.end()).count(20) == 0);
  Check("cassis, pairs 3: 2 cores, 1 idle twin",
      AllocatePhysicalCores(cassis, cassisPool, 3, SmtMode::Pairs, a) && (a.cpus_.size() == 3) &&
      (a.idle_.size() == 1) && WholeCores(cassis, a));
  Check("cassis, one 3: 3 cores, 3 idle twins",
      AllocatePhysicalCores(cassis, cassisPool, 3, SmtMode::One, a) && (a.cpus_.size() == 3) &&
      (a.idle_.size() == 3) && WholeCores(cassis, a));
  Check("cassis, twin step (pairs 2): the two threads of one core",
      AllocatePhysicalCores(cassis, cassisPool, 2, SmtMode::Pairs, a) && (a.cpus_.size() == 2) &&
      (cassis.coreOf_[a.cpus_[0]] == cassis.coreOf_[a.cpus_[1]]));
  Check("consumed for 3 CPUs: pairs 4, one 6, any 3",
      (CpusConsumed(cassis, 3, SmtMode::Pairs) == 4) && (CpusConsumed(cassis, 3, SmtMode::One) == 6) &&
      (CpusConsumed(cassis, 3, SmtMode::Any) == 3));
  {
    std::vector<bool> free = cassisPool;
    int steps = 0;
    while (AllocatePhysicalCores(cassis, free, 3, SmtMode::Pairs, a)) {
      Take(free, a);
      ++steps;
    }
    Check("cassis: 9 steps of 3 CPUs (pairs) in its 19 whole cores", steps == 9);
  }
  {
    std::vector<bool> free = cassisPool;
    free[3] = false;
    Check("a core with one busy thread is not free (38 CPUs do not fit)",
        !AllocatePhysicalCores(cassis, free, 38, SmtMode::Pairs, a));
  }
  Check("best fit: the node with just enough cores (node 1: 2 cores) rather than node 0 (4)",
      AllocatePhysicalCores(cassis, Pool(40, { { 1, 4 }, { 6, 6 }, { 8, 8 }, { 21, 24 }, { 26, 26 }, { 28, 28 } }),
          4, SmtMode::Pairs, a) && (Nodes(cassis, a) == std::set<int64_t>{ 1 }));

  // pesto: 2 sockets of 16 cores of 2 threads, twin +32, 8 NUMA nodes of 4 cores
  CpuTopology const pesto = Machine(64, [](uint64_t cpu) { return static_cast<int64_t>((cpu % 32) / 4); });
  Check("pesto, a pool of the second threads (32-63): no whole core",
      !AllocatePhysicalCores(pesto, Pool(64, { { 32, 63 } }), 4, SmtMode::Pairs, a));
  std::vector<bool> const pestoPool = Pool(64, { { 16, 31 }, { 48, 63 } });
  Check("pesto, a pool of whole cores: pairs 4 on one node",
      AllocatePhysicalCores(pesto, pestoPool, 4, SmtMode::Pairs, a) && (Nodes(pesto, a).size() == 1) &&
      WholeCores(pesto, a));
  Check("pesto: pairs 12 (6 cores) on 2 nodes of 4 cores, the fewest possible",
      AllocatePhysicalCores(pesto, pestoPool, 12, SmtMode::Pairs, a) && (Nodes(pesto, a).size() == 2));

  // cacio: 2 sockets of 24 cores of 2 threads, twin +48, a NUMA node per socket; the pool: 25-40 and their twins
  CpuTopology const cacio = Machine(96, [](uint64_t cpu) { return static_cast<int64_t>((cpu % 48) / 24); });
  {
    std::vector<bool> free = Pool(96, { { 25, 40 }, { 73, 88 } });
    Check("cacio: pairs 4 on node 1, whole cores",
        AllocatePhysicalCores(cacio, free, 4, SmtMode::Pairs, a) && WholeCores(cacio, a) &&
        (Nodes(cacio, a) == std::set<int64_t>{ 1 }));
    int steps = 0;
    while (AllocatePhysicalCores(cacio, free, 4, SmtMode::Pairs, a)) {
      Take(free, a);
      ++steps;
    }
    Check("cacio: 8 steps of 4 CPUs in its 16 cores", steps == 8);
  }

  // the layout read from sysfs
  CpuTopology const read = CpuTopology::Read(4, FakeSysfs());
  Check("Read: 2 physical cores of 2 threads", (read.coreCpus_.size() == 2) && (read.ThreadsPerCore() == 2));
  Check("Read: 0 and 2 are twins, 1 another core (list \"1-1,3\")",
      (read.coreOf_[0] == read.coreOf_[2]) && (read.coreOf_[1] == read.coreOf_[3]) &&
      (read.coreOf_[0] != read.coreOf_[1]));
  Check("Read: NUMA nodes 0 and 1", (read.nodeOf_[0] == 0) && (read.nodeOf_[1] == 1) && (read.nodeOf_[2] == 0));
  Check("Read without sysfs: one core per CPU", CpuTopology::Read(8, "/nonexistent").coreCpus_.size() == 8);
  std::filesystem::remove_all(std::filesystem::temp_directory_path() / "test_cpu_topology");

  std::cerr << failures << " failure(s)\n";
  return (failures == 0) ? 0 : 1;
}
