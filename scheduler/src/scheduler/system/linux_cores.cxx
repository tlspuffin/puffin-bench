#include "linux_cores.hxx"
#include <fstream>
#include <sstream>
#include <iostream>
#include <chrono>
#include <algorithm>
#include <stdexcept>
#include <cstdlib>

std::mutex ns_System::CoreStats::lock__;
uint64_t ns_System::CoreStats::nb_values_per_core__ = std::numeric_limits<uint64_t>::max();

ns_System::CoreStats::CoreStats()
    : id_(-1), values_(ns_System::CoreStats::NbInfoPerCores(), 0), excluded_(false)
{}

ns_System::CoreStats::CoreStats(std::string const& data)
    : id_(-1), values_(), excluded_(false)
{
  values_.reserve(ns_System::CoreStats::NbInfoPerCores());
  std::istringstream iss(data);
  std::string label;
  iss >> label;
  id_ = std::stoul(label.substr(3));
  uint64_t val;
  while (iss >> val) {
    values_.push_back(val);
  }
}

void ns_System::CoreStats::Swap(CoreStats&& other) {
  uint64_t id = id_;
  id_ = other.id_;
  other.id_ = id;
  values_.swap(other.values_);
  bool excluded = excluded_;
  excluded_ = other.excluded_;
  other.excluded_ = excluded;
}

void ns_System::CoreStats::Update(std::string const& data) {
  values_.clear();
  std::istringstream iss(data);
  std::string label;
  iss >> label;
  if (label != "cpu") {
    id_ = std::stoul(label.substr(3));
  }
  uint64_t val;
  while (iss >> val) {
    values_.push_back(val);
  }
}

ns_System::CoreStats& ns_System::CoreStats::operator-=(ns_System::CoreStats const& other) {
  if (values_.size() != other.values_.size()) {
    throw std::runtime_error("CoreStats::operator-=: values_ size mismatch");
  }
  for(size_t i=0; i<values_.size(); ++i) {
    values_[i] -= other.values_[i];
  }
  return *this;
}

void ns_System::CoreStats::ComputeRatio() {
  double total = 0;
  for(double value : values_) {
    total += value;
  }
  if (total > 0) {
    for(double& value : values_) {
      value /= total;
    }
  }
}

void ns_System::CoreStats::Init(std::string const& statsFilename) {
  nb_values_per_core__ = 0;
  std::ifstream handler_stats(statsFilename);
  if (!handler_stats.is_open()) {
    throw std::runtime_error("CoresStats: Failed to open " + statsFilename);
  }
  std::string line;
  while (std::getline(handler_stats, line)) {
    if (line.find("cpu", 0) != 0) {
      continue;
    }
    if (line[3] == ' ') {
      std::istringstream iss(line);
      std::string label;
      iss >> label;

      uint64_t val;
      while (iss >> val) {
        ++nb_values_per_core__;
      }
      return;
    }
  }
}

std::mutex ns_System::CoresStats::lock__;
uint64_t ns_System::CoresStats::nb_cores__ = std::numeric_limits<uint64_t>::max();

ns_System::CoresStats::CoresStats(std::string const& statsFilename) 
    : statsFilename_(statsFilename), cores_infos_(CoresStats::NbCores()), cores_global_infos_()
{}

void ns_System::CoresStats::Swap(CoresStats&& other) {
  cores_infos_.swap(other.cores_infos_);
  cores_global_infos_.Swap(std::move(other.cores_global_infos_));
}

void ns_System::CoresStats::GatherInfos() {
  std::ifstream handler_stats(statsFilename_);
  if (!handler_stats.is_open()) {
     throw std::runtime_error("CoresStats::GatherInfos: Failed to open " + statsFilename_);
  }

  for(ns_System::CoreStats& coreStats: cores_infos_) {
    coreStats.id_ = -1;
  }
  std::string line;
  while (std::getline(handler_stats, line)) {
    if (line.find("cpu", 0) != 0) {
      continue;
    }
    if (line[3] == ' ') {
      cores_global_infos_.Update(line);
      continue;
    }
    char* end = nullptr;
    uint64_t const id = std::strtoull(&line[3], &end, 10);
    if ((end != &line[3]) && (id < nb_cores__)) {
      cores_infos_[id].Update(line);
    }
  }
}

