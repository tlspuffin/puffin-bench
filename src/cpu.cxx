#include "schedule/executor/linux_cores.hxx"
#include <iostream>

int main() {

  ns_Executor::CoresMonitor cm(15);

  std::cout << "Nombre de CPUs logiques : " << cm.cores_infos_.NbCores() << std::endl;
  std::vector<ns_Executor::CoreStats> t0;
  std::vector<ns_Executor::CoreStats> t1;
  cm.cores_infos_.GatherInfos(t0);
  std::this_thread::sleep_for(std::chrono::seconds(3));
  cm.cores_infos_.GatherInfos(t1);

  std::vector<bool> excluded_cores(cm.cores_infos_.NbCores(), false);
  excluded_cores[0] = true;
  std::vector<ns_Executor::CoreStats> r = cm.cores_infos_.SortCoresValuesRatio(ns_Executor::CoreStats::IDLE_INDEX, t0, t1, &excluded_cores);

  for(auto const& core_perf: r) {
    std::cout << core_perf.id_ << ": "
      << core_perf.values_[ns_Executor::CoreStats::IDLE_INDEX] << ", "
      << (core_perf.excluded_ ? "T" : "F")
      << std::endl;
  }

  if (r.size() > 0) {
    std::cout << "CPU le moins occupé : CPU " << r.front().id_
        << " (idle moyen = " << r.front().values_[ns_Executor::CoreStats::IDLE_INDEX]
        << ")" << std::endl;
  }

  if (r.size() > 1) {
    std::cout << "CPU le plus occupé : CPU " << r.back().id_
      << " (idle moyen = " << r.back().values_[ns_Executor::CoreStats::IDLE_INDEX]
      << ")" << std::endl;
  }

  std::this_thread::sleep_for(std::chrono::seconds(20));

  r = cm.CoresValuesRatio();
  ns_Executor::CoresStats::SortCoresValuesRatio(ns_Executor::CoreStats::IDLE_INDEX, r, &excluded_cores);
  for(auto const& core_perf: r) {
    std::cout << core_perf.id_ << ": "
      << core_perf.values_[ns_Executor::CoreStats::IDLE_INDEX] << ", "
      << (core_perf.excluded_ ? "T" : "F")
      << std::endl;
  }

  return 0;
}
