#include "local.hxx"
#include "../step.hxx"
#include <signal.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <fstream>
#include <sstream>
#include <filesystem>
#include <set>
#include <iostream>

void ns_Executor::LocalData::ToJSON(rapidjson::Value& out, 
    rapidjson::Document::AllocatorType& alloc) const {
  out.AddMember("pid", static_cast<uint64_t>(pid_), alloc);
  out.AddMember("run_root_path", rapidjson::Value(run_root_path_.c_str(), alloc), alloc);
}

ns_Executor::Local::Local(std::string const& name, ns_Executor::LocalConfig const& config)
    : Executor(name), config_(config), nbCPUsFree_(config_.maxCPU_), 
      cpusFree_(config_.cpus_), nbChild_(0)
{
  if (nbCPUsFree_ == 0) {
    cpusFree_ = config_.cpus_;
    for(size_t i=0; i<cpusFree_.size(); ++i) {
      if (cpusFree_[i]) {
        ++nbCPUsFree_;
      }
    }
  }
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
  LocalData* localData = new LocalData();
  step.executor_data_ = localData;

  step.cpus_ = AssignCPU(step.nb_cpu_);
  nbCPUsFree_ -= step.nb_cpu_;

  localData->run_root_path_ = config_.runPath_ / step.RunRootPath();
  step.run_path_ = config_.runPath_ / step.run_path_;
  step.stdout_ = config_.runPath_ / step.stdout_;
  step.stderr_ = config_.runPath_ / step.stderr_;

  if (step.IsFirstStepOfTask()) {
    CreateRunFolders(localData->run_root_path_);
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
    if (!PinCoreToProcess(step.cpus_)) {
      std::cerr << "set core affinity failed" << std::endl;
      exit(-1);
    }
    if (chdir(step.run_path_.c_str()) != 0) {
      std::cerr << "chdir failed" << std::endl;
      exit(-1);
    }

    std::vector<char*> arg_strings;
    arg_strings.push_back(strdup("task"));
    arg_strings.push_back(strdup(step.FunctionsPath().c_str()));
    arg_strings.push_back(strdup(std::filesystem::path(localData->run_root_path_ /
        ".taskenv").c_str()));
    arg_strings.push_back(strdup(std::filesystem::path(localData->run_root_path_ /
        "output").c_str()));
    arg_strings.push_back(strdup(config_.scriptPath_.c_str()));
    arg_strings.push_back(strdup(step.FilesPath().c_str()));
    arg_strings.push_back(strdup(std::to_string(step.next_ == &step).c_str()));
    arg_strings.push_back(strdup(std::to_string(spid).c_str()));
    arg_strings.push_back(strdup(std::to_string(step.run_id_).c_str()));
    std::string cores;
    for(uint64_t core: step.cpus_) {
      cores += std::to_string(core) + ',';
    }
    cores.pop_back();
    arg_strings.push_back(strdup(cores.c_str()));
    arg_strings.push_back(strdup(step.function_.c_str()));
    arg_strings.push_back(strdup("---"));
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

    int retval = execv(script.c_str(), arg_strings.data());

    std::cerr << "Unable to excecute " << script << " : " 
        << strerror(errno) << std::endl;

    std::string step_name = "fe-" + std::to_string(step.step_id_) + "-" + 
        std::to_string(step.rank_id_) + "-" + std::to_string(step.attempt_id_);
    std::ofstream fatalErrorProf(localData->run_root_path_ / step_name);
    sync();

    exit(-1);
  }

  close(errhandler);
  close(outhandler);

  if (pid == -1) {
    throw std::runtime_error("Local Executor failed to fork " + 
        std::to_string(step.step_id_) + " : " + std::strerror(errno));
  }

  localData->pid_ = pid;
  step.MarkRunning();
  ++nbChild_;
}

