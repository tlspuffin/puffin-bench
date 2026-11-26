#include "linux_cores_topology.hxx"
#include <algorithm>
#include <fstream>
#include <map>
#include <set>
#include <sstream>
#include <functional>
#include <iostream>

// "0,20" or "0-1,32-33" -> the CPUs it lists
static std::vector<int64_t> ParseCpuList(std::string const& text) {
  std::vector<int64_t> cpus;
  std::stringstream ss(text);
  std::string part;
  while (std::getline(ss, part, ',')) {
    part.erase(std::remove_if(part.begin(), part.end(), ::isspace), part.end());
    if (part.empty()) {
      continue;
    }
    try {
      auto const dash = part.find('-');
      int64_t const lo = std::stoull(part.substr(0, dash));
      int64_t const hi = (dash == std::string::npos) ? lo : std::stoull(part.substr(dash + 1));
      for (int64_t cpu = lo; cpu <= hi; ++cpu) {
        cpus.push_back(cpu);
      }
    } catch (...) {
      return {};
    }
  }
  return cpus;
}

std::mutex ns_System::CoresTopology::lock__;
std::vector<ns_System::CoresTopologyView::sNumaInfos> ns_System::CoresTopology::nodes__;
int32_t ns_System::CoresTopology::nbCPU__ = 0;
int32_t ns_System::CoresTopology::threadPerCore__ = 0;

ns_System::CoresTopologyView::CoresTopologyView(std::vector<CoresTopologyView::sNumaInfos> const& nodes) :
    nodes_(nodes)
{}

ns_System::CoresTopologyView::CoresTopologyView(std::vector<CoresTopologyView::sNumaInfos> const& nodes, 
    std::vector<bool> const* cores_included)
{
  for(sNumaInfos const& nodeOriginal: nodes) {
    nodes_.push_back({});
    sNumaInfos& node = nodes_.back();
    node.id = nodeOriginal.id;
    node.load = nodeOriginal.load;
    for(auto& [threadCount, coresInfos]: nodeOriginal.cores) {
      std::vector<sCoreInfos>toKeep;
      toKeep.reserve(threadCount.first);
      for(size_t i=0; i<coresInfos.size(); ++i) {
        int64_t coreID = coresInfos[i].id;
        if (coresInfos[i].load < InfiniteLoad) {
          if ((cores_included == nullptr) || 
              ((coreID != -1) && (coreID < cores_included->size()) && (((*cores_included)[coreID])))) {
            toKeep.push_back(coresInfos[i]);
          }
        }
        if (((i % threadCount.first) == (threadCount.first - 1)) && (!toKeep.empty())) {
          std::pair<uint32_t, uint32_t> key(threadCount.first, toKeep.size());
          node.cores[key].insert(node.cores[key].end(), toKeep.begin(), toKeep.end());
          toKeep.clear();
        }
      }
    }
    for (auto& [key, list] : node.cores) {
      std::sort(list.begin(), list.end());
    }
  }
  std::sort(nodes_.begin(), nodes_.end());
}

ns_System::CoresTopology::CoresTopology(int64_t fallbackMaxCPU) {
  {
    std::lock_guard lock(lock__);
    Init(fallbackMaxCPU);
    view_ = CoresTopologyView(nodes__);
  }
}

using FolderVisitor = std::function<void(std::filesystem::path const& folder, int64_t id)>;
static void IterFolder(std::filesystem::path const& path, std::string const& pattern, FolderVisitor const& process) {
  size_t patternSize = pattern.size();
  std::error_code ec;
  for (auto const& entry: std::filesystem::directory_iterator{path / pattern})  {
    if ((!entry.is_directory(ec)) || ec) {
      continue;
    }
    std::string filename = entry.path().filename().string();
    if (filename.find(pattern) != 0) {
      continue;
    }
    char const* digits = filename.c_str() + patternSize;
    char* endPtr = nullptr;
    int64_t id = strtoll(digits, &endPtr, 10);
    if ((endPtr == digits) || (*endPtr != '\0')) { 
      continue;
    }
    process(entry.path(), id);
  }
};

