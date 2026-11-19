#include "cpuset.hxx"

#include <fstream>

std::vector<uint64_t> ns_System::CpusNoStepHolds(std::vector<bool> const& coresFree, std::vector<bool> const& coresOfExecutor) {
  std::vector<uint64_t> cpus;
  for (size_t i = 0; i < coresFree.size(); ++i) {
    if (coresFree[i] || (i >= coresOfExecutor.size()) || !coresOfExecutor[i]) {
      cpus.push_back(i);
    }
  }
  return cpus;
}

std::string ns_System::CpuList(std::vector<uint64_t> const& cpus) {
  std::string list;
  for (uint64_t cpu : cpus) {
    list += (list.empty() ? "" : ",") + std::to_string(cpu);
  }
  return list;
}

bool ns_System::WriteCgroupCpus(std::filesystem::path const& cgroup, std::string const& cpus) {
  std::error_code ec;
  if (cgroup.empty() || !std::filesystem::exists(cgroup / "cpuset.cpus", ec)) {
    return false;
  }
  std::ofstream ofs(cgroup / "cpuset.cpus");
  ofs << cpus;
  ofs.close();
  return !ofs.fail();
}
