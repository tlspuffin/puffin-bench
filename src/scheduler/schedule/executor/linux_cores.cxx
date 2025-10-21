#include "linux_cores.hxx"
#include <fstream>
#include <sstream>
#include <iostream>
#include <chrono>
#include <algorithm>
#include <stdexcept>

ns_Executor::CoreStats::CoreStats(uint64_t nb_values)
    : id_(-1), values_(nb_values, 0), excluded_(false)
{}

ns_Executor::CoreStats::CoreStats(uint64_t nb_values, std::string const& data)
    : id_(-1), values_(), excluded_(false)
{
  values_.reserve(nb_values);
  std::istringstream iss(data);
  std::string label;
  iss >> label;
  id_ = std::stoul(label.substr(3));
  uint64_t val;
  while (iss >> val) {
    values_.push_back(val);
  }
}

ns_Executor::CoreStats& ns_Executor::CoreStats::operator-=(ns_Executor::CoreStats const& other) {
  if (values_.size() != other.values_.size()) {
    throw std::runtime_error("CoreStats::operator-=: values_ size mismatch");
  }
  for(size_t i=0; i<values_.size(); ++i) {
    values_[i] -= other.values_[i];
  }
  return *this;
}

void ns_Executor::CoreStats::ComputeRatio() {
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

ns_Executor::CoresStats::CoresStats()
    : nb_cores_(0), nb_values_per_core_(0)
{
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
        ++nb_values_per_core_;
      }
      continue;
    }
    ++nb_cores_;
  }
}

uint64_t ns_Executor::CoresStats::NbCores() const {
  return nb_cores_;
}

void ns_Executor::CoresStats::GatherInfos(std::vector<ns_Executor::CoreStats>& cores_infos) {
  std::ifstream handler_stats("/proc/stat");
  if (!handler_stats.is_open()) {
     throw std::runtime_error("CoresStats::GatherInfos: Failed to open /proc/stat");
  }

  cores_infos.reserve(nb_cores_);
  cores_infos.clear();
  std::string line;
  while (std::getline(handler_stats, line)) {
    if (line.find("cpu", 0) != 0 || (line[3] == ' ')) {
      continue;
    }

    cores_infos.emplace_back(nb_values_per_core_, line);
  }
}

std::vector<ns_Executor::CoreStats> ns_Executor::CoresStats::CoresValuesRatio(
    std::vector<CoreStats> const& cores_infos_t0, 
    std::vector<CoreStats> const& cores_infos_t1) {
  if (cores_infos_t0.size() != cores_infos_t1.size()) {
    throw std::runtime_error(
        "CoresStats::CoresValuesRatio: Mismatched core info vectors - t0 size: " +
        std::to_string(cores_infos_t0.size()) + ", t1 size: " +
        std::to_string(cores_infos_t1.size()));
  }

  std::vector<CoreStats> results = cores_infos_t1;
  for(size_t i=0; i<results.size(); ++i) {
    results[i] -= cores_infos_t0[i];
    results[i].ComputeRatio();
  }

  return results;
}

std::vector<ns_Executor::CoreStats> ns_Executor::CoresStats::SortCoresValuesRatio(uint64_t sort_index, 
    std::vector<CoreStats> const& cores_infos_t0, 
    std::vector<CoreStats> const& cores_infos_t1,
    std::vector<bool> const* cores_included) {

  if ((cores_included != nullptr) &&
      (cores_infos_t1.size() != cores_included->size())) {
    throw std::runtime_error(
        "CoresStats::SortCoresValuesRatio: Size mismatch - core stats: " +
        std::to_string(cores_infos_t1.size()) +
        ", inclusions: " + std::to_string(cores_included->size()));
  }
  if (sort_index >= nb_values_per_core_) {
    throw std::runtime_error(
        "CoresStats::SortCoresValuesRatio: Invalid sort_index " +
        std::to_string(sort_index) + " (max index: " +
        std::to_string(nb_values_per_core_ - 1) + ")");
  }

  std::vector<CoreStats> results = CoresValuesRatio(cores_infos_t0, cores_infos_t1);
  SortCoresValuesRatio(sort_index, results, cores_included);

  return results;
}

void ns_Executor::CoresStats::SortCoresValuesRatio(uint64_t sort_index, 
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

  cores_infos.resize(nb_elements, { 0 });
}

ns_Executor::CoresMonitor::CoresMonitor(uint64_t time_interval)
    : time_interval_(time_interval), threadRunning_(true) {
  thread_ = std::thread(&CoresMonitor::ThreadLoop, this);
}

ns_Executor::CoresMonitor::~CoresMonitor() {
  threadRunning_.store(false);
  thread_.join();
}

std::vector<uint64_t> ns_Executor::CoresMonitor::SelectMostIdleCores(uint64_t nb_cores, 
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

std::vector<ns_Executor::CoreStats> ns_Executor::CoresMonitor::CoresValuesRatio() {
  std::lock_guard<std::mutex> lock(lock_);
  return cores_ratio_infos_;
}

void ns_Executor::CoresMonitor::ThreadLoop() {
  std::vector<CoreStats> t0;
  std::vector<CoreStats> t1;
  std::vector<CoreStats> cores_ratio_infos;

  lock_.lock();
  cores_infos_.GatherInfos(t0);
  if (!ThreadWaitOrStop(time_interval_)) {
    lock_.unlock();
    return;
  }
  cores_infos_.GatherInfos(t1);
  cores_ratio_infos = cores_infos_.CoresValuesRatio(t0, t1);

  while(true) {
    cores_ratio_infos_.swap(cores_ratio_infos);
    lock_.unlock();

    t0.swap(t1);
    if (!ThreadWaitOrStop(time_interval_)) {
      return;
    }
    cores_infos_.GatherInfos(t1);
    cores_ratio_infos = cores_infos_.CoresValuesRatio(t0, t1);

    lock_.lock();
  }
}

bool ns_Executor::CoresMonitor::ThreadWaitOrStop(uint64_t wait_time_s) {
  for (uint64_t i=0; i<wait_time_s; ++i) {
    std::this_thread::sleep_for(std::chrono::seconds(1));
    if (!threadRunning_.load()) return false;
  }
  return true;
}
