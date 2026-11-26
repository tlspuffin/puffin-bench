// Checks of the choice of the CPUs of a step (ns_Executor::Local::ChooseCores) on the layouts of cassis, pesto and
// cacio: whole physical cores (whole/pairs, one), best fit on one NUMA node, several nodes the largest first, the load
// as tie-break, any (holes first); and, on random sequences of steps, the same CPUs as the allocation of PR 13
// (AllocatePhysicalCores, kept below as the reference) when every load is equal. Exit status 0 when every check
// passes. Built with BUILD_TESTSUITS (ChooseCores reachable from a derived class).
#include "scheduler/schedule/executor/local.hxx"
#include <algorithm>
#include <cstdint>
#include <functional>
#include <iostream>
#include <map>
#include <random>
#include <set>
#include <string>
#include <utility>
#include <vector>

using View = ns_System::CoresTopologyView;
using Mode = ns_Schedule::SMT::Mode;
using Key = std::pair<uint32_t, uint32_t>;
using Groups = std::vector<std::vector<uint64_t>>;

struct TestLocal : ns_Executor::Local {
  using Local::ChooseCores;
};

int failures = 0;

void Check(std::string const& label, bool cond) {
  std::cerr << (cond ? "OK   " : "FAIL ") << label << '\n';
  if (!cond) ++failures;
}

// A machine of nbCpus logical CPUs, two threads per physical core: the twin of CPU c is c + nbCpus / 2 (physical core
// c); the NUMA node of each physical core from nodeOf. Its topology (as CoresTopology reads it) and the PR 13 one.
struct Machine {
  uint64_t nbCpus;
  std::function<uint64_t(uint64_t)> nodeOf;

  uint64_t Twin(uint64_t cpu) const { return (cpu < nbCpus / 2) ? cpu + nbCpus / 2 : cpu - nbCpus / 2; }
  uint64_t Core(uint64_t cpu) const { return cpu % (nbCpus / 2); }
  uint64_t Node(uint64_t cpu) const { return nodeOf(Core(cpu)); }

  // the view SystemLoad gives for the free CPUs (mask), every CPU measured with the load of loads (0 when absent)
  View ViewOf(std::vector<bool> const& mask, std::map<uint64_t, double> const& loads = {}) const {
    auto load = [&](uint64_t cpu) { auto it = loads.find(cpu); return (it == loads.end()) ? 0.0 : it->second; };
    std::vector<View::sNumaInfos> nodes;
    for (uint64_t core = 0; core < nbCpus / 2; ++core) {
      uint64_t const node = nodeOf(core);
      if (node >= nodes.size()) nodes.resize(node + 1);
      nodes[node].id = node;
      double const cpuLoad = (load(core) + load(core + nbCpus / 2)) / 2;
      for (uint64_t cpu : { core, core + nbCpus / 2 }) {
        nodes[node].cores[Key{ 2, 2 }].push_back(
            View::sCoreInfos{ static_cast<int64_t>(cpu), static_cast<int64_t>(core), load(cpu), cpuLoad });
      }
    }
    for (auto& node : nodes) {
      double sum = 0;
      for (auto const& core : node.cores[Key{ 2, 2 }]) sum += core.load;
      node.load = sum / node.cores[Key{ 2, 2 }].size();
    }
    return View(nodes, &mask);
  }
};

// the free CPUs: those of the ranges [first, last]
std::vector<bool> Pool(uint64_t nbCpus, std::vector<std::pair<uint64_t, uint64_t>> const& ranges) {
  std::vector<bool> free(nbCpus, false);
  for (auto const& [first, last] : ranges) {
    for (uint64_t cpu = first; cpu <= last; ++cpu) free[cpu] = true;
  }
  return free;
}

// The CPUs given to the step and those left idle, from the groups ChooseCores returns (as Local::AssignCores splits
// them): one, the first core of each group; whole, the first nbCores; any, all of them.
struct Allocation {
  uint64_t consumed = 0;
  std::vector<uint64_t> given;
  std::vector<uint64_t> idle;
  bool Empty() const { return given.empty(); }
};

