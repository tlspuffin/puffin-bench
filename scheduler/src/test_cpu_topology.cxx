// Checks of the layout of the CPUs (ns_System::CoresTopology, read from sysfs) and of its views restricted to a mask
// of cores (ns_System::CoresTopologyView), on the layouts of cassis, pesto and cacio and on fake sysfs trees: exit
// status 0 when every check passes. The choice of the CPUs of a step (Local::SuggestCores) is not checked here.
#include "scheduler/system/linux_cores_topology.hxx"
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <functional>
#include <iostream>
#include <map>
#include <set>
#include <string>
#include <thread>
#include <utility>
#include <vector>

using namespace ns_System;
using View = CoresTopologyView;
using Key = std::pair<uint32_t, uint32_t>;

// CoresTopology reads sysfs once per process (a static cache): ReInit empties it and reads another tree, which the
// CoresTopology built next keep
struct TestTopology : CoresTopology {
  using CoresTopology::ReInit;
};

int failures = 0;

void Check(std::string const& label, bool cond) {
  std::cerr << (cond ? "OK   " : "FAIL ") << label << '\n';
  if (!cond) ++failures;
}

// nbCpus logical CPUs, two threads per physical core: the twin of CPU c is c + nbCpus / 2 (the physical core c); the
// NUMA node of each physical core from nodeOf; every load 0, as CoresTopology gives them
std::vector<View::sNumaInfos> Machine(uint64_t nbCpus, std::function<uint64_t(uint64_t)> const& nodeOf) {
  uint64_t const half = nbCpus / 2;
  std::vector<View::sNumaInfos> nodes;
  for (uint64_t cpu = 0; cpu < half; ++cpu) {
    uint64_t const node = nodeOf(cpu);
    if (node >= nodes.size()) {
      nodes.resize(node + 1);
    }
    nodes[node].id = node;
    std::vector<View::sCoreInfos>& cores = nodes[node].cores[Key{ 2, 2 }];
    cores.push_back(View::sCoreInfos{ static_cast<int64_t>(cpu), static_cast<int64_t>(cpu), 0.0, 0.0 });
    cores.push_back(View::sCoreInfos{ static_cast<int64_t>(cpu + half), static_cast<int64_t>(cpu), 0.0, 0.0 });
  }
  return nodes;
}

// the cores of the mask: those of the ranges [first, last]
std::vector<bool> Pool(uint64_t nbCpus, std::vector<std::pair<uint64_t, uint64_t>> const& ranges) {
  std::vector<bool> mask(nbCpus, false);
  for (auto const& [first, last] : ranges) {
    for (uint64_t cpu = first; cpu <= last; ++cpu) {
      mask[cpu] = true;
    }
  }
  return mask;
}

View::sNumaInfos const* Node(View const& view, uint64_t id) {
  for (auto const& node : view.nodes_) {
    if (node.id == id) return &node;
  }
  return nullptr;
}

// the physical cores of a class of a node (its cores / the cores kept of each), 0 when the class is absent
uint64_t NbCpus(View::sNumaInfos const* node, Key key) {
  if (node == nullptr) return 0;
  auto const it = node->cores.find(key);
  return (it == node->cores.end()) ? 0 : it->second.size() / key.second;
}

// in every class, the cores of a physical core are consecutive (key.second of them, the same cpuID): a slice is a cpu
bool Slices(View const& view) {
  for (auto const& node : view.nodes_) {
    for (auto const& [key, cores] : node.cores) {
      if ((key.second == 0) || (cores.size() % key.second != 0)) return false;
      std::set<int64_t> seen;
      for (size_t i = 0; i < cores.size(); i += key.second) {
        if (!seen.insert(cores[i].cpuID).second) return false;
        for (size_t j = 1; j < key.second; ++j) {
          if (cores[i + j].cpuID != cores[i].cpuID) return false;
        }
      }
    }
  }
  return true;
}

std::set<int64_t> CoreIDs(View const& view) {
  std::set<int64_t> ids;
  for (auto const& node : view.nodes_) {
    for (auto const& [key, cores] : node.cores) {
      for (auto const& core : cores) ids.insert(core.id);
    }
  }
  return ids;
}

