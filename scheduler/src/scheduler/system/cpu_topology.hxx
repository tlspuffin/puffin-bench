#pragma once

#include <cstdint>
#include <filesystem>
#include <string>
#include <vector>

namespace ns_System {

// How the logical CPUs of the machine map onto physical cores and NUMA nodes (Linux sysfs). With SMT
// (hyper-threading) a physical core runs two logical CPUs that share its execution units: a fuzzer client on one of
// them runs slower when the other one is busy, so where the CPUs of a step lie decides how fast it runs.
struct CpuTopology {
  // per logical CPU: index of its physical core in coreCpus_ (-1: offline or unknown), its NUMA node (0 when unknown)
  std::vector<int64_t> coreOf_;
  std::vector<int64_t> nodeOf_;
  // logical CPUs of each physical core, ascending
  std::vector<std::vector<uint64_t>> coreCpus_;

  // from sysfs (<sysCpu>/cpuN/topology/thread_siblings_list, <sysCpu>/cpuN/nodeK); nbCpus: the CPUs to describe
  static CpuTopology Read(uint64_t nbCpus, std::filesystem::path const& sysCpu = "/sys/devices/system/cpu");
  // one physical core per logical CPU, one node: the layout assumed when sysfs cannot be read
  static CpuTopology Flat(uint64_t nbCpus);
  // the largest number of logical CPUs of a physical core (2 with SMT, 1 without)
  uint64_t ThreadsPerCore() const;
};

// How the CPUs of a step are chosen:
//   pairs: whole physical cores, all their threads to the step (its clients share cores only with each other); the
//          thread left over by an odd number of CPUs stays idle, reserved by the step
//   one:   one thread of each physical core, the other ones reserved by the step and idle (each client alone on its
//          core, twice the CPUs)
//   any:   logical CPUs whatever their cores (the former behaviour: two steps can share a physical core)
enum class SmtMode { Pairs, One, Any };
bool ParseSmtMode(std::string const& text, SmtMode& mode);
std::string SmtModeName(SmtMode mode);

struct CpuAllocation {
  std::vector<uint64_t> cpus_;  // given to the step
  std::vector<uint64_t> idle_;  // reserved by the step, left idle (the other threads of its physical cores)
};

// The logical CPUs a step of nbCpus CPUs consumes in that mode (given and idle), for the capacity of the executor
uint64_t CpusConsumed(CpuTopology const& topology, uint64_t nbCpus, SmtMode mode);

// Whole physical cores for nbCpus CPUs (pairs, one), among the free ones (free[cpu]: free and part of the executor's
// CPUs; a physical core is free when all its threads are): on one NUMA node when one has enough (the node with the
// fewest free cores that is enough, which keeps the larger ones for larger steps), else on as few nodes as possible.
// False when there are not enough free physical cores (the step waits). Not for SmtMode::Any.
bool AllocatePhysicalCores(CpuTopology const& topology, std::vector<bool> const& free, uint64_t nbCpus,
    SmtMode mode, CpuAllocation& allocation);

}