Allocation Choose(View const& view, uint32_t nbCores, Mode mode) {
  auto const [consumed, groups] = TestLocal::ChooseCores(view, nbCores, mode);
  Allocation allocation;
  allocation.consumed = consumed;
  for (auto const& group : groups) {
    for (size_t i = 0; i < group.size(); ++i) {
      bool const give = (mode == Mode::One) ? (i == 0) : (mode == Mode::Whole) ? (allocation.given.size() < nbCores) : true;
      (give ? allocation.given : allocation.idle).push_back(group[i]);
    }
  }
  return allocation;
}

void Take(std::vector<bool>& free, Allocation const& allocation) {
  for (uint64_t cpu : allocation.given) free[cpu] = false;
  for (uint64_t cpu : allocation.idle) free[cpu] = false;
}

// every physical core the allocation touches is wholly in it (given or idle)
bool WholeCores(Machine const& machine, Allocation const& allocation) {
  std::set<uint64_t> held(allocation.given.begin(), allocation.given.end());
  held.insert(allocation.idle.begin(), allocation.idle.end());
  for (uint64_t cpu : held) {
    if (held.count(machine.Twin(cpu)) == 0) return false;
  }
  return !held.empty();
}

std::set<uint64_t> Nodes(Machine const& machine, Allocation const& allocation) {
  std::set<uint64_t> nodes;
  for (uint64_t cpu : allocation.given) nodes.insert(machine.Node(cpu));
  return nodes;
}

// steps of nbCores CPUs placed one after the other until none fits
int Fill(Machine const& machine, std::vector<bool> free, uint32_t nbCores, Mode mode) {
  int steps = 0;
  while (true) {
    Allocation const allocation = Choose(machine.ViewOf(free), nbCores, mode);
    if (allocation.Empty()) return steps;
    Take(free, allocation);
    ++steps;
  }
}

// ------------------------------------------------------------------------------------------------------------------
// PR 13: ns_System::AllocatePhysicalCores (system/cpu_topology.cxx), the reference of whole and one
namespace pr13 {

enum class SmtMode { Pairs, One };
struct CpuAllocation {
  std::vector<uint64_t> cpus_;
  std::vector<uint64_t> idle_;
};
struct CpuTopology {
  std::vector<int64_t> nodeOf_;
  std::vector<std::vector<uint64_t>> coreCpus_;
};

CpuTopology Topology(Machine const& machine) {
  CpuTopology topology;
  topology.nodeOf_.assign(machine.nbCpus, 0);
  for (uint64_t cpu = 0; cpu < machine.nbCpus / 2; ++cpu) {
    topology.coreCpus_.push_back({ cpu, cpu + machine.nbCpus / 2 });
  }
  for (uint64_t cpu = 0; cpu < machine.nbCpus; ++cpu) {
    topology.nodeOf_[cpu] = static_cast<int64_t>(machine.Node(cpu));
  }
  return topology;
}

bool AllocatePhysicalCores(CpuTopology const& topology, std::vector<bool> const& free, uint64_t nbCpus,
    SmtMode mode, CpuAllocation& allocation) {
  allocation = CpuAllocation();
  if (nbCpus == 0) {
    return false;
  }
  std::map<int64_t, std::vector<uint64_t>> freeCores;
  for (uint64_t core = 0; core < topology.coreCpus_.size(); ++core) {
    auto const& cpus = topology.coreCpus_[core];
    bool const whole = !cpus.empty() &&
        std::all_of(cpus.begin(), cpus.end(), [&free](uint64_t cpu) { return (cpu < free.size()) && free[cpu]; });
    if (whole) {
      freeCores[topology.nodeOf_[cpus.front()]].push_back(core);
    }
  }
  auto coresNeeded = [&](std::vector<uint64_t> const& candidates) -> uint64_t {
    if (mode == SmtMode::One) {
      return nbCpus;
    }
    uint64_t threads = 0, cores = 0;
    for (uint64_t core : candidates) {
      if (threads >= nbCpus) {
        break;
      }
      threads += topology.coreCpus_[core].size();
      ++cores;
    }
    return (threads >= nbCpus) ? cores : candidates.size() + 1;
  };
  std::vector<uint64_t> chosen;
  int64_t bestNode = -1;
  for (auto const& [node, cores] : freeCores) {
    if ((coresNeeded(cores) <= cores.size()) &&
        ((bestNode < 0) || (cores.size() < freeCores[bestNode].size()))) {
      bestNode = node;
    }
  }
  if (bestNode >= 0) {
    auto const& cores = freeCores[bestNode];
    chosen.assign(cores.begin(), cores.begin() + coresNeeded(cores));
  } else {
    std::vector<std::pair<int64_t, std::vector<uint64_t>>> nodes(freeCores.begin(), freeCores.end());
    std::stable_sort(nodes.begin(), nodes.end(),
        [](auto const& a, auto const& b) { return a.second.size() > b.second.size(); });
    std::vector<uint64_t> all;
    for (auto const& [node, cores] : nodes) {
      all.insert(all.end(), cores.begin(), cores.end());
    }
    uint64_t const needed = coresNeeded(all);
    if (needed > all.size()) {
      return false;
    }
    chosen.assign(all.begin(), all.begin() + needed);
  }
  for (uint64_t core : chosen) {
    auto const& cpus = topology.coreCpus_[core];
    for (size_t i = 0; i < cpus.size(); ++i) {
      bool const give = (mode == SmtMode::One) ? (i == 0) : (allocation.cpus_.size() < nbCpus);
      (give ? allocation.cpus_ : allocation.idle_).push_back(cpus[i]);
    }
  }
  return allocation.cpus_.size() == nbCpus;
}

}  // namespace pr13

