#pragma once

#include <cstdint>
#include <filesystem>
#include <string>
#include <vector>

namespace ns_System {

// The CPUs no step holds: those free in the executor's pool and those outside it (coresFree, coresOfExecutor: one entry
// per logical CPU). The other processes of the machine (the systemd slices) and the scheduler's own threads (its server
// cgroup) are kept on them, off the CPUs of the steps and the idle threads beside them
std::vector<uint64_t> CpusNoStepHolds(std::vector<bool> const& coresFree, std::vector<bool> const& coresOfExecutor);

// "3,4,17": CPUs as the steps get them (THEJOB_CORES), as systemctl (AllowedCPUs) and cgroup v2 (cpuset.cpus) take them
std::string CpuList(std::vector<uint64_t> const& cpus);

// writes the CPUs of a cgroup v2 (<cgroup>/cpuset.cpus); false when it cannot (no such cgroup, no cpuset controller)
bool WriteCgroupCpus(std::filesystem::path const& cgroup, std::string const& cpus);

}  // namespace ns_System
