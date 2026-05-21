#include "linux_process.hxx"
#include "../../utils/logs.hxx"
#include <sys/types.h>
#include <dirent.h>
#include <string>
#include <fstream>

std::vector<pid_t> ns_System::ProcessMonitor::GetPidsBySid(pid_t sid) {
  LOGD << "Looking for orphans of session " << sid << Log::Flags::End;
  std::vector<pid_t> pids;

  DIR* proc_dir = opendir("/proc");
  if (!proc_dir) {
    return pids;
  }

  struct dirent* entry;
  while ((entry = readdir(proc_dir)) != nullptr) {
    if (entry->d_type != DT_DIR) {
      continue;
    }
    char* endptr;
    pid_t pid = strtol(entry->d_name, &endptr, 10);
    if (*endptr != '\0') {
      continue;
    }

    std::string stat_path = "/proc/" + std::string(entry->d_name) + "/stat";
    std::ifstream stat_file(stat_path);
    if (!stat_file.is_open()) {
      continue;
    }
    std::string line;
    if (!std::getline(stat_file, line)) {
      continue;
    }      
    size_t comm_end = line.rfind(')');
    if (comm_end == std::string::npos) {
      continue;
    }
    std::string after_comm = line.substr(comm_end + 2);

    LOGD << "Linux process checking " << std::string(entry->d_name) << " : " << after_comm << Log::Flags::End;

    int field_count = 0;
    pid_t psid = 0;
    size_t pos = 0;
    while (field_count < 4 && pos < after_comm.size()) {
      size_t next_space = after_comm.find(' ', pos);
      if (next_space == std::string::npos) {
        next_space = after_comm.size();
      }
            
      field_count++;
      if (field_count == 4) {
        psid = strtol(after_comm.c_str() + pos, nullptr, 10);
      }
      pos = next_space + 1;
    }
        
    if (psid == sid) {
      pids.push_back(pid);
    }
  }
    
  closedir(proc_dir);
  return pids;
}