// Random sequences of steps (whole or one, 1 to maxCores CPUs; some steps end) from the pool: ChooseCores and PR 13
// on the same free CPUs, all loads equal, must give the same CPUs (given and idle) or both nothing
void CompareWithPr13(std::string const& name, Machine const& machine, std::vector<bool> const& pool,
    uint32_t maxCores, unsigned seed) {
  pr13::CpuTopology const topology = pr13::Topology(machine);
  std::mt19937 random(seed);
  std::vector<bool> free = pool;
  std::vector<Allocation> running;
  uint64_t compared = 0, placed = 0, differences = 0;
  for (int round = 0; round < 2000; ++round) {
    if (!running.empty() && (random() % 3 == 0)) {
      size_t const ending = random() % running.size();
      for (uint64_t cpu : running[ending].given) free[cpu] = true;
      for (uint64_t cpu : running[ending].idle) free[cpu] = true;
      running.erase(running.begin() + ending);
      continue;
    }
    Mode const mode = (random() % 2 == 0) ? Mode::Whole : Mode::One;
    uint32_t const nbCores = 1 + random() % maxCores;
    Allocation const chosen = Choose(machine.ViewOf(free), nbCores, mode);
    pr13::CpuAllocation reference;
    bool const fits = pr13::AllocatePhysicalCores(topology, free, nbCores,
        (mode == Mode::One) ? pr13::SmtMode::One : pr13::SmtMode::Pairs, reference);
    ++compared;
    bool const same = fits ? ((chosen.given == reference.cpus_) && (chosen.idle == reference.idle_) &&
                              (chosen.consumed == reference.cpus_.size() + reference.idle_.size()))
                           : chosen.Empty();
    if (!same) {
      if (++differences <= 3) {
        std::cerr << "     " << name << ": " << ns_Schedule::SMT::Label(mode) << " " << nbCores << ": PR 13 "
                  << (fits ? std::to_string(reference.cpus_.size()) + " given" : "nothing") << ", ChooseCores "
                  << chosen.given.size() << " given\n";
      }
      continue;
    }
    if (fits) {
      ++placed;
      Take(free, chosen);
      running.push_back(chosen);
    }
  }
  Check(name + ": the CPUs of PR 13 on " + std::to_string(compared) + " random steps (" + std::to_string(placed) +
      " placed)", differences == 0);
}

