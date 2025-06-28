#include "schedule.hxx"
#include <stdlib.h>
#include <iostream>
#include <sstream>
#include <stack>
#include <unordered_set>
#include <algorithm>
#include <fcntl.h>
#include <sys/wait.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <rapidjson/filereadstream.h>
#include <rapidjson/error/en.h>

#undef RAPIDJSON_ASSERT
#define RAPIDJSON_ASSERT(x) { throw std::runtime_error(x); }

ns_Schedule::Schedule::Schedule(std::string const& script_path, std::string const& run_path, 
    uint64_t maxCPU) 
    : tasksManager_(run_path), script_path_(script_path), run_path_(run_path), 
      maxCPU_(maxCPU), threadRunning_(false)
{
}

ns_Schedule::Schedule::~Schedule() {
  lockThread_.lock();
  if (threadRunning_) {
    threadRunning_ = false;
    if (thread_.joinable()) {
      lockThread_.unlock();
      thread_.join();
      lockThread_.lock();
    }
  }
  for(ns_Schedule::Step* rootStep : tasks_) {
    try {
      tasksManager_.DeleteTask(rootStep);
    } catch(std::exception const& e) {
      std::cerr << "DeleteTask exception: " << e.what() << std::endl;
    }
  }

  lockThread_.unlock();
}

bool ns_Schedule::Schedule::AddJob(std::string tasksList, std::vector<std::string> files) {
  FILE* fTasksList = fopen(tasksList.c_str(), "r");
  char buffer[65536];
  rapidjson::FileReadStream isTasks(fTasksList, buffer, sizeof(buffer));

  rapidjson::Document stepsJSON;
  stepsJSON.ParseStream(isTasks);
  fclose(fTasksList);

  if (stepsJSON.HasParseError()) {
    throw std::runtime_error(
        std::string("Parsing JSON Error : ") +
        rapidjson::GetParseError_En(stepsJSON.GetParseError()) +
        " byte " + std::to_string(stepsJSON.GetErrorOffset())
    );
  }

  std::list<ns_Schedule::Step*> steps = tasksManager_.ReadJsonConfig(stepsJSON);

  lockThread_.lock();

  for(ns_Schedule::Step* step : steps) {
    tasks_.push_back(step);
    steps_.push_back(step);
  }
  
  if (!threadRunning_) {
    if (thread_.joinable()) {
      lockThread_.unlock();
      thread_.join();
      lockThread_.lock();
    }
    threadRunning_ = true;
    thread_ = std::thread(&ns_Schedule::Schedule::ScheduleLoop, this);
  }
  lockThread_.unlock();

  return true;
}

std::list<ns_Schedule::Step*> ns_Schedule::Schedule::SearchTaskToRun(uint64_t nbCPUsFree, std::list<ns_Schedule::Step*>& tasks) {
  std::list<ns_Schedule::Step*> result;

  for(ns_Schedule::Step* step : tasks) {
    uint64_t nbCPUsRequired = step->nb_cpu_;
    if ((!step->IsReady()) || (nbCPUsRequired > nbCPUsFree)) {
      continue;
    }
    nbCPUsFree -= nbCPUsRequired;
    result.push_back(step);
  }

  return result;
}

inline std::vector<uint64_t> AssignCPU(std::vector<bool>& cpusFree, uint64_t nbCPU) {
  std::vector<uint64_t> result;
  for (size_t i=0; i<cpusFree.size(); ++i) {
    if (cpusFree[i]) {
      cpusFree[i] = false;
      result.push_back(i);
      if (--nbCPU == 0) {
        break;
      };
    }
  }
  return result;
}

inline void ReleaseCPU(uint64_t& nbCPUsFree, std::vector<bool>& cpusFree, std::vector<uint64_t>& cpus) {
  for(uint64_t index: cpus) {
    cpusFree[index] = true;
  }
  nbCPUsFree += cpus.size();
}

inline bool RedirectOutput(int outhandler, int errhandler) {
  return ((close(1) == 0) && (dup(outhandler) == 1) && (close(outhandler) == 0) &&
      (close(2) == 0) && (dup(errhandler) == 2) && (close(errhandler) == 0));
}