std::list<ns_Schedule::Step*> ns_Executor::Local::CheckFinishedSteps(
    std::list<ns_Schedule::Step*>& runningSteps) {
  std::list<ns_Schedule::Step*> result;
  for(ns_Schedule::Step* step : runningSteps) {
    if ((step->IsDone()) || (step->executor_ != this)) {
      continue;
    }
    LocalData* localData = dynamic_cast<LocalData*>(step->executor_data_);
    if (localData == nullptr) {
      throw std::runtime_error("ExecutorData are not of type LocalData");
    }
    int status = 0;
    pid_t childPID = waitpid(localData->pid_, &status, WNOHANG);
    if ((childPID == -1) && (errno != EINTR)) {
      throw std::runtime_error(
          std::string("waitpid failed in CheckFinishedSteps: errno=") +
          std::to_string(errno) +
          " (" + std::strerror(errno) + ")");
    } else if (childPID == localData->pid_) {
      --nbChild_;
      kill(-childPID, SIGKILL);

      std::string step_fatal_error = "fe-" + std::to_string(step->step_id_) + "-" + 
          std::to_string(step->rank_id_) + "-" + std::to_string(step->attempt_id_);
      std::error_code ec;
      if (std::filesystem::exists(localData->run_root_path_ / step_fatal_error, ec)) {
        step->MarkDone(ns_Schedule::Step::exitCode_StepLaunchError_);
      } else {
        step->MarkDone(WEXITSTATUS(status));
      }
      ReleaseCPU(step->cpus_);
      result.push_back(step);
    }
  }

  return result;
}

void ns_Executor::Local::Shutdown(ns_Schedule::Step& step, bool wait) {
  LocalData* localData = dynamic_cast<LocalData*>(step.executor_data_);
  if (localData == nullptr) {
    throw std::runtime_error("ExecutorData are not of type LocalData");
  }
  kill(-localData->pid_, SIGKILL);
  if (wait) {
    waitpid(-localData->pid_, nullptr, 0);
  }
  ReleaseCPU(step.cpus_);
}

void ns_Executor::Local::FinalClean(std::filesystem::path const& savePath, 
    ns_Schedule::Task& task) {
  /*try {
    std::filesystem::path finalSavePath = savePath / std::to_string(step.TaskID());
    if (!std::filesystem::create_directory(finalSavePath)) {
      throw std::runtime_error("Save directory (" + finalSavePath.string() + ") already exist");
    }
    std::filesystem::rename(step.run_path_ / "output", finalSavePath / "output");
    std::filesystem::rename(step.run_path_ / ".output", finalSavePath / "logs");
  } catch(std::runtime_error const& e) {
    std::cerr << "Error while moving resultats from running to save storage\n" <<
        "All keep in " << step.run_path_ << "\n\t" << e.what();
    return;
  }
  for(std::filesystem::path const& path: { step.functions_path_, step.run_root_path_ }) {
  std::error_code ec;
    if (std::filesystem::remove_all(path, ec) == -1) {
      std::cerr << "Error while removing " << path << "\n" << 
          "\t" << ec.value() << ": " << ec.message() << std::endl;
    }
  }*/
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

bool ns_Executor::Local::PinCoreToProcess(std::vector<uint64_t> const& cores_) {
  std::set<uint64_t> coresSet;
  cpu_set_t mask;
  CPU_ZERO(&mask);
  for(uint64_t core : cores_) {
    CPU_SET(core, &mask);
    coresSet.insert(core);
  }

  if (sched_setaffinity(0, sizeof(mask), &mask) != 0) {
    std::cerr << "sched_setaffinity failed: " << strerror(errno) << std::endl;
    return false;
  }

  CPU_ZERO(&mask);
  if (sched_getaffinity(0, sizeof(mask), &mask) == 0) {
    for (int c = 0; c < CPU_SETSIZE; ++c) {
      if (CPU_ISSET(c, &mask)) {
        coresSet.erase(c);
      }
    }
  }

  return coresSet.empty();
}