int main() {
  // cassis: 2 sockets of 10 cores of 2 threads, twin +20, NUMA node by parity; the pool: every CPU but 0
  Machine const cassis{ 40, [](uint64_t core) { return core % 2; } };
  std::vector<bool> const cassisPool = Pool(40, { { 1, 39 } });
  View const cassisView = cassis.ViewOf(cassisPool);
  Allocation a = Choose(cassisView, 4, Mode::Whole);
  Check("cassis, whole 4: 2 whole cores, nothing idle",
      (a.given.size() == 4) && a.idle.empty() && WholeCores(cassis, a));
  Check("cassis, whole 4: one NUMA node", Nodes(cassis, a).size() == 1);
  Check("cassis, whole 4: not CPU 20, the twin of CPU 0 (out of the pool)",
      std::find(a.given.begin(), a.given.end(), 20) == a.given.end());
  a = Choose(cassisView, 3, Mode::Whole);
  Check("cassis, whole 3: 2 cores, 1 idle twin", (a.given.size() == 3) && (a.idle.size() == 1) && WholeCores(cassis, a));
  a = Choose(cassisView, 3, Mode::One);
  Check("cassis, one 3: 3 cores, 3 idle twins", (a.given.size() == 3) && (a.idle.size() == 3) && WholeCores(cassis, a));
  a = Choose(cassisView, 2, Mode::Whole);
  Check("cassis, twin step (whole 2): the two threads of one core",
      (a.given.size() == 2) && a.idle.empty() && (cassis.Twin(a.given[0]) == a.given[1]));
  Check("consumed for 3 CPUs: whole 4, one 6, any 3",
      (Choose(cassisView, 3, Mode::Whole).consumed == 4) && (Choose(cassisView, 3, Mode::One).consumed == 6) &&
      (Choose(cassisView, 3, Mode::Any).consumed == 3));
  Check("cassis: 9 steps of 3 CPUs (whole) in its 19 whole cores", Fill(cassis, cassisPool, 3, Mode::Whole) == 9);
  {
    std::vector<bool> free = cassisPool;
    free[3] = false;
    Check("a core with one busy thread is not free (38 CPUs do not fit)",
        Choose(cassis.ViewOf(free), 38, Mode::Whole).Empty());
  }
  a = Choose(cassis.ViewOf(Pool(40, { { 1, 4 }, { 6, 6 }, { 8, 8 }, { 21, 24 }, { 26, 26 }, { 28, 28 } })), 4,
      Mode::Whole);
  Check("best fit: the node with just enough cores (node 1: 2 cores) rather than node 0 (4)",
      Nodes(cassis, a) == std::set<uint64_t>{ 1 });
  a = Choose(cassisView, 24, Mode::Whole);
  Check("cassis, whole 24: on 2 nodes, the larger one (node 1, 10 cores) wholly",
      (a.given.size() == 24) && (Nodes(cassis, a).size() == 2) && WholeCores(cassis, a) &&
      (std::count_if(a.given.begin(), a.given.end(), [&](uint64_t cpu) { return cassis.Node(cpu) == 1; }) == 20));
  Check("cassis, whole 40: more than the pool, nothing", Choose(cassisView, 40, Mode::Whole).Empty());
  Check("cassis, one 20: more whole cores than the pool has (19), nothing", Choose(cassisView, 20, Mode::One).Empty());

  // the load breaks the ties (never excludes): of two nodes that fit as well, the least loaded; in a node, the least
  // loaded physical core first
  {
    std::vector<bool> const all = Pool(40, { { 0, 39 } });
    std::map<uint64_t, double> loads;
    for (uint64_t cpu = 0; cpu < 40; ++cpu) loads[cpu] = (cassis.Node(cpu) == 0) ? 0.5 : 0.1;
    a = Choose(cassis.ViewOf(all, loads), 4, Mode::Whole);
    Check("load: equal nodes, the least loaded (node 1)", Nodes(cassis, a) == std::set<uint64_t>{ 1 });
    a = Choose(cassis.ViewOf(all), 4, Mode::Whole);
    Check("load: all equal, node 0 (the lowest id)", Nodes(cassis, a) == std::set<uint64_t>{ 0 });
    // node 1 busier than node 0 (0.5 per CPU against 0.09): node 0, where core 0 (CPUs 0, 20) is the busy one
    for (uint64_t cpu = 0; cpu < 40; ++cpu) loads[cpu] = (cassis.Node(cpu) == 0) ? 0.0 : 0.5;
    loads[0] = loads[20] = 0.9;
    a = Choose(cassis.ViewOf(all, loads), 2, Mode::Whole);
    Check("load: in node 0, core 0 (busy) after core 2", (a.given == std::vector<uint64_t>{ 2, 22 }));
    loads.clear();
    for (uint64_t cpu = 0; cpu < 40; ++cpu) loads[cpu] = 0.99;
    Check("load: a fully loaded machine still places a step (no threshold)",
        Choose(cassis.ViewOf(all, loads), 4, Mode::Whole).given.size() == 4);
  }

  // any: the holes (a thread whose twin is out) first, then the most occupied node
  a = Choose(cassisView, 1, Mode::Any);
  Check("any 1: CPU 20, the hole (its twin 0 is out of the pool)", a.given == std::vector<uint64_t>{ 20 });
  a = Choose(cassisView, 3, Mode::Any);
  Check("any 3: the hole 20, then a whole core of node 0 (9 free cores, more occupied than node 1)",
      (a.given.size() == 3) && a.idle.empty() && (a.given[0] == 20) &&
      (cassis.Node(a.given[1]) == 0) && (cassis.Twin(a.given[1]) == a.given[2]));
  Check("any 39: the whole pool", Choose(cassisView, 39, Mode::Any).given.size() == 39);
  Check("any 40: more than the pool, nothing", Choose(cassisView, 40, Mode::Any).Empty());

  // pesto: 2 sockets of 16 cores of 2 threads, twin +32, 8 NUMA nodes of 4 cores
  Machine const pesto{ 64, [](uint64_t core) { return (core % 32) / 4; } };
  Check("pesto, a pool of the second threads (32-63): no whole core",
      Choose(pesto.ViewOf(Pool(64, { { 32, 63 } })), 4, Mode::Whole).Empty());
  Check("pesto, a pool of the second threads: any 4 fits", Choose(pesto.ViewOf(Pool(64, { { 32, 63 } })), 4,
      Mode::Any).given.size() == 4);
  std::vector<bool> const pestoPool = Pool(64, { { 16, 31 }, { 48, 63 } });
  a = Choose(pesto.ViewOf(pestoPool), 4, Mode::Whole);
  Check("pesto, a pool of whole cores: whole 4 on one node", (Nodes(pesto, a).size() == 1) && WholeCores(pesto, a));
  a = Choose(pesto.ViewOf(pestoPool), 12, Mode::Whole);
  Check("pesto: whole 12 (6 cores) on 2 nodes of 4 cores, the fewest possible", Nodes(pesto, a).size() == 2);

  // cacio: 2 sockets of 24 cores of 2 threads, twin +48, a NUMA node per socket; the pool: 25-40 and their twins
  Machine const cacio{ 96, [](uint64_t core) { return (core % 48) / 24; } };
  std::vector<bool> const cacioPool = Pool(96, { { 25, 40 }, { 73, 88 } });
  a = Choose(cacio.ViewOf(cacioPool), 4, Mode::Whole);
  Check("cacio: whole 4 on node 1, whole cores", WholeCores(cacio, a) && (Nodes(cacio, a) == std::set<uint64_t>{ 1 }));
  Check("cacio: 8 steps of 4 CPUs in its 16 cores", Fill(cacio, cacioPool, 4, Mode::Whole) == 8);

  // iso PR 13 (whole, one), all loads equal
  CompareWithPr13("cassis", cassis, cassisPool, 8, 1);
  CompareWithPr13("pesto", pesto, pestoPool, 10, 2);
  CompareWithPr13("pesto, whole machine", pesto, Pool(64, { { 0, 63 } }), 20, 3);
  CompareWithPr13("cacio", cacio, cacioPool, 8, 4);
  CompareWithPr13("cacio, whole machine", cacio, Pool(96, { { 1, 47 }, { 49, 95 } }), 30, 5);

  std::cerr << failures << " failure(s)\n";
  return (failures == 0) ? 0 : 1;
}
