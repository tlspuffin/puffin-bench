#include "local.hxx"
#include "../step.hxx"
#include "../../utils/rapidjson.hxx"
#include <signal.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <sys/prctl.h>
#include <fstream>
#include <sstream>
#include <filesystem>
#include <set>
#include <iostream>
#include <rapidjson/istreamwrapper.h>

#define FREE_ARG_STRINGS(args) for(char* string: args) free(string)

ns_Executor::LocalData::LocalData() {}

ns_Executor::LocalData::LocalData(rapidjson::Value const& config) {
  if (!config.IsObject()) {
    throw std::runtime_error("LocalData JSON must be an object");
  }
  if (!config.HasMember("cores") || !config["cores"].IsArray()) {
    throw std::runtime_error("LocalData missing 'cores' array");
  }
  rapidjson::Value const& coresArray = config["cores"];
  for (rapidjson::SizeType i = 0; i < coresArray.Size(); i++) {
    if (!coresArray[i].IsUint64()) {
      throw std::runtime_error("Invalid core value at index " + std::to_string(i));
    }
    cores_.push_back(coresArray[i].GetUint64());
  }
  run_path_ = Get<std::string>(config, "run_path");
  pid_ = Get<uint64_t>(config, "pid");
  artefacts_path_ = Get<std::string>(config, "artefacts_path");
}

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

ns_Executor::LocalTaskData::LocalTaskData() {}

ns_Executor::LocalTaskData::LocalTaskData(rapidjson::Value const& config) {
  if (!config.IsObject()) {
    throw std::runtime_error("LocalTaskData JSON must be an object");
  }
  log_path_ = Get<std::string>(config, "log_path");
  env_path_ = Get<std::string>(config, "env_path");
  common_path_ = Get<std::string>(config, "common_path");
  output_path_ = Get<std::string>(config, "output_path");
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
  static int setProcessReaper = prctl(PR_SET_CHILD_SUBREAPER, 1);
  if (setProcessReaper < 0) {
    throw std::runtime_error(std::string("Failed to enable subreaper mode: ") + 
        std::strerror(errno));
  }

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

  bool localTaskDataCreated = false;
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
    localTaskDataCreated = true;
  }

  localData->cores_ = AssignCores(step.nb_cores_);

  localTaskData->log_path_ = step.task_->run_root_path_ / ".output";
  localTaskData->env_path_ = step.task_->run_root_path_ / ".taskenv";
  localTaskData->output_path_ = step.task_->run_root_path_ / "output";
  localTaskData->common_path_ = step.task_->run_root_path_ / "common";
  localData->run_path_ = step.task_->run_root_path_ / step.ID();
  localData->artefacts_path_ = localData->run_path_ / ".artefacts";

  if (localTaskDataCreated) {
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

    std::ofstream stepParameters = std::ofstream(
        "./.parameters", std::ios::trunc);
    for(auto const& [ key, value ]: step.args_) {
      stepParameters << key << "=\"" << value << "\" ";
    }
    stepParameters.close();

    std::vector<char*> arg_strings = 
        BuildExecutorArgs(step, localTaskData, config_, spid);
    if (arg_strings.empty()) {
      std::cerr << "Can not build args for process" << std::endl;
      exit(-1);
    }

    {
      std::stringstream oss;
      oss << "Step running: " << step.task_->id_ << " / " << step.ID()  << \
          " uuid: " << step.uuid_ << " with pid: " << spid << std::endl;
      std::cerr << oss.str();
    }

    if (!RedirectOutput(outhandler, errhandler)) {
      std::cerr << "RedirectOutput failed" << std::endl;
      exit(-1);
    }

    close_range(3, ~0U, 0);

    std::filesystem::path script = config_.scriptPath_ / "executor.sh";
    int retval = execv(script.c_str(), arg_strings.data());

    std::cerr << "Unable to excecute " << script << " : " 
        << strerror(errno) << std::endl;

    std::filesystem::path step_fatal_error = 
        step.task_->run_root_path_ / ("fe-" + step.ID());
    std::ofstream fatalErrorProf(step_fatal_error);
    fatalErrorProf << "0";
    fatalErrorProf.close();
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
      while(waitpid(-localData->pid_, nullptr, 0) > 0);

      std::filesystem::path step_fatal_error = 
          step->task_->run_root_path_ / ("fe-" + step->ID());
      std::error_code ec;
      if (std::filesystem::exists(step_fatal_error, ec)) {
        step->MarkLaunchError();
      } else {
        step->MarkDone(WEXITSTATUS(status));
      }
      ReleaseCores(localData->cores_);
      SaveArtefacts(localData->artefacts_path_, localTaskData->output_path_, step->ID());
      std::filesystem::remove_all(localData->run_path_, ec);
      result.push_back(step);
    }
  }

  return result;
}

