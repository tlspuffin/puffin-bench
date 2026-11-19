// Checks of the CPUs the scheduler keeps the other processes and its own threads on (ns_System::CpusNoStepHolds) and of
// their writing into a cgroup (ns_System::WriteCgroupCpus, on a fake cgroup folder): exit status 0 when every check passes.
#include "scheduler/system/cpuset.hxx"
#include <filesystem>
#include <fstream>
#include <iostream>
#include <string>
#include <vector>
#include <unistd.h>

using namespace ns_System;

static int failures = 0;
static void Check(bool ok, std::string const& what) {
  std::cout << (ok ? "ok   " : "FAIL ") << what << std::endl;
  if (!ok) ++failures;
}

int main() {
  // 8 CPUs; the executor has 1-7 (0 kept for the machine); a step holds 2, 3 and the idle thread 6 beside them
  std::vector<bool> ofExecutor { false, true, true, true, true, true, true, true };
  std::vector<bool> free { false, true, false, false, true, true, false, true };
  Check(CpuList(CpusNoStepHolds(free, ofExecutor)) == "0,1,4,5,7", "the CPUs no step holds: the free ones and those outside the executor");
  Check(CpuList(CpusNoStepHolds(ofExecutor, ofExecutor)) == "0,1,2,3,4,5,6,7", "no step: every CPU");
  // the scheduler's own cgroup (its server folder): cpuset.cpus written; a folder without the file: refused
  std::filesystem::path dir = std::filesystem::temp_directory_path() / ("test_cpuset_" + std::to_string(::getpid()));
  std::filesystem::create_directories(dir / "server");
  { std::ofstream(dir / "server" / "cpuset.cpus") << ""; }
  bool wrote = WriteCgroupCpus(dir / "server", "0,1,4,5,7");
  std::string got; { std::ifstream ifs(dir / "server" / "cpuset.cpus"); std::getline(ifs, got); }
  Check(wrote && got == "0,1,4,5,7", "the scheduler's server cgroup gets the CPUs no step holds");
  Check(!WriteCgroupCpus(dir / "none", "0"), "no such cgroup: refused, nothing written");
  std::filesystem::remove_all(dir);
  return failures == 0 ? 0 : 1;
}