std::vector<ns_System::CoreStats> ns_System::CoresStats::CoresValuesRatio(
    CoresStats const& coresStatsTNnew) const {
  std::vector<CoreStats> const& cores_infos_t1 = coresStatsTNnew.cores_infos_;
  if (cores_infos_.size() != cores_infos_t1.size()) {
    throw std::runtime_error(
        "CoresStats::CoresValuesRatio: Mismatched core info vectors - t0 size: " +
        std::to_string(cores_infos_.size()) + ", t1 size: " +
        std::to_string(cores_infos_t1.size()));
  }

  std::vector<CoreStats> results = cores_infos_t1;
  for(size_t i=0; i<results.size(); ++i) {
    if ((results[i].id_ != -1) && (cores_infos_[i].id_ != -1)) {
      results[i] -= cores_infos_[i];
      results[i].ComputeRatio();
    } else {
      results[i].id_ = -1;
    }
  }

  return results;
}

std::vector<ns_System::CoreStats> ns_System::CoresStats::SortCoresValuesRatio(uint64_t sort_index, 
    CoresStats const& coresStatsTNnew, std::vector<bool> const* cores_included) const {
  std::vector<CoreStats> const& cores_infos_t1 = coresStatsTNnew.cores_infos_;
  if ((cores_included != nullptr) &&
      (coresStatsTNnew.cores_infos_.size() != cores_included->size())) {
    throw std::runtime_error(
        "CoresStats::SortCoresValuesRatio: Size mismatch - core stats: " +
        std::to_string(cores_infos_t1.size()) +
        ", inclusions: " + std::to_string(cores_included->size()));
  }
  if (sort_index >= CoreStats::NbInfoPerCores()) {
    throw std::runtime_error(
        "CoresStats::SortCoresValuesRatio: Invalid sort_index " +
        std::to_string(sort_index) + " (max index: " +
        std::to_string(CoreStats::NbInfoPerCores() - 1) + ")");
  }

  std::vector<CoreStats> results = CoresValuesRatio(coresStatsTNnew);
  SortCoresValuesRatio(sort_index, results, cores_included);

  return results;
}

ns_System::CoreStats ns_System::CoresStats::GlobalValuesRatio(
    CoresStats const& coresStatsTNnew) const {
  CoreStats const& cores_global_infos_t1 = coresStatsTNnew.cores_global_infos_;
  CoreStats results = cores_global_infos_t1;
  results -= cores_global_infos_;
  results.ComputeRatio();
  return results;
}

void ns_System::CoresStats::SortCoresValuesRatio(uint64_t sort_index, 
      std::vector<CoreStats>& cores_infos, std::vector<bool> const* cores_included) {
  uint64_t nb_elements = cores_infos.size();
  if (cores_included != nullptr) {
    for(size_t i=0; i<cores_infos.size(); ++i) {
      cores_infos[i].excluded_ = !(*cores_included)[i];
      if ((cores_infos[i].id_ == -1) || (cores_infos[i].excluded_)) {
        --nb_elements;
      }
    }
  } else {
    for(size_t i=0; i<cores_infos.size(); ++i) {
       if (cores_infos[i].id_ == -1) {
        --nb_elements;
      }
    }
  }

  std::sort(cores_infos.begin(), cores_infos.end(),
    [sort_index](CoreStats const& a, CoreStats const& b) {
      if (a.id_ == -1) return false;
      if (b.id_ == -1) return true;
      if (a.values_.size() <= sort_index || b.values_.size() <= sort_index) {
        return a.id_ < b.id_;
      }
      if (a.excluded_ && !b.excluded_) return false;
      if (!a.excluded_ && b.excluded_) return true;
      return a.values_[sort_index] > b.values_[sort_index];
    }
  );

  cores_infos.resize(nb_elements, {});
}

void ns_System::CoresStats::Init(std::string const& cpumaxFilename) {
  bool success = false;
  if (cpumaxFilename.empty()) {
    success = ReadSysFS("/sys/devices/system/cpu/possible") ||
        ReadSysFS("/sys/devices/system/cpu/present") ||
        ReadStat("/proc/stat");
  } else {
    success = ReadSysFS(cpumaxFilename) || ReadStat(cpumaxFilename);
  }
  if (!success) {
    throw std::runtime_error("CoresStats::Init unable to get number of cores");
  }
}