void ns_Executor::Local::Shutdown(ns_Schedule::Step& step) {
  LocalData* localData = dynamic_cast<LocalData*>(step.executor_data_);
  if (localData == nullptr) {
    throw std::runtime_error("ExecutorData are not of type LocalData");
  }

  kill(-localData->pid_, SIGKILL);
  while(waitpid(-localData->pid_, nullptr, 0) > 0);

  ReleaseCores(localData->cores_);

  LocalTaskData* localTaskData = GetExecutorTaskData<LocalTaskData>(step.task_);
  SaveArtefacts(localData->artefacts_path_, localTaskData->output_path_, step.ID());
  std::error_code ec;
  std::filesystem::remove_all(localData->run_path_, ec);
}

void ns_Executor::Local::GatherFilesToLocal(ns_Schedule::Step& step) {
}

void ns_Executor::Local::CheckReloadRunning(ns_Schedule::Step& step) {
  if (!step.IsRunning()) {
    return;
  }

  std::error_code ec;
  std::stringstream errorSS;
  LocalData* localData = nullptr;
  LocalTaskData* localTaskData = nullptr;
  std::vector<char*> expectedArgs;
  std::filesystem::path doneFile;
  std::filesystem::path stepFatalError;

  localData = dynamic_cast<LocalData*>(step.executor_data_);
  if (localData == nullptr) {
    errorSS << "Step " << step.ID() << " marked Running but no LocalData, marking Pending" << std::endl;
    goto Local__CheckReloadRunning__Error;
  }
  localTaskData = GetExecutorTaskData<LocalTaskData>(step.task_);

  if (kill(localData->pid_, 0) != 0) {
    std::cerr << "\t\tNot running" << std::endl;
    stepFatalError = step.task_->run_root_path_ / ("fe-" + step.ID());
    doneFile = localData->run_path_ / ".done";
    if (std::filesystem::exists(stepFatalError, ec)) {
      std::cerr << "\t\tFound fatal error file "<< stepFatalError << std::endl;
      step.MarkLaunchError();
      return;
    } else if (std::filesystem::exists(localData->run_path_ / ".done", ec)) {
      std::cerr << "\t\tFound done file in "<< localData->run_path_ << std::endl;
      uint8_t status = 0;
      std::ifstream ifs(doneFile);
      if (ifs >> status) {
        std::cerr << "\t\tDone file have status: " << status << std::endl;
        step.MarkDone(status);
        SaveArtefacts(localData->artefacts_path_, localTaskData->output_path_, step.ID());
        std::filesystem::remove_all(localData->run_path_, ec);
        return;
      } else {
        std::cerr << "\t\tDone file corrupted" << std::endl;
        errorSS << "Step " << step.ID() << " .done file corrupted, marking Pending" << std::endl;
        goto Local__CheckReloadRunning__Error;
      }
    }

    std::cerr << "\t\tShould have been kill, need restart" << std::endl;
    errorSS << "Step " << step.ID() << " process " << localData->pid_ 
        << " died, marking Pending" << std::endl;
    goto Local__CheckReloadRunning__Error;
  }

  expectedArgs = BuildExecutorArgs(step, localTaskData, config_, localData->pid_);

  if (expectedArgs.empty()) {
    std::cerr << "\t\tFailed to build run args, need restart" << std::endl;
    errorSS << "Step " << step.ID() << " failed to build expected args, marking Pending" << std::endl;
    goto Local__CheckReloadRunning__Error;
  }

  if (!VerifyProcessArgs(localData->pid_, expectedArgs)) {
    std::cerr << "\t\tFound a pid but with diffents run args, need restart" << std::endl;
    errorSS << "Step " << step.uuid_ << " (" << localData->pid_ << 
        ") no more running, marking Pending" << std::endl;
    goto Local__CheckReloadRunning__Error;
  }

  std::cerr << "Step " << step.ID() << " process still running, re-reserving " 
      << localData->cores_.size() << " cores" << std::endl;

  ReAssignCores(localData->cores_);
  ++nbChild_;

  FREE_ARG_STRINGS(expectedArgs);
  return;

Local__CheckReloadRunning__Error:
  std::cerr << errorSS.str();
  if (!expectedArgs.empty()) {
    FREE_ARG_STRINGS(expectedArgs);
  }

  bool deleteRunPath = localData != nullptr;
  bool deleteOutFile = true;
  bool deleteErrFile = true;
  std::filesystem::path archivesPath = step.task_->run_root_path_ / "failed_attempts";
  std::filesystem::remove_all(archivesPath, ec);
  std::filesystem::create_directories(archivesPath, ec);
  if (!ec) {
    if (localData != nullptr) {
      std::filesystem::rename(localData->run_path_, archivesPath / step.ID(), ec);
      deleteRunPath = (bool)ec;
    }
    std::filesystem::rename(step.stdout_, archivesPath / step.stdout_.filename(), ec);
    deleteOutFile = (bool)ec;
    std::filesystem::rename(step.stderr_, archivesPath / step.stderr_.filename(), ec);
    deleteErrFile = (bool)ec;
  }
  if (deleteRunPath) {
    std::filesystem::remove_all(localData->run_path_, ec);
  }
  if (deleteOutFile) {
    std::filesystem::remove(step.stdout_, ec);
  }
  if (deleteErrFile) {
    std::filesystem::remove(step.stderr_, ec);
  }

  step.MarkPending();
}

