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
#include <rapidjson/istreamwrapper.h>

void ns_Executor::LocalData::ToJSON(rapidjson::Value& out, 
    rapidjson::Document::AllocatorType& alloc) const {
  rapidjson::Value cores(rapidjson::kArrayType);
  for (auto core : cores_) {
    cores.PushBack(core, alloc);
  }
  out.AddMember("cores", cores, alloc);
  out.AddMember("run_path", rapidjson::Value(run_path_.c_str(), alloc), alloc);
  out.AddMember("pid", static_cast<uint64_t>(pid_), alloc);
  out.AddMember("artefacts_path", rapidjson::Value(artefacts_path_.c_str(), alloc), alloc);
}

void ns_Executor::LocalTaskData::ToJSON(rapidjson::Value& out, 
    rapidjson::Document::AllocatorType& alloc) const {
  out.AddMember("log_path", rapidjson::Value(log_path_.c_str(), alloc), alloc);
  out.AddMember("env_path", rapidjson::Value(env_path_.c_str(), alloc), alloc);
  out.AddMember("common_path", rapidjson::Value(common_path_.c_str(), alloc), alloc);
  out.AddMember("output_path", rapidjson::Value(output_path_.c_str(), alloc), alloc);
}

ns_Executor::Local::Local(std::string const& name, ns_Executor::LocalConfig const& config)
    : Executor(name), config_(config), coresMonitor_(15), nbCoresFree_(config_.nbCores_), 
      coresFree_(config_.cores_), nbChild_(0)
{
  if (nbCoresFree_ == 0) {
    coresFree_ = config_.cores_;
    for(size_t i=0; i<coresFree_.size(); ++i) {
      if (coresFree_[i]) {
        ++nbCoresFree_;
      }
    }
  }
}

