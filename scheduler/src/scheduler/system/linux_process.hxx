#pragma once

#include <unistd.h>
#include <vector>

namespace ns_System {

class ProcessMonitor {
public:
  static std::vector<pid_t> GetPidsBySid(pid_t sid);
};

};