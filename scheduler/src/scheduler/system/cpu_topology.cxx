#include "cpu_topology.hxx"
#include <algorithm>
#include <fstream>
#include <map>
#include <set>
#include <sstream>

namespace {

// "0,20" or "0-1,32-33" -> the CPUs it lists
std::vector<uint64_t> ParseCpuList(std::string const& text) {
  std::vector<uint64_t> cpus;
  std::stringstream ss(text);
  std::string part;
  while (std::getline(ss, part, ',')) {
    part.erase(std::remove_if(part.begin(), part.end(), ::isspace), part.end());
    if (part.empty()) {
      continue;
    }
    try {
      auto const dash = part.find('-');
      uint64_t const lo = std::stoull(part.substr(0, dash));
      uint64_t const hi = (dash == std::string::npos) ? lo : std::stoull(part.substr(dash + 1));
      for (uint64_t cpu = lo; cpu <= hi; ++cpu) {
        cpus.push_back(cpu);
      }
    } catch (...) {
      return {};
    }
  }
  return cpus;
}

}

ns_System::CpuTopology ns_System::CpuTopology::Flat(uint64_t nbCpus) {
  CpuTopology topology;
  topology.coreOf_.resize(nbCpus);
  topology.nodeOf_.assign(nbCpus, 0);
  for (uint64_t cpu = 0; cpu < nbCpus; ++cpu) {
    topology.coreOf_[cpu] = static_cast<int64_t>(cpu);
    topology.coreCpus_.push_back({ cpu });
  }
  return topology;
}

ns_System::CpuTopology ns_System::CpuTopology::Read(uint64_t nbCpus, std::filesystem::path const& sysCpu) {
  CpuTopology topology;
  topology.coreOf_.assign(nbCpus, -1);
  topology.nodeOf_.assign(nbCpus, 0);
  // physical cores by their sibling list (the same list for every thread of a core)
  std::map<std::vector<uint64_t>, int64_t> cores;
  for (uint64_t cpu = 0; cpu < nbCpus; ++cpu) {
    std::filesystem::path const dir = sysCpu / ("cpu" + std::to_string(cpu));
    std::ifstream in(dir / "topology" / "thread_siblings_list");
    std::string line;
    if (!in || !std::getline(in, line)) {
      continue;  // offline: never given
    }
    std::vector<uint64_t> siblings = ParseCpuList(line);
    if (siblings.empty() || (std::find(siblings.begin(), siblings.end(), cpu) == siblings.end())) {
      siblings = { cpu };
    }
    siblings.erase(std::remove_if(siblings.begin(), siblings.end(), [nbCpus](uint64_t c) { return c >= nbCpus; }),
        siblings.end());
    auto [it, inserted] = cores.try_emplace(siblings, static_cast<int64_t>(topology.coreCpus_.size()));
    if (inserted) {
      topology.coreCpus_.push_back(siblings);
    }
    topology.coreOf_[cpu] = it->second;
    std::error_code ec;
    for (auto const& entry : std::filesystem::directory_iterator(dir, ec)) {
      std::string const name = entry.path().filename().string();
      if ((name.rfind("node", 0) == 0) && (name.size() > 4) &&
          std::all_of(name.begin() + 4, name.end(), ::isdigit)) {
        topology.nodeOf_[cpu] = std::stoll(name.substr(4));
        break;
      }
    }
  }
  if (topology.coreCpus_.empty()) {
    return Flat(nbCpus);
  }
  return topology;
}

uint64_t ns_System::CpuTopology::ThreadsPerCore() const {
  uint64_t most = 1;
  for (auto const& cpus : coreCpus_) {
    most = std::max<uint64_t>(most, cpus.size());
  }
  return most;
}

bool ns_System::ParseSmtMode(std::string const& text, SmtMode& mode) {
  if (text == "pairs") {
    mode = SmtMode::Pairs;
  } else if (text == "one") {
    mode = SmtMode::One;
  } else if (text == "any") {
    mode = SmtMode::Any;
  } else {
    return false;
  }
  return true;
}

std::string ns_System::SmtModeName(SmtMode mode) {
  switch (mode) {
    case SmtMode::Pairs: return "pairs";
    case SmtMode::One: return "one";
    case SmtMode::Any: return "any";
  }
  return "any";
}

uint64_t ns_System::CpusConsumed(CpuTopology const& topology, uint64_t nbCpus, SmtMode mode) {
  uint64_t const threads = topology.ThreadsPerCore();
  switch (mode) {
    case SmtMode::Pairs: return ((nbCpus + threads - 1) / threads) * threads;
    case SmtMode::One: return nbCpus * threads;
    case SmtMode::Any: return nbCpus;
  }
  return nbCpus;
}

bool ns_System::AllocatePhysicalCores(CpuTopology const& topology, std::vector<bool> const& free, uint64_t nbCpus,
    SmtMode mode, CpuAllocation& allocation) {
  allocation = CpuAllocation();
  if ((mode == SmtMode::Any) || (nbCpus == 0)) {
    return false;
  }
  // the free physical cores (all their threads free), per NUMA node (that of their first thread)
  std::map<int64_t, std::vector<uint64_t>> freeCores;
  for (uint64_t core = 0; core < topology.coreCpus_.size(); ++core) {
    auto const& cpus = topology.coreCpus_[core];
    bool const whole = !cpus.empty() &&
        std::all_of(cpus.begin(), cpus.end(), [&free](uint64_t cpu) { return (cpu < free.size()) && free[cpu]; });
    if (whole) {
      freeCores[topology.nodeOf_[cpus.front()]].push_back(core);
    }
  }
  // how many physical cores: pairs, until their threads give nbCpus; one, nbCpus
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
  // one node: the one with the fewest free cores that is enough
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
    // several nodes: the ones with the most free cores first
    std::vector<std::pair<int64_t, std::vector<uint64_t>>> nodes(freeCores.begin(), freeCores.end());
    std::stable_sort(nodes.begin(), nodes.end(), [](auto const& a, auto const& b) { return a.second.size() > b.second.size(); });
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
  // their threads: pairs, all of them in order until nbCpus, the rest idle; one, the first of each, the rest idle
  for (uint64_t core : chosen) {
    auto const& cpus = topology.coreCpus_[core];
    for (size_t i = 0; i < cpus.size(); ++i) {
      bool const give = (mode == SmtMode::One) ? (i == 0) : (allocation.cpus_.size() < nbCpus);
      (give ? allocation.cpus_ : allocation.idle_).push_back(cpus[i]);
    }
  }
  return allocation.cpus_.size() == nbCpus;
}