// the physical cores of a view: its distinct cpuIDs
uint64_t NbCpusOf(View const& view) {
  std::set<int64_t> cpus;
  for (auto const& node : view.nodes_) {
    for (auto const& [key, cores] : node.cores) {
      for (auto const& core : cores) cpus.insert(core.cpuID);
    }
  }
  return cpus.size();
}

// the counters CoresTopology keeps from its last reading: physical cores and the largest number of threads of one
bool Counters(uint32_t nbCpus, uint32_t threadsPerCpu) {
  return (CoresTopology::NbCPU() == nbCpus) && (CoresTopology::NbThreadPerCore() == threadsPerCpu);
}

std::string CountersText() {
  return "(NbCPU " + std::to_string(CoresTopology::NbCPU()) + ", NbThreadPerCore " +
      std::to_string(CoresTopology::NbThreadPerCore()) + ")";
}

uint64_t NbCores(View const& view) {
  uint64_t count = 0;
  for (auto const& node : view.nodes_) {
    for (auto const& [key, cores] : node.cores) count += cores.size();
  }
  return count;
}

// a fake sysfs tree (<root>/node/nodeN/cpulist, <root>/cpu/cpuN/topology/thread_siblings_list); an empty siblings
// list: no topology folder (an offline CPU)
std::filesystem::path FakeSysfs(std::string const& name, std::map<uint64_t, std::string> const& nodes,
    std::map<uint64_t, std::string> const& siblings) {
  std::filesystem::path const root = std::filesystem::temp_directory_path() / ("test_cpu_topology_" + name);
  std::filesystem::remove_all(root);
  std::filesystem::create_directories(root / "cpu" / "cpufreq");  // not a CPU folder
  for (auto const& [node, cpulist] : nodes) {
    std::filesystem::path const dir = root / "node" / ("node" + std::to_string(node));
    std::filesystem::create_directories(dir);
    std::ofstream(dir / "cpulist") << cpulist << '\n';
  }
  for (auto const& [cpu, list] : siblings) {
    std::filesystem::path const dir = root / "cpu" / ("cpu" + std::to_string(cpu));
    std::filesystem::create_directories(dir);
    if (!list.empty()) {
      std::filesystem::create_directories(dir / "topology");
      std::ofstream(dir / "topology" / "thread_siblings_list") << list << '\n';
    }
  }
  return root;
}

// the layout read from a fake tree, as the view CoresTopology keeps (no mask, sorted)
View Read(std::filesystem::path const& root, int64_t fallbackMaxCPU) {
  TestTopology::ReInit(fallbackMaxCPU, root);
  CoresTopology topology(fallbackMaxCPU);
  return View(topology.Nodes());
}

