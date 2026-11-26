#include "scheduler/system/linux_cores.hxx"
#include <iostream>

int main() {

  ns_System::CoresStats t0;
  ns_System::CoresStats t1;

  std::cout << "Nombre de CPUs logiques : " << ns_System::CoresStats::NbCores() << std::endl;
  t0.GatherInfos();
  std::this_thread::sleep_for(std::chrono::seconds(3));
  t1.GatherInfos();

  std::vector<bool> included_cores(ns_System::CoresStats::NbCores(), true);
  included_cores[0] = false;
  std::vector<ns_System::CoreStats> r = t0.SortCoresValuesRatio(ns_System::CoreStats::IDLE_INDEX, t1, &included_cores);

  for(auto const& core_perf: r) {
    std::cout << core_perf.id_ << ": "
      << core_perf.values_[ns_System::CoreStats::IDLE_INDEX] << ", "
      << (core_perf.excluded_ ? "T" : "F")
      << std::endl;
  }

  if (r.size() > 0) {
    std::cout << "CPU le moins occupé : CPU " << r.front().id_
        << " (idle moyen = " << r.front().values_[ns_System::CoreStats::IDLE_INDEX]
        << ")" << std::endl;
  }

  if (r.size() > 1) {
    std::cout << "CPU le plus occupé : CPU " << r.back().id_
      << " (idle moyen = " << r.back().values_[ns_System::CoreStats::IDLE_INDEX]
      << ")" << std::endl;
  }

  t0.GatherInfos();
  std::this_thread::sleep_for(std::chrono::seconds(20));
  t1.GatherInfos();

  r = t0.CoresValuesRatio(t1);
  ns_System::CoresStats::SortCoresValuesRatio(ns_System::CoreStats::IDLE_INDEX, r, &included_cores);
  for(auto const& core_perf: r) {
    std::cout << core_perf.id_ << ": "
      << core_perf.values_[ns_System::CoreStats::IDLE_INDEX] << ", "
      << (core_perf.excluded_ ? "T" : "F")
      << std::endl;
  }

  return 0;
}
