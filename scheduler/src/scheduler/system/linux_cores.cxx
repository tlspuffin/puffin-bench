#include "linux_cores.hxx"
#include <fstream>
#include <sstream>
#include <iostream>
#include <chrono>
#include <algorithm>
#include <stdexcept>

std::mutex ns_System::CoreStats::lock_;
uint64_t ns_System::CoreStats::nb_cores__ = std::numeric_limits<uint64_t>::max();
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

void ns_System::CoreStats::Init() {
  nb_cores__ = 0;
  nb_values_per_core__ = 0;
  std::ifstream handler_stats("/proc/stat");
  if (!handler_stats.is_open()) {
    throw std::runtime_error("CoresStats: Failed to open /proc/stat");
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
      continue;
    }
    ++nb_cores__;
  }
}


ns_System::CoresStats::CoresStats() 
    : cores_infos_(CoreStats::NbCores()), cores_global_infos_()
{}

void ns_System::CoresStats::Swap(CoresStats&& other) {
  cores_infos_.swap(other.cores_infos_);
  cores_global_infos_.Swap(std::move(other.cores_global_infos_));
}

void ns_System::CoresStats::GatherInfos() {
  std::ifstream handler_stats("/proc/stat");
  if (!handler_stats.is_open()) {
     throw std::runtime_error("CoresStats::GatherInfos: Failed to open /proc/stat");
  }

  cores_infos_.clear();
  std::string line;
  while (std::getline(handler_stats, line)) {
    if (line.find("cpu", 0) != 0) {
      continue;
    }
    if (line[3] == ' ') {
      cores_global_infos_.Update(line);
      continue;
    }

    cores_infos_.emplace_back(line);
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
    results[i] -= cores_infos_[i];
    results[i].ComputeRatio();
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
      if (cores_infos[i].excluded_) {
        --nb_elements;
      }
    }
  }

  std::sort(cores_infos.begin(), cores_infos.end(),
    [sort_index](CoreStats const& a, CoreStats const& b) {
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

ns_System::CoresMonitor::CoresMonitor() {
}

ns_System::CoresMonitor::~CoresMonitor() {
}

uint64_t ns_System::CoresMonitor::NbCores() const {
  return CoreStats::NbCores();
}

std::vector<uint64_t> ns_System::CoresMonitor::SelectMostIdleCores(uint64_t nb_cores, 
    std::vector<bool> const* cores_included) {
  std::vector<CoreStats> cores_values_ratio;
  {
    std::lock_guard<std::mutex> lock(lock_);
    cores_values_ratio = cores_ratio_infos_;
  }
  CoresStats::SortCoresValuesRatio(CoreStats::IDLE_INDEX,
      cores_values_ratio, cores_included);

  nb_cores = std::min<uint64_t>(nb_cores, cores_values_ratio.size());

  std::vector<uint64_t> core_ids;
  core_ids.reserve(nb_cores);
  for (size_t i=0; i<nb_cores; ++i) {
    core_ids.push_back(cores_values_ratio[i].id_);
  }

  return core_ids;
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
  lock_.lock();
  cores_ratio_infos_ = t0_.CoresValuesRatio(t1_);
  cores_global_ratio_infos_ = t0_.GlobalValuesRatio(t1_);
  lock_.unlock();
  t0_.Swap(std::move(t1_));
}