std::string ns_Executor::Local::GetRunningOutput(
    ns_Schedule::Step const& step, std::string const& type, 
    size_t readSize, ssize_t readOffset, 
    enum ns_Schedule::OutputState& state) const {
  state = ns_Schedule::OutputState::UNKNOWN;
  std::filesystem::path outputPath = step.task_->run_root_path_;
  outputPath = outputPath / ".output";
  std::string prefix = type;
  std::stringstream oss;
  oss << prefix << '.' << step.ID() << ".txt";
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
  state = buffer.size() == readSize ? 
      ns_Schedule::OutputState::GOT_DATA : ns_Schedule::OutputState::POSSIBLE_MORE_DATA; 
  return buffer;
}

ns_Executor::ExecutorTaskData* ns_Executor::Local::CreateLocalTaskData(
    rapidjson::Value const& config) const {
  return new LocalTaskData(config);
}

ns_Executor::ExecutorData* ns_Executor::Local::CreateLocalData(
    rapidjson::Value const& config) const {
  return new LocalData(config);
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
  nbCoresFree_ -= result.size();
  return result;
}

void ns_Executor::Local::ReAssignCores(std::vector<uint64_t>& cores) {
  uint64_t nbCores = 0;
  for (uint64_t core: cores) {
    if (core < coresFree_.size()) {
      coresFree_[core] = false;
      ++nbCores;
    }
  }

  if (nbCoresFree_ > nbCores) {
    nbCoresFree_ -= nbCores;
  } else {
    nbCoresFree_ = 0;
  }
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

std::vector<char*> ns_Executor::Local::BuildExecutorArgs(
    ns_Schedule::Step const& step, 
    ns_Executor::LocalTaskData* localTaskData,
    ns_Executor::LocalConfig const& config, 
    pid_t sessionPid) {

  LocalData* localData = dynamic_cast<LocalData*>(step.executor_data_);

  std::vector<char*> arg_strings;
  arg_strings.push_back(strdup("task"));
  arg_strings.push_back(strdup(step.task_->functions_path_.c_str()));
  arg_strings.push_back(strdup(localTaskData->env_path_.c_str()));
  arg_strings.push_back(strdup(localTaskData->common_path_.c_str()));
  arg_strings.push_back(strdup(localTaskData->output_path_.c_str()));
  arg_strings.push_back(strdup(config.scriptPath_.c_str()));
  arg_strings.push_back(strdup(step.task_->files_path_.c_str()));
  arg_strings.push_back(strdup(std::to_string(step.next_ == &step).c_str()));
  arg_strings.push_back(strdup(std::to_string(sessionPid).c_str()));
  arg_strings.push_back(strdup(step.id_.c_str()));
  arg_strings.push_back(strdup(std::to_string(step.attempt_id_).c_str()));
  arg_strings.push_back(strdup(std::to_string(step.run_id_).c_str()));
  std::string cores;
  for(uint64_t core: localData->cores_) {
    cores += std::to_string(core) + ',';
  }
  if (cores.empty()) {
    FREE_ARG_STRINGS(arg_strings);
    return std::vector<char*>();
  }
  cores.pop_back();
  arg_strings.push_back(strdup(cores.c_str()));
  arg_strings.push_back(strdup(step.function_.c_str()));
  arg_strings.push_back(strdup("./.parameters"));
  arg_strings.push_back(strdup("---"));

  arg_strings.push_back(nullptr);
  return arg_strings;
}

bool ns_Executor::Local::VerifyProcessArgs(pid_t pid, 
    std::vector<char*> const& expectedArgs) {
  if (expectedArgs.size() < 3) {
    return false;
  }
  std::ifstream cmdline("/proc/" + std::to_string(pid) + "/cmdline");
  if (!cmdline.is_open()) {
    return false;
  }

  size_t expectedArgsSize = 
      expectedArgs.back() == nullptr ? expectedArgs.size() - 1 : expectedArgs.size();

  std::vector<std::string> actualArgs;
  std::string arg;
  char c;
  while (cmdline.get(c)) {
    if (c == '\0') {
      actualArgs.push_back(arg);
      arg.clear();
    } else {
      arg += c;
    }
  }
  if (!arg.empty()) {
    actualArgs.push_back(arg);
  }

  if (actualArgs.size() < expectedArgsSize) {
    return false;
  }

  size_t startIndex = 1;
  for(; startIndex<actualArgs.size(); ++startIndex) {
    if (actualArgs[startIndex].compare(expectedArgs[1]) == 0) {
      startIndex;
      break;
    }
  }

  if ((startIndex >= actualArgs.size()) || 
      ((expectedArgsSize - 1) > (actualArgs.size() - startIndex))) {
    return false;
  }
  for(size_t i=2; i<expectedArgsSize; ++i) {
    if (actualArgs[startIndex+i-1].compare(expectedArgs[i]) != 0) {
      return false;
    }
  }

  return true;
}
