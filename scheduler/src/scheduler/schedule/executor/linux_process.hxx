#pragma once

#include <unistd.h>
#include <vector>

namespace ns_Executor {

class Process {
public:
  static std::vector<pid_t> GetPidsBySid(pid_t sid);
};

};