int main() {
  // cassis: 2 sockets of 10 cores of 2 threads, twin +20, NUMA node by parity; the pool: every CPU but 0
  std::vector<View::sNumaInfos> const cassis = Machine(40, [](uint64_t cpu) { return cpu % 2; });
  {
    View const all(cassis, nullptr);
    Check("cassis, no mask: 2 nodes of 10 whole cpus", (all.nodes_.size() == 2) &&
        (NbCpus(Node(all, 0), Key{ 2, 2 }) == 10) && (NbCpus(Node(all, 1), Key{ 2, 2 }) == 10) && Slices(all));
    std::vector<bool> const mask = Pool(40, { { 1, 39 } });
    View const pool(cassis, &mask);
    Check("cassis, pool 1-39: CPU 20 alone in class (2,1) of node 0 (its twin 0 out of the pool)",
        (NbCpus(Node(pool, 0), Key{ 2, 1 }) == 1) && (Node(pool, 0)->cores.at(Key{ 2, 1 })[0].id == 20));
    Check("cassis, pool 1-39: node 0 has 9 whole cpus, node 1 10",
        (NbCpus(Node(pool, 0), Key{ 2, 2 }) == 9) && (NbCpus(Node(pool, 1), Key{ 2, 2 }) == 10));
    Check("cassis, pool 1-39: 39 cores, not core 0, cpus in slices",
        (NbCores(pool) == 39) && (CoreIDs(pool).count(0) == 0) && Slices(pool));
    // a twin step takes the two threads of a cpu: they follow each other in class (2,2)
    auto const& whole = Node(pool, 1)->cores.at(Key{ 2, 2 });
    Check("cassis: the first two cores of class (2,2) are twins (+20)",
        (whole[0].cpuID == whole[1].cpuID) && (whole[1].id == whole[0].id + 20));
  }
  {
    std::vector<bool> mask = Pool(40, { { 1, 39 } });
    mask[3] = false;
    View const view(cassis, &mask);
    Check("a cpu with one thread out of the mask is in class (2,1): node 1 has 9 whole cpus and 1 partial",
        (NbCpus(Node(view, 1), Key{ 2, 2 }) == 9) && (NbCpus(Node(view, 1), Key{ 2, 1 }) == 1) &&
        (Node(view, 1)->cores.at(Key{ 2, 1 })[0].id == 23));
  }

  // the orders: nodes by load then id; cores in a class by cpuLoad, cpuID, load, id
  {
    std::vector<View::sNumaInfos> loaded = cassis;
    loaded[0].load = 0.5;
    loaded[1].load = 0.1;
    View const view(loaded, nullptr);
    Check("nodes: the least loaded first", (view.nodes_.size() == 2) && (view.nodes_[0].id == 1));
    View const equal(cassis, nullptr);
    Check("nodes: equal loads, by id", (equal.nodes_[0].id == 0) && (equal.nodes_[1].id == 1));

    // node 0: cpu 4 (CPUs 4 and 24) the least loaded, then by cpuID
    for (auto& core : loaded[0].cores[Key{ 2, 2 }]) {
      core.cpuLoad = (core.cpuID == 4) ? 0.1 : 0.3;
      core.load = core.cpuLoad;
    }
    View const cores(loaded, nullptr);
    auto const& node0 = Node(cores, 0)->cores.at(Key{ 2, 2 });
    Check("cores: the cpu of least load first, its two threads together",
        (node0[0].cpuID == 4) && (node0[1].cpuID == 4) && (node0[2].cpuID == 0) && Slices(cores));
    std::vector<View::sNumaInfos> threads = cassis;
    for (auto& core : threads[0].cores[Key{ 2, 2 }]) {
      if (core.id == 20) core.load = 0.0;
      if (core.id == 0) core.load = 0.2;
    }
    View const sorted(threads, nullptr);
    auto const& first = Node(sorted, 0)->cores.at(Key{ 2, 2 });
    Check("cores: within a cpu, the least loaded thread first (20 before 0)",
        (first[0].id == 20) && (first[1].id == 0));
  }

  // a core not measured (offline: InfiniteLoad) is out of every view, as one out of the mask
  {
    std::vector<View::sNumaInfos> offline = cassis;
    for (auto& core : offline[1].cores[Key{ 2, 2 }]) {
      if (core.id == 5) core.load = View::InfiniteLoad;
    }
    View const view(offline, nullptr);
    Check("an offline core (5): its twin 25 alone in class (2,1)",
        (CoreIDs(view).count(5) == 0) && (NbCpus(Node(view, 1), Key{ 2, 1 }) == 1) &&
        (Node(view, 1)->cores.at(Key{ 2, 1 })[0].id == 25));
  }

  // masks: empty, shorter than the ids of the cores
  {
    std::vector<bool> const none(40, false);
    View const view(cassis, &none);
    Check("an empty mask: the nodes are kept, without cores", (view.nodes_.size() == 2) && (NbCores(view) == 0));
    std::vector<bool> const shorter = Pool(20, { { 0, 19 } });
    View const half(cassis, &shorter);
    Check("a mask of 20 cores: the second threads (20-39) are out, every cpu in class (2,1)",
        (NbCores(half) == 20) && (NbCpus(Node(half, 0), Key{ 2, 2 }) == 0) &&
        (NbCpus(Node(half, 0), Key{ 2, 1 }) == 10));
  }

  // pesto: 2 sockets of 16 cores of 2 threads, twin +32, 8 NUMA nodes of 4 cores
  std::vector<View::sNumaInfos> const pesto = Machine(64, [](uint64_t cpu) { return (cpu % 32) / 4; });
  {
    std::vector<bool> const seconds = Pool(64, { { 32, 63 } });
    View const view(pesto, &seconds);
    bool partial = view.nodes_.size() == 8;
    for (auto const& node : view.nodes_) {
      partial = partial && (NbCpus(&node, Key{ 2, 2 }) == 0) && (NbCpus(&node, Key{ 2, 1 }) == 4);
    }
    Check("pesto, a pool of the second threads (32-63): no whole cpu, 8 nodes of 4 partial ones", partial);
    std::vector<bool> const whole = Pool(64, { { 16, 31 }, { 48, 63 } });
    View const half(pesto, &whole);
    uint64_t nodesWithCpus = 0;
    for (auto const& node : half.nodes_) {
      nodesWithCpus += (NbCpus(&node, Key{ 2, 2 }) == 4) ? 1 : 0;
    }
    Check("pesto, a pool of whole cores (16-31, 48-63): 4 nodes of 4 whole cpus", nodesWithCpus == 4);
  }

  // cacio: 2 sockets of 24 cores of 2 threads, twin +48, a NUMA node per socket; the pool: 25-40 and their twins
  {
    std::vector<View::sNumaInfos> const cacio = Machine(96, [](uint64_t cpu) { return (cpu % 48) / 24; });
    std::vector<bool> const mask = Pool(96, { { 25, 40 }, { 73, 88 } });
    View const view(cacio, &mask);
    Check("cacio, pool 25-40 and twins: 16 whole cpus on node 1, none on node 0",
        (NbCpus(Node(view, 1), Key{ 2, 2 }) == 16) && (NbCpus(Node(view, 0), Key{ 2, 2 }) == 0) && Slices(view));
  }

  // sysfs, NUMA nodes: cores {0, 2} on node 0, {1, 3} on node 1 ("1-1,3"), CPU 4 listed on node 1 but offline
  {
    View const view = Read(FakeSysfs("nodes", { { 0, "0,2" }, { 1, "1,3-4" } },
        { { 0, "0,2" }, { 1, "1-1,3" }, { 2, "0,2" }, { 3, "1-1,3" }, { 4, "" } }), 5);
    Check("sysfs nodes: 2 nodes of one whole cpu of 2 threads",
        (view.nodes_.size() == 2) && (NbCpus(Node(view, 0), Key{ 2, 2 }) == 1) &&
        (NbCpus(Node(view, 1), Key{ 2, 2 }) == 1) && Slices(view));
    Check("sysfs nodes: 0 and 2 twins on node 0, 1 and 3 on node 1, offline 4 absent",
        (CoreIDs(view) == std::set<int64_t>{ 0, 1, 2, 3 }) &&
        (Node(view, 0)->cores.at(Key{ 2, 2 })[0].id == 0) && (Node(view, 0)->cores.at(Key{ 2, 2 })[1].id == 2) &&
        (Node(view, 1)->cores.at(Key{ 2, 2 })[0].id == 1) && (Node(view, 1)->cores.at(Key{ 2, 2 })[1].id == 3));
    Check("sysfs nodes: cpus have distinct cpuIDs across nodes",
        Node(view, 0)->cores.at(Key{ 2, 2 })[0].cpuID != Node(view, 1)->cores.at(Key{ 2, 2 })[0].cpuID);
    Check("sysfs nodes: 2 physical cores of 2 threads, the offline CPU 4 not counted " + CountersText(),
        Counters(2, 2) && (NbCpusOf(view) == 2));
  }

  // sysfs, a hybrid machine without NUMA folder: cpus {0, 1} and {2, 3} with SMT, 4 and 5 without, CPU 6 offline
  {
    std::filesystem::path const root = FakeSysfs("hybrid", {},
        { { 0, "0-1" }, { 1, "0-1" }, { 2, "2-3" }, { 3, "2-3" }, { 4, "4" }, { 5, "5" }, { 6, "" } });
    View const view = Read(root, 7);
    Check("sysfs without nodes: one node 0, 2 cpus of class (2,2) and 2 of class (1,1), offline 6 absent",
        (view.nodes_.size() == 1) && (view.nodes_[0].id == 0) && (NbCpus(&view.nodes_[0], Key{ 2, 2 }) == 2) &&
        (NbCpus(&view.nodes_[0], Key{ 1, 1 }) == 2) && Slices(view) && (CoreIDs(view).count(6) == 0));
    Check("sysfs without nodes: 4 physical cores, 2 threads at most, the offline CPU 6 not counted " +
        CountersText(), Counters(4, 2) && (NbCpusOf(view) == 4));
    // CoresTopology keeps what was read (the cache): its view and its counters
    CoresTopology topology(7);
    Check("CoresTopology: the cache, 6 cores and the same counters",
        (NbCores(View(topology.Nodes())) == 6) && Counters(4, 2));
    // as read, no core is measured yet: a view restricted to a mask keeps none of them
    std::vector<bool> const mask = Pool(6, { { 1, 4 } });
    Check("as read, cores not measured (InfiniteLoad): out of a restricted view",
        NbCores(View(topology.Nodes(), &mask)) == 0);
    // measured (as CoresMonitor::SystemLoad does), they are kept
    std::vector<View::sNumaInfos> measured = topology.Nodes();
    for (auto& node : measured) {
      node.load = 0.0;
      for (auto& [key, cores] : node.cores) {
        for (auto& core : cores) {
          core.load = 0.0;
          core.cpuLoad = 0.0;
        }
      }
    }
    View const restricted(measured, &mask);
    Check("hybrid, mask 1-4: classes (2,1) {1} and {2,3} whole and (1,1) {4}",
        (NbCpus(&restricted.nodes_[0], Key{ 2, 1 }) == 1) && (NbCpus(&restricted.nodes_[0], Key{ 2, 2 }) == 1) &&
        (NbCpus(&restricted.nodes_[0], Key{ 1, 1 }) == 1));
  }

  // without sysfs: one core per CPU, one node
  {
    View const view = Read("/nonexistent", 8);
    Check("without sysfs: one node of 8 cpus of one thread",
        (view.nodes_.size() == 1) && (NbCpus(&view.nodes_[0], Key{ 1, 1 }) == 8) &&
        (CoreIDs(view) == std::set<int64_t>{ 0, 1, 2, 3, 4, 5, 6, 7 }));
    Check("without sysfs: 8 physical cores of 1 thread " + CountersText(), Counters(8, 1) && (NbCpusOf(view) == 8));
  }

  // a tree with no CPU at all (empty node and cpu folders): the flat fallback, counters included
  {
    View const view = Read(FakeSysfs("empty", { { 0, "" } }, {}), 3);
    Check("sysfs without any CPU: the flat fallback of 3 cpus " + CountersText(),
        (NbCores(view) == 3) && Counters(3, 1));
  }

  // this machine: every core once, cpus in slices
  {
    int64_t const fallbackMaxCPU = static_cast<int64_t>(std::thread::hardware_concurrency());
    TestTopology::ReInit(fallbackMaxCPU, "/sys/devices/system");
    CoresTopology topology(fallbackMaxCPU);
    View const view(topology.Nodes());
    Check("this machine: " + std::to_string(NbCores(view)) + " cores on " + std::to_string(view.nodes_.size()) +
        " node(s), " + std::to_string(CoresTopology::NbCPU()) + " physical cores of up to " +
        std::to_string(CoresTopology::NbThreadPerCore()) + " threads, each core once",
        (NbCores(view) > 0) && (CoreIDs(view).size() == NbCores(view)) && Slices(view) &&
        (CoresTopology::NbCPU() == NbCpusOf(view)) && (CoresTopology::NbThreadPerCore() >= 1) &&
        (CoresTopology::NbCPU() * CoresTopology::NbThreadPerCore() >= NbCores(view)));
  }

  for (auto const& name : { "nodes", "hybrid", "empty" }) {
    std::filesystem::remove_all(std::filesystem::temp_directory_path() / (std::string("test_cpu_topology_") + name));
  }
  std::cerr << failures << " failure(s)\n";
  return (failures == 0) ? 0 : 1;
}