bool ns_System::CoresStats::ReadSysFS(std::string const& cpumaxFilename) {
  std::ifstream ifs(cpumaxFilename);
  if (!ifs.is_open()) {
    std::cerr << "Warning CoresStats::ReadSysFS: Failed to open " << cpumaxFilename << std::endl;
    return false;
  }
  std::string line;
  std::getline(ifs, line);
  ifs.close();
  
  if (line.empty()) {
    return false;
  }
  size_t lineLength = line.size() - 1;
  for(; ((lineLength > 0) && ((line[lineLength-1] >= '0') && (line[lineLength-1] <= '9')));
      --lineLength);
  char* end = nullptr;
  uint64_t const maxCore = std::strtoull(&line[lineLength], &end, 10);
  if (end == &line[lineLength]) {
    return false;
  }
  nb_cores__ = maxCore + 1;
  return true;
}

bool ns_System::CoresStats::ReadStat(std::string const& cpumaxFilename) {
  std::ifstream handler_stats(cpumaxFilename);
  if (!handler_stats.is_open()) {
    std::cerr << "Warning CoresStats::ReadStat: Failed to open " << cpumaxFilename << std::endl;
    return false;
  }
  int64_t maxID = -1;
  std::string line;
  while (std::getline(handler_stats, line)) {
    if (line.find("cpu", 0) != 0) {
      continue;
    }
    if (line[3] != ' ') {
      char* end = nullptr;
      int64_t const id = std::strtoll(&line[3], &end, 10);
      if ((end != &line[3]) && (id > maxID)) {
        maxID = id;
      }
    }
  }
  if (maxID == -1) {
    return false;
  }
  nb_cores__ = ++maxID;
  return true;
}

ns_System::CoresMonitor::CoresMonitor() : cores_topology_(CoresStats::NbCores()) {
}

ns_System::CoresMonitor::~CoresMonitor() {
}

ns_System::CoresTopologyView ns_System::CoresMonitor::SystemLoad(std::vector<bool> const* cores_included) const {
  std::vector<CoreStats> cores_values_ratio;
  {
    std::lock_guard<std::mutex> lock(lock_);
    cores_values_ratio = cores_ratio_infos_;
  }
  CoresTopology result = cores_topology_;
  for(CoresTopologyView::sNumaInfos& numaInfos: result.Nodes()) {
    double nodeLoad = 0;
    size_t nbNodeLoad = 0;
    for(auto& [threadCount, coresInfos] : numaInfos.cores) {
      double cpuLoad = 0;
      size_t nbLoad = 0;
      for(size_t i=0; i<coresInfos.size(); ++i) {
        if (coresInfos[i].id < cores_values_ratio.size()) {
          CoreStats& coreStats = cores_values_ratio[coresInfos[i].id];
          if (coreStats.id_ != -1) {
            double load = 1.0 - coreStats.values_[CoreStats::IDLE_INDEX];
            coresInfos[i].load = load;
            cpuLoad += load;
            ++nbLoad;

            nodeLoad += load;
            ++nbNodeLoad;
          }
        }
        if ((i % threadCount.first) == (threadCount.first - 1)) {
          if (nbLoad > 0) {
            cpuLoad /= nbLoad;
          } else {
            cpuLoad = CoresTopologyView::InfiniteLoad;
          }
          coresInfos[i].cpuLoad = cpuLoad;
          for(size_t j=(i+1-threadCount.first); j<i; ++j) {
            coresInfos[j].cpuLoad = cpuLoad;
          }
          cpuLoad = 0;
          nbLoad = 0;
        }
      }
    }
    numaInfos.load = nbNodeLoad > 0 ? nodeLoad / nbNodeLoad : CoresTopologyView::InfiniteLoad;
  }
  return CoresTopologyView(result.Nodes(), cores_included);
}

void ns_System::CoresMonitor::CoresValuesRatio(CoreStats& global, 
    std::vector<CoreStats>& perCores) {
  std::lock_guard<std::mutex> lock(lock_);
  global = cores_global_ratio_infos_;
  perCores = cores_ratio_infos_;
}

void ns_System::CoresMonitor::Init() {
  t0_.GatherInfos();
}

void ns_System::CoresMonitor::Update() {
  t1_.GatherInfos();
  {
    std::lock_guard lock(lock_);
    cores_ratio_infos_ = t0_.CoresValuesRatio(t1_);
    cores_global_ratio_infos_ = t0_.GlobalValuesRatio(t1_);
  }
  t0_.Swap(std::move(t1_));
}
