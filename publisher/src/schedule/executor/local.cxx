#include "local.hxx"
#include "../step.hxx"
#include <signal.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <fstream>
#include <sstream>
#include <filesystem>
#include <iostream>

ns_Executor::Local::Local(std::string const& name, ns_Executor::LocalConfig const& config)
    : Executor(name), config_(config), nbCPUsFree_(config_.maxCPU_), 
      cpusFree_(config_.maxCPU_, true), nbChild_(0)
{
}

std::list<ns_Schedule::Step*> ns_Executor::Local::FindRunnableSteps(
    std::list<ns_Schedule::Step*> const& tasks) const {
  uint64_t nbCPUsFree = nbCPUsFree_;
  std::list<ns_Schedule::Step*> result;

  for(ns_Schedule::Step* step : tasks) {
    uint64_t nbCPUsRequired = step->nb_cpu_;
    if (!step->IsReady() || nbCPUsRequired > nbCPUsFree) {
      continue;
    }
    nbCPUsFree -= nbCPUsRequired;
    result.push_back(step);
  }

  return result;
}

inline bool RedirectOutput(int outhandler, int errhandler){
  return ((close(1) == 0) && (dup(outhandler) == 1) && (close(outhandler) == 0) &&
      (close(2) == 0) && (dup(errhandler) == 2) && (close(errhandler) == 0));
}

void ns_Executor::Local::Execute(ns_Schedule::Step& step) {
  step.cpus_ = AssignCPU(step.nb_cpu_);
  nbCPUsFree_ -= step.nb_cpu_;

  step.run_root_path_ = config_.runPath_ / step.run_root_path_;
  step.run_path_ = config_.runPath_ / step.run_path_;
  step.stdout_ = config_.runPath_ / step.stdout_;
  step.stderr_ = config_.runPath_ / step.stderr_;

  if (step.IsFirstStepOfTask()) {
    CreateRunFolders(step.run_root_path_);
  }

  std::error_code ec;
  if (!std::filesystem::create_directories(step.run_path_, ec)) {
    throw std::runtime_error(
        std::string("create dir ") + step.run_path_.string() + std::string("/.output failed: errno=") +
        std::to_string(ec.value()) +
        " (" + ec.message() + ")"
    );
  }
  int outhandler = open(step.stdout_.c_str(), O_CREAT | O_TRUNC | O_WRONLY, 00660);
  if (outhandler == -1) {
    throw std::runtime_error(
        std::string("open stdout failed for: ") + step.stdout_.string() + std::string(" : errno=") +
        std::to_string(errno) +
        " (" + std::strerror(errno) + ")"
    );
  }
  int errhandler = open(step.stderr_.c_str(), O_CREAT | O_TRUNC | O_WRONLY, 00660);
  if (errhandler == -1) {
    close(outhandler);
    throw std::runtime_error(
        std::string("open stderr failed for: ") + step.stderr_.string() + std::string(" : errno=") +
        std::to_string(errno) +
        " (" + std::strerror(errno) + ")"
    );
  }

  pid_t pid = fork();
  if (pid == 0) {
    pid_t spid = setsid();
    if (spid == -1) {
      std::cerr << "setsid failed" << std::endl;
      exit(-1);
    }
    if (chdir(step.run_path_.c_str()) != 0) {
      std::cerr << "chdir failed" << std::endl;
      exit(-1);
    }

    std::vector<char*> arg_strings;
    arg_strings.push_back(strdup("task"));
    arg_strings.push_back(strdup(step.functions_path_.c_str()));
    arg_strings.push_back(strdup(std::filesystem::path(step.run_root_path_ /
        ".taskenv").c_str()));
    arg_strings.push_back(strdup(std::filesystem::path(step.run_root_path_ /
        "output").c_str()));
    arg_strings.push_back(strdup(std::to_string(spid).c_str()));
    arg_strings.push_back(strdup(std::to_string(step.rank_id_).c_str()));
    arg_strings.push_back(strdup(step.function_.c_str()));
    std::istringstream iss(step.args_);
    std::string token;
    while (iss >> token) {
      arg_strings.push_back(strdup(token.c_str()));
    }
    arg_strings.push_back(nullptr);
    std::filesystem::path script = config_.scriptPath_ / "executor.sh";

    if (!RedirectOutput(outhandler, errhandler)) {
      std::cerr << "RedirectOutput failed" << std::endl;
      exit(-1);
    }

    std::cerr << "Doing execve" << std::endl;
    int retval = execv(script.c_str(), arg_strings.data());

    std::cerr << "Unable to excecute " << script << " : " 
        << strerror(errno) << std::endl;

    std::string step_name = "fe-" + std::to_string(step.step_id_) + "-" + 
        std::to_string(step.rank_id_) + "-" + std::to_string(step.attempt_id_);
    std::ofstream fatalErrorProf(step.run_root_path_ / step_name);
    sync();

    exit(-1);
  }

  close(errhandler);
  close(outhandler);

  if (pid == -1) {
    throw std::runtime_error("Local Executor failed to fork " + 
        std::to_string(step.step_id_) + " : " + std::strerror(errno));
  }

  step.MarkRunning(pid);
  ++nbChild_;
}