pid_t ns_Schedule::Schedule::Execute(ns_Schedule::Step* step) {
  printf("%lu %lu %lu\n", step->step_id_, step->rank_id_, step->attempt_id_);
  if (step->IsFirstStepOfTask()) {
    if (mkdir(step->run_path_.c_str(), 0777) != 0) {
      throw std::runtime_error(
          std::string("mkdir failed: errno=") +
          std::to_string(errno) +
          " (" + std::strerror(errno) + ")"
      );
    }
    if (mkdir(std::string(step->run_path_ + "/.output").c_str(), 0777) != 0) {
      throw std::runtime_error(
          std::string("mkdir failed: errno=") +
          std::to_string(errno) +
          " (" + std::strerror(errno) + ")"
      );
    }
  }
  int outhandler = open(step->stdout_.c_str(), O_CREAT | O_TRUNC | O_WRONLY, 00660);
  if (outhandler == -1) {
    throw std::runtime_error(
        std::string("open stdout failed for: ") + step->stdout_ + std::string(" : errno=") +
        std::to_string(errno) +
        " (" + std::strerror(errno) + ")"
    );
  }
  int errhandler = open(step->stderr_.c_str(), O_CREAT | O_TRUNC | O_WRONLY, 00660);
  if (errhandler == -1) {
    throw std::runtime_error(
        std::string("open stderr failed: errno=") +
        std::to_string(errno) +
        " (" + std::strerror(errno) + ")"
    );
  }

  pid_t pid = fork();
  if (pid == 0) {
    pid_t spid = setsid();
    if (spid == -1) {
      exit(-1);
    }
    if (chdir(step->run_path_.c_str()) != 0) {
      std::cerr << "chdir failed" << std::endl;
      exit(-1);
    }

    std::vector<char*> arg_strings;
    arg_strings.push_back(strdup("run_task"));
    arg_strings.push_back(strdup(std::string(script_path_ + "/campaign.conf").c_str()));
    arg_strings.push_back(strdup(std::string(run_path_ + "/" + std::to_string(step->task_id_) +
        "/.taskenv").c_str()));
    arg_strings.push_back(strdup(std::to_string(spid).c_str()));
    arg_strings.push_back(strdup(std::to_string(step->rank_id_).c_str()));
    arg_strings.push_back(strdup(step->function_.c_str()));
    std::istringstream iss(step->args_);
    std::string token;
    while (iss >> token) {
      arg_strings.push_back(strdup(token.c_str()));
    }
    arg_strings.push_back(nullptr);
    std::string script = script_path_ + "/executor.sh";

    if (!RedirectOutput(outhandler, errhandler)) {
      std::cerr << "RedirectOutput failed" << std::endl;
      exit(-1);
    }

    int retval = execv(script.c_str(), arg_strings.data());

    std::cerr << strerror(errno) << std::endl;
    exit(-1);
  }
  close(errhandler);
  close(outhandler);
  step->pid_ = pid;
  return pid;
}

void ns_Schedule::Schedule::ScheduleLoop() {
  std::vector<pid_t> pids;
  std::vector<bool> cpusFree(maxCPU_, true);
  uint64_t nbCPUsFree = maxCPU_;
  lockThread_.lock();
  while((!steps_.empty()) && (threadRunning_)) {
    std::list<ns_Schedule::Step*> toRun = SearchTaskToRun(nbCPUsFree, steps_);
    lockThread_.unlock();

    
    for(ns_Schedule::Step* step : toRun) {
      step->cpus_ = AssignCPU(cpusFree, step->nb_cpu_);
      nbCPUsFree -= step->nb_cpu_;
      step->MarkRunning();
      Execute(step);
    }

    pid_t childPID = -1;
    int status = 0;
    while(threadRunning_) {
      childPID = waitpid(-1, &status, WNOHANG);
      if (childPID == -1) {
        if (errno == EINTR) {
          continue;
        }
        throw std::runtime_error(
            std::string("waitpid failed in ScheduleLoop: errno=") +
            std::to_string(errno) +
            " (" + std::strerror(errno) + ")"
        );
      } else if (childPID == 0) {
        sleep(1);
      } else {
        kill(-childPID, SIGKILL);
        break;
      }
    }

    ns_Schedule::Step* stepDone = nullptr;
    for(ns_Schedule::Step* step : toRun) {
      if (step->pid_ != childPID) {
        continue;
      }
      step->exit_code_ = WEXITSTATUS(status);
      step->MarkDone();
      ReleaseCPU(nbCPUsFree, cpusFree, step->cpus_);
      stepDone = step;
      break;
    }

    lockThread_.lock();
    if (stepDone != nullptr) {
      toRun.remove(stepDone);
      try {
        ManageEndOfStep(stepDone);
      } catch(std::runtime_error& e) {
        threadRunning_ = false;
        lockThread_.unlock();
        printf("Exception S\n");
        throw e;
      }
    }
  }
  for (ns_Schedule::Step* step: steps_) {
    if (step->IsRunning()) {
      kill(-step->pid_, SIGKILL);
      waitpid(step->pid_, nullptr, 0);
    }
  }
  threadRunning_ = false;
  printf("Done S\n");
  lockThread_.unlock();
}

void ns_Schedule::Schedule::ManageEndOfStep(ns_Schedule::Step* step) {
  auto itStep = std::find(steps_.begin(), steps_.end(), step);
  if (itStep != steps_.end()) {
    for (auto rit = step->dependencies_.rbegin(); rit != step->dependencies_.rend(); ++rit) {
      ns_Schedule::Step* stepChild = *rit;
      stepChild->depend_from_.remove(step);
      if (stepChild->depend_from_.size() == 0) {
        steps_.insert(itStep, stepChild);
      }
    }
  } else {
    throw std::runtime_error("Trying to delete a non-root task: name=" +
        step->name_ + ", uuid=" + std::to_string(step->uuid_));
  }
  steps_.remove(step);
  if (step->dependencies_.empty()) {
    bool allStepDone = true;
    for(ns_Schedule::Step* itStep = step->next_; itStep != step; itStep = itStep->next_) {
      allStepDone &= itStep->IsDone();
    }
    if (allStepDone) {
      // todo signal end of the flow
      std::string clean_cmd = "rm -rf " + step->run_path_;
      if (system(clean_cmd.c_str()) != 0 ) {
        throw std::runtime_error("Unable to clean folder: " +
            step->run_path_ + ", after strep name=" + step->name_);
      }
      std::cout << "Tasks " << step->task_id_ << " done" << std::endl;
    }
  }
}