std::list<ns_Schedule::Step*> ns_Executor::Local::FindRunnableSteps(
    std::list<ns_Schedule::Step*> const& steps) const {
  uint64_t nbCoresFree = nbCoresFree_;
  std::list<ns_Schedule::Step*> result;

  for(auto step : steps) {
    uint64_t nbCoresRequired = step->nb_cores_;
    if (!step->IsReady() || nbCoresRequired > nbCoresFree) {
      continue;
    }
    nbCoresFree -= nbCoresRequired;
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

  LocalTaskData* localTaskData = nullptr;
  auto executorIT = step.task_->executors_.find(this);
  if (executorIT != step.task_->executors_.end()) {
    localTaskData = dynamic_cast<ns_Executor::LocalTaskData*>(executorIT->second);
    if (localData == nullptr) {
      throw std::runtime_error("ExecutorTaskData are not of type LocalTaskData");
    }
  } else {
    localTaskData = new LocalTaskData();
    step.task_->executors_.insert(std::make_pair<>(this, localTaskData));
  }

  localData->cores_ = AssignCores(step.nb_cores_);
  nbCoresFree_ -= step.nb_cores_;

  localTaskData->log_path_ = step.task_->run_root_path_ / ".output";
  localTaskData->env_path_ = step.task_->run_root_path_ / ".taskenv";
  localTaskData->output_path_ = step.task_->run_root_path_ / "output";
  localTaskData->common_path_ = step.task_->run_root_path_ / "common";
  localData->run_path_ = step.task_->run_root_path_ / step.ID();
  step.stdout_ = localTaskData->log_path_ / step.stdout_;
  step.stderr_ = localTaskData->log_path_ / step.stderr_;
  localData->artefacts_path_ = localData->run_path_ / ".artefacts";

  if (step.IsFirstStepOfTask()) {
    CreateRunFolders(localTaskData);
  }

  std::error_code ec;
  if (!std::filesystem::create_directories(localData->run_path_, ec)) {
    throw std::runtime_error(
        std::string("create dir ") + localData->run_path_.string() + 
        std::string("/.output failed: errno=") + std::to_string(ec.value()) +
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
    if (!PinCoresToProcess(localData->cores_)) {
      std::cerr << "set core affinity failed" << std::endl;
      exit(-1);
    }
    if (chdir(localData->run_path_.c_str()) != 0) {
      std::cerr << "chdir failed" << std::endl;
      exit(-1);
    }

    std::vector<char*> arg_strings;
    arg_strings.push_back(strdup("task"));
    arg_strings.push_back(strdup(step.task_->functions_path_.c_str()));
    arg_strings.push_back(strdup(localTaskData->env_path_.c_str()));
    arg_strings.push_back(strdup(localTaskData->common_path_.c_str()));
    arg_strings.push_back(strdup(localTaskData->output_path_.c_str()));
    arg_strings.push_back(strdup(config_.scriptPath_.c_str()));
    arg_strings.push_back(strdup(step.task_->files_path_.c_str()));
    arg_strings.push_back(strdup(std::to_string(step.next_ == &step).c_str()));
    arg_strings.push_back(strdup(std::to_string(spid).c_str()));
    arg_strings.push_back(strdup(step.id_.c_str()));
    arg_strings.push_back(strdup(std::to_string(step.attempt_id_).c_str()));
    arg_strings.push_back(strdup(std::to_string(step.run_id_).c_str()));
    std::string cores;
    for(uint64_t core: localData->cores_) {
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
    std::ofstream fatalErrorProf(step.task_->run_root_path_ / step_name);
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
    LocalTaskData* localTaskData = GetExecutorTaskData<LocalTaskData>(step->task_);
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
      if (std::filesystem::exists(step->task_->run_root_path_ / step_fatal_error, ec)) {
        step->MarkDone(ns_Schedule::Step::exitCode_StepLaunchError_);
      } else {
        step->MarkDone(WEXITSTATUS(status));
      }
      ReleaseCores(localData->cores_);
      SaveArtefacts(localData->artefacts_path_, localTaskData->output_path_, step->ID());
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
  ReleaseCores(localData->cores_);

  LocalTaskData* localTaskData = GetExecutorTaskData<LocalTaskData>(step.task_);
  SaveArtefacts(localData->artefacts_path_, localTaskData->output_path_, step.ID());
}

void ns_Executor::Local::GatherFilesToLocal(ns_Schedule::Step& step) {
}

std::string ns_Executor::Local::GetRunningOutput(std::filesystem::path const& runPath, 
    std::string const& type, std::string const& taskID, 
    std::string const& stepID, std::string const& rankID, 
    std::string const& attemptID, size_t readSize, 
    ssize_t readOffset, int& state) const {
  state = 0;
  std::filesystem::path outputPath = runPath;
  outputPath = outputPath / ".output";
  std::string prefix = "stdout";
  if (type.compare("error") == 0) {
    prefix = "stderr";
  }
  std::stringstream oss;
  oss << prefix << '.' << stepID << '-' << rankID << '-' << attemptID << ".txt";
  outputPath = outputPath / oss.str();
  if (!std::filesystem::exists(outputPath)) {
    return "";
  }
  std::ifstream ifs(outputPath);
  if (!ifs) {
    return "";
  }
  ifs.seekg(readOffset, readOffset >= 0 ? std::ios::beg : std::ios::end);
  if (!ifs) {
    return "";
  }
  std::string buffer;
  buffer.resize(readSize);
  ifs.read(&buffer[0], readSize);
  buffer.resize(ifs.gcount());
  state = buffer.size() == readSize ? 1 : 3; 
  return buffer;
}


std::vector<uint64_t> ns_Executor::Local::AssignCores(uint64_t nbCores) {
  std::vector<uint64_t> result;
  if (config_.nbCores_ == 0) {
    for (size_t i=0; i<coresFree_.size(); ++i) {
      if (coresFree_[i]) {
        coresFree_[i] = false;
        result.push_back(i);
        if (--nbCores == 0) {
          break;
        };
      }
    }
  } else {
    result = coresMonitor_.SelectMostIdleCores(nbCores, &coresFree_);
    for (size_t i=0; i<result.size(); ++i) {
      coresFree_[result[i]] = false;
    }
  }
  return result;
}

inline void ns_Executor::Local::ReleaseCores(std::vector<uint64_t>& cores) {
  for(uint64_t core: cores) {
    coresFree_[core] = true;
  }
  nbCoresFree_ += cores.size();
}

void ns_Executor::Local::CreateRunFolders(LocalTaskData const* localTaskData) {
  std::error_code ec;

  for(std::filesystem::path path : { localTaskData->common_path_ }) {
    if (!std::filesystem::create_directories(path, ec)) {
      throw std::runtime_error(
          "create dir " + path.string() + std::string(" failed: errno=") + 
          std::to_string(ec.value()) + " (" + ec.message() + ")"
      );
    }
  }
  std::filesystem::create_symlink(localTaskData->output_path_ / "artefacts", localTaskData->common_path_ / "artefacts", ec);
  if (ec) {
    throw std::runtime_error(
          "create symlink to " + (localTaskData->common_path_ / "artefacts").string() + 
          std::string(" failed: errno=") + std::to_string(ec.value()) + " (" + ec.message() + ")"
      );
  }
}

bool ns_Executor::Local::PinCoresToProcess(std::vector<uint64_t> const& cores_) {
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

void ns_Executor::Local::SaveArtefacts(std::filesystem::path const& artefactsJSON, 
    std::filesystem::path const& outputPath, std::string const& id) {
    if (!std::filesystem::exists(artefactsJSON)) {
      return;
    }

    std::ifstream ifs(artefactsJSON);
    if (!ifs.is_open()) {
      throw std::runtime_error("Cannot open artefacts file: " + artefactsJSON.string());
    }

    std::filesystem::path finalDir = outputPath / "artefacts";
    //std::filesystem::create_directories(finalDir);

    std::string line;
    int lineNumber = 0;

    while (std::getline(ifs, line)) {
      ++lineNumber;
      if (line.empty()) continue;

      rapidjson::Document doc;
      doc.Parse(line.c_str());

      if (doc.HasParseError() || !doc.IsObject()) {
        std::cerr << "Invalid JSON on line " << lineNumber << ": " << line << std::endl;
        continue;
      }

      if (!doc.HasMember("path") || !doc["path"].IsString()) {
        std::cerr << "Missing or invalid 'path' on line " << lineNumber << std::endl;
        continue;
      }

      std::string srcPath = doc["path"].GetString();
      std::string destName;

      if (doc.HasMember("name") && doc["name"].IsString()) {
        destName = doc["name"].GetString();
      } else {
        destName = std::filesystem::path(srcPath).filename().string();
      }

      std::filesystem::path destPath = finalDir / destName;

      std::filesystem::path destDir = destPath.parent_path();
      std::filesystem::create_directories(destDir);

      try {
          std::filesystem::copy_options copyOptions = 
              std::filesystem::copy_options::update_existing |
              std::filesystem::copy_options::recursive;
          std::filesystem::copy(srcPath, destPath, copyOptions);
          std::cout << "Saved artefact to: " << destPath << std::endl;
      } catch (const std::exception& ex) {
        std::cerr << "Failed to move artefact: " << srcPath << " -> " << destPath
            << " (" << ex.what() << ")" << std::endl;
      }
    }
}