std::list<ns_Schedule::Step*> ns_Executor::Local::CheckFinishedSteps(
    std::list<ns_Schedule::Step*>& runningSteps) {
  std::list<ns_Schedule::Step*> result;
  if (nbChild_ == 0) {
    return result;
  }
  pid_t childPID = -1;
  int status = 0;
  for (childPID = waitpid(-1, &status, WNOHANG); (childPID > 0); 
      childPID = waitpid(-1, &status, WNOHANG)) {
    for(ns_Schedule::Step* step : runningSteps) {
      if (step->PID() == childPID) {
        --nbChild_;
        kill(-childPID, SIGKILL);

        std::string step_name = "fe-" + std::to_string(step->step_id_) + "-" + 
            std::to_string(step->rank_id_) + "-" + std::to_string(step->attempt_id_);
        std::error_code ec;
        if (std::filesystem::exists(step->run_root_path_ / step_name, ec)) {
          step->MarkDone(ns_Schedule::Step::exitCode_StepLaunchError_);
        } else {
          step->MarkDone(WEXITSTATUS(status));
        }
        ReleaseCPU(step->cpus_);
        result.push_back(step);
        break;
      }
    }
    if (nbChild_ == 0) {
      break;
    }
  }
  if ((childPID == -1) && (errno != EINTR)) {
    throw std::runtime_error(
        std::string("waitpid failed in CheckFinishedSteps: errno=") +
        std::to_string(errno) +
        " (" + std::strerror(errno) + ")");
  }
  return result;
}

void ns_Executor::Local::Shutdown(ns_Schedule::Step& step, bool wait) {
  kill(-step.PID(), SIGKILL);
  if (wait) {
    waitpid(-step.PID(), nullptr, 0);
  }
}

void ns_Executor::Local::FinalClean(ns_Schedule::Step& step) {
  std::string clean_cmd = "rm -rf " + step.run_root_path_.string() + " " + 
      step.functions_path_.string();
  if (system(clean_cmd.c_str()) != 0 ) {
    throw std::runtime_error("Unable to clean folder: " +
        step.run_path_.string() + " and " + step.functions_path_.string() +
        ", after step name=" + step.name_);
  }
}

inline std::vector<uint64_t> ns_Executor::Local::AssignCPU(uint64_t nbCPU) {
  std::vector<uint64_t> result;
  for (size_t i=0; i<cpusFree_.size(); ++i) {
    if (cpusFree_[i]) {
      cpusFree_[i] = false;
      result.push_back(i);
      if (--nbCPU == 0) {
        break;
      };
    }
  }
  return result;
}

inline void ns_Executor::Local::ReleaseCPU(std::vector<uint64_t>& cpus) {
  for(uint64_t index: cpus) {
    cpusFree_[index] = true;
  }
  nbCPUsFree_ += cpus.size();
}

void ns_Executor::Local::CreateRunFolders(std::filesystem::path const& path) {
  std::error_code ec;
  if (!std::filesystem::create_directories(path, ec)) {
    throw std::runtime_error(
        "create dir " + path.string() + std::string(" failed: errno=") +
        std::to_string(ec.value()) + " (" + ec.message() + ")"
    );
  }
  if (!std::filesystem::create_directories(path / ".output", ec)) {
    throw std::runtime_error(
        "create dir " + (path / ".output").string() +
        " failed: errno=" + std::to_string(ec.value()) +
        " (" + ec.message() + ")"
    );
  }
  if (!std::filesystem::create_directories(path / "output", ec)) {
    throw std::runtime_error(
        "create dir " + (path / "output").string() +
        " failed: errno=" + std::to_string(ec.value()) +
        " (" + ec.message() + ")"
    );
  }
}