void ns_System::CoresTopology::Init(int64_t fallbackMaxCPU, std::filesystem::path const& systemFS) {
  if (!nodes__.empty()) {
    return;
  }

  nbCPU__ = 0;
  threadPerCore__ = 0;
  if (std::filesystem::exists(systemFS / "node")) {
    IterFolder(systemFS, "node", [&](std::filesystem::path const& folder, int64_t id) {
        CoresTopologyView::sNumaInfos* node = nullptr;
        std::ifstream in(folder / "cpulist");
        std::string line;
        if (!in || !std::getline(in, line)) {
          return; // offline: never given
        }
        in.close();
        std::set<int64_t> registeredID;
        for(uint64_t coreID: ParseCpuList(line)) {
          std::string filename = systemFS / "cpu" / ("cpu" + std::to_string(coreID)) / "topology" / "thread_siblings_list";
          std::ifstream in(filename);
          if (!in || !std::getline(in, line)) {
            std::cerr << "Warning, unable to read " << filename << std::endl;
          }
          in.close();
          std::vector<int64_t> siblings = ParseCpuList(line);
          if (siblings.empty()) {
            continue;
          }
          if (registeredID.find(siblings[0]) != registeredID.end()) {
            continue;
          }
          if (node == nullptr) {
            nodes__.emplace_back();
            node = &(nodes__.back());
            node->id = id;
          }
          threadPerCore__ = std::max(threadPerCore__, (int32_t)siblings.size());
          registeredID.insert(siblings[0]);
          std::vector<CoresTopologyView::sCoreInfos>& coresInfos = node->cores[std::pair<uint32_t, u_int32_t>{siblings.size(), siblings.size()}];
          for(int64_t siblingCoreID: siblings) {
            coresInfos.emplace_back(CoresTopologyView::sCoreInfos{ siblingCoreID, nbCPU__, CoresTopologyView::InfiniteLoad, CoresTopologyView::InfiniteLoad });
          }
          ++nbCPU__;
        }
    });
  } else if (std::filesystem::exists(systemFS / "cpu")) {
    std::set<int64_t> registeredID;
    IterFolder(systemFS, "cpu", [&](std::filesystem::path const& folder, int64_t id) {
        std::ifstream in(folder / "topology" / "thread_siblings_list");
        std::string line;
        if (!in || !std::getline(in, line)) {
          return; // offline: never given
        }
        in.close();
        std::vector<int64_t> siblings = ParseCpuList(line);
        if (siblings.empty()) {
          return;
        }
        if (registeredID.find(siblings[0]) != registeredID.end()) {
          return;
        }
        registeredID.insert(siblings[0]);
        if (nodes__.size() < 1) {
          nodes__.resize(1);
          nodes__[0].id = 0;
        }
        threadPerCore__ = std::max(threadPerCore__, (int32_t)siblings.size());
        std::vector<CoresTopologyView::sCoreInfos>& coresInfos = nodes__[0].cores[std::pair<uint32_t, u_int32_t>{siblings.size(), siblings.size()}];
        for(int64_t siblingCoreID: siblings) {
          coresInfos.emplace_back(CoresTopologyView::sCoreInfos{ siblingCoreID, nbCPU__, CoresTopologyView::InfiniteLoad, CoresTopologyView::InfiniteLoad });
        }
        ++nbCPU__;
    });
  }
  if (nodes__.empty()) {
    nodes__.resize(1);
    nodes__[0].id = 0;
    std::vector<CoresTopologyView::sCoreInfos>& coresInfos = nodes__[0].cores[std::pair<uint32_t, u_int32_t>{1, 1}];
    threadPerCore__ = 1;
    nbCPU__ = fallbackMaxCPU;
    for(int64_t i=0; i<nbCPU__; ++i) {
      coresInfos.emplace_back(CoresTopologyView::sCoreInfos{ i, i, CoresTopologyView::InfiniteLoad, CoresTopologyView::InfiniteLoad });
    }
  }
}
