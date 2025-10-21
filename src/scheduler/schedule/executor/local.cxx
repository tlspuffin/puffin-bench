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
#include <rapidjson/document.h>
#include <rapidjson/stringbuffer.h>
#include <rapidjson/writer.h>
#include <rapidjson/istreamwrapper.h>

#define FREE_ARG_STRINGS(args) for(char* string: args) free(string)

ns_Executor::LocalData::LocalData() : process_status_(Internal)
{
}

ns_Executor::LocalData::LocalData(rapidjson::Value const& config) 
    : process_status_(External)
{
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
  artefacts_path_ = run_path_.string() + "-artefacts.json";
  pid_ = Get<uint64_t>(config, "pid");

  fatalerror_path_ = Get<std::string>(config, "fatalerror_path");
  done_path_ = Get<std::string>(config, "done_path");
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

  out.AddMember("fatalerror_path", rapidjson::Value(fatalerror_path_.c_str(), alloc), alloc);
  out.AddMember("done_path", rapidjson::Value(done_path_.c_str(), alloc), alloc);
}

ns_Executor::Local::Local(std::string const& name, ns_Executor::LocalConfig const& config, 
    uint16_t cachePort)
    : Executor(name), config_(config), coresMonitor_(15), nbCoresFree_(config_.nbCores_), 
      coresFree_(config_.cores_), nbChild_(0), cachePort_(cachePort)
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
    {
      std::stringstream oss;
      oss << "Can run step " << step->task_->id_ << " / " << step->ID() << 
          " requires " << nbCoresRequired << " cores, left " << nbCoresFree << 
          " cores " << std::endl;
      std::cerr << oss.str();
    }
    result.push_back(step);
  }

  return result;
}

inline bool RedirectOutput(int outhandler, int errhandler){
  return ((close(1) == 0) && (dup(outhandler) == 1) && (close(outhandler) == 0) &&
      (close(2) == 0) && (dup(errhandler) == 2) && (close(errhandler) == 0));
}

void ns_Executor::Local::Execute(ns_Schedule::Step& step) {
  if (step.nb_cores_ == 0) {
    throw std::runtime_error("Fatal erreor: a step required a number of core");
  }

  LocalData* localData = new LocalData();
  localData->cores_ = AssignCores(step.nb_cores_);
  localData->run_path_ = step.task_->run_root_path_ / "executor" / step.ID();
  localData->artefacts_path_ = step.task_->run_root_path_ / "executor" / (step.ID() + "-artefacts.json");
  localData->fatalerror_path_ = step.task_->run_root_path_ / "executor" / ("fe-" + step.ID());
  localData->done_path_ = localData->run_path_ / ".done";
  step.executor_data_ = localData;

  std::error_code ec;
  if (!std::filesystem::create_directories(localData->run_path_, ec)) {
    throw std::runtime_error(
        std::string("create dir ") + localData->run_path_.string() + 
        std::string(" failed: errno=") + std::to_string(ec.value()) +
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
    localData->pid_ = getpid();

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

    std::filesystem::path stepParametersPath = localData->run_path_.string() + "-parameters";
    std::ofstream stepParameters = std::ofstream(stepParametersPath, std::ios::trunc);
    for(auto const& [ key, value ]: step.args_) {
      stepParameters << key << "=\"" << value << "\" ";
    }
    stepParameters.close();

    std::string cores;
    for(uint64_t core: localData->cores_) {
      cores += std::to_string(core) + ',';
    }
    cores.pop_back();
    std::ofstream stepLauncher = std::ofstream(
        localData->run_path_.string() + "-launcher", std::ios::trunc);
    stepLauncher << "THEJOB_ROOT_PATH=\"" << localData->run_path_ << "\"\n"
        << "THEJOB_FUNCTIONS_PATH=\"" << step.task_->functions_path_ << "\"\n"
        << "THEJOB_ENV_PATH=\"" << step.task_->env_path_ << "\"\n"
        << "THEJOB_USER_FILES_PATH=\"" << step.task_->files_path_ << "\"\n"
        << "THEJOB_OUT_PATH=\"" << step.task_->outputs_path_ << "\"\n"
        << "THEJOB_ARTEFACTS_FILE=\"" << localData->artefacts_path_ << "\"\n"
        << "THEJOB_ARTEFACTS_PATH=\"" << step.task_->artefacts_path_ << "\"\n"
        << "THEJOB_TOOLS_PATH=\"" << step.task_->tools_path_ << "\"\n"
        << "THEJOB_UNIQ_STEP=" << (step.next_ == &step) << "\n"
        << "THEJOB_PID=" << localData->pid_ << "\n"
        << "THEJOB_STEP_ID=\"" << step.id_ << "\"\n"
        << "THEJOB_STEP_NUMID=\"" << step.step_id_ << "\"\n"
        << "THEJOB_STEP_RANK_ID=\"" << step.rank_id_ << "\"\n"
        << "THEJOB_STEP_ATTEMPT_ID=" << step.attempt_id_ << "\n"
        << "THEJOB_RUN_ID=" << step.run_id_ << "\n"
        << "THEJOB_CORES=\"" << cores << "\"\n"
        << "THEJOB_ENTRYPOINT=\"" << step.function_ << "\"\n"
        << "THEJOB_PARAMETERS_PATH=\"" << stepParametersPath << "\"\n"
        << "THEJOB_STDOUT_PATH=\"" << step.stdout_ << "\"\n"
        << "THEJOB_STDERR_PATH=\"" << step.stderr_ << "\"\n"
        << "THEJOB_CACHE_PORT=\"" << cachePort_ << "\"\n";
    if (step.monitor_) {
      stepLauncher << "THEJOB_MONITOR_PARAMETERS_PATH=\"" << step.monitor_->ToArgs() << 
        " " << step.monitor_path_.string() << "\"\n";
    }
    stepLauncher.close();

    std::vector<std::string> args_strings = BuildExecutorArgs(step);
    if (args_strings.empty()) {
      std::cerr << "Can not build args for process" << std::endl;
      exit(-1);
    }
    std::vector<char*> args_chars;
    for(std::string const& arg: args_strings) {
      args_chars.push_back(strdup(arg.c_str()));
    }
    args_chars.push_back(nullptr);

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
    int retval = execv(script.c_str(), args_chars.data());

    std::cerr << "Unable to excecute " << script << " : " 
        << strerror(errno) << std::endl;

    std::ofstream fatalErrorProf(localData->fatalerror_path_, std::ios::trunc);
    fatalErrorProf << "0";
    fatalErrorProf.close();
    sync();

    exit(-1);
  }

  localData->pid_ = pid;

  close(errhandler);
  close(outhandler);

  if (pid == -1) {
    throw std::runtime_error("Local Executor failed to fork " + 
        std::to_string(step.step_id_) + " : " + std::strerror(errno));
  }

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
    pid_t childPID = 0;
    if (localData->process_status_ == ns_Executor::LocalData::Internal) {
      childPID = waitpid(localData->pid_, &status, WNOHANG);
    } else {
      std::stringstream log;
      status = CheckExternalProcessIsRunning(localData->pid_, localData->arguments_, 
          localData->fatalerror_path_, localData->done_path_, log);
      if (status != ns_Schedule::Step::exitCode_NotSet_) {
        childPID = localData->pid_;
      }
      errno = EINTR;
    }
    if ((childPID == -1) && (errno != EINTR)) {
      throw std::runtime_error(
          std::string("waitpid failed in CheckFinishedSteps: errno=") +
          std::to_string(errno) +
          " (" + std::strerror(errno) + ")");
    } else if (childPID == localData->pid_) {
      --nbChild_;

      std::error_code ec;
      if (std::filesystem::exists(localData->fatalerror_path_, ec)) {
        step->MarkLaunchError();
      } else {
        if (localData->process_status_ != ns_Executor::LocalData::External) {
          kill(-childPID, SIGHUP);
          std::this_thread::sleep_for(std::chrono::seconds(1));
          for(int sig: std::vector<int>{SIGTERM, SIGKILL}) {
            if (kill(-childPID, 0) != 0) {
              break;
            }
            std::this_thread::sleep_for(std::chrono::seconds(4));
            kill(-childPID, sig);
          }
        }
        while(waitpid(-childPID, nullptr, 0) > 0);
        step->MarkDone(WEXITSTATUS(status));
      }
      ReleaseCores(localData->cores_);
      SaveArtefacts(*step);
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

  SaveArtefacts(step);
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
  std::stringstream logSS;
  LocalData* localData = nullptr;
  int16_t status = ns_Schedule::Step::exitCode_Lost_;

  localData = dynamic_cast<LocalData*>(step.executor_data_);
  if (localData == nullptr) {
    logSS << "Step " << step.ID() << " marked Running but no LocalData, marking Pending" << std::endl;
    goto Local__CheckReloadRunning__Error;
  }

  localData->arguments_ = BuildExecutorArgs(step);
  if (localData->arguments_.empty()) {
    logSS << "Step " << step.ID() << " failed to build expected args, marking Pending" << std::endl;
    goto Local__CheckReloadRunning__Error;
  }

  status = CheckExternalProcessIsRunning(localData->pid_, localData->arguments_, 
      localData->fatalerror_path_, localData->done_path_, logSS);
  if (status == ns_Schedule::Step::exitCode_NotSet_) {
    if (VerifyProcessArgs(localData->pid_, localData->arguments_)) {
      std::cerr << "Step " << step.ID() << " process still running, re-reserving " 
          << localData->cores_.size() << " cores" << std::endl;
      ReAssignCores(localData->cores_);
      ++nbChild_;
      return;
    }
    logSS << "Step " << step.uuid_ << " (" << localData->pid_ << 
        ") no more running, marking Pending" << std::endl;
  } else if (status == ns_Schedule::Step::exitCode_LaunchError_) {
    step.MarkLaunchError();
    return;
  } else if (status == ns_Schedule::Step::exitCode_Lost_) {
  } else {
    step.MarkDone(status);
    SaveArtefacts(step);
    std::filesystem::remove_all(localData->run_path_, ec);
    return;
  }

Local__CheckReloadRunning__Error:
  std::cerr << step.task_->id_ << " step " << step.ID() << "\n" << logSS.str();

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

enum ns_Schedule::OutputState ns_Executor::Local::GetRunningOutput(
    ns_Schedule::Step const& step, std::string const& type, 
    size_t readSize, ssize_t readOffset, 
    struct FileExtractedText& data) const {
  enum ns_Schedule::OutputState state = ns_Schedule::OutputState::UNKNOWN;
  std::filesystem::path outputPath = step.task_->logs_path_;
  std::string prefix = type;
  std::stringstream oss;
  oss << prefix << '.' << step.ID() << ".txt";
  outputPath = outputPath / oss.str();

  FileReadState fileState = FileExtractText(outputPath, readSize, readOffset, data);
  switch (fileState) {
    case FileReadState::Ok:
      state = ns_Schedule::OutputState::GOT_DATA;
      break;
    case FileReadState::EndOfFile:
      state = ns_Schedule::OutputState::POSSIBLE_MORE_DATA;
      break;
    default:
      break;
  }
  return state;
}

ns_Executor::ExecutorTaskData* ns_Executor::Local::CreateLocalTaskData(
    rapidjson::Value const& config) const {
  return nullptr;
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

std::vector<std::string> ns_Executor::Local::BuildExecutorArgs(
    ns_Schedule::Step const& step) {
  LocalData* localData = dynamic_cast<LocalData*>(step.executor_data_);

  std::vector<std::string> arg_strings;
  arg_strings.push_back("task");
  arg_strings.push_back(localData->run_path_.string() + "-launcher");
  arg_strings.push_back("---");

  return arg_strings;
}

int16_t ns_Executor::Local::CheckExternalProcessIsRunning(pid_t pid, std::vector<std::string> const& arguments, 
    std::string const& fatalFile, std::string const& doneFile, std::stringstream& log) {

  if (kill(pid, 0) != 0) {
    std::error_code ec;
    log << "\tNot running" << std::endl;
    if (std::filesystem::exists(fatalFile, ec)) {
      log << "\tFound fatal error file "<< fatalFile << std::endl;
      return ns_Schedule::Step::exitCode_LaunchError_;
    } else if (std::filesystem::exists(doneFile, ec)) {
      log << "\tFound done file in "<< doneFile << std::endl;
      uint8_t status = 0;
      std::ifstream ifs(doneFile);
      if (ifs >> status) {
        log << "\tDone file have status: " << status << std::endl;
        return status;
      } else {
        log << "\tDdone file corrupted: " << doneFile << std::endl;
        return ns_Schedule::Step::exitCode_Lost_;
      }
    }
    log << "\tprocess " << pid << " not running" << std::endl;
    return ns_Schedule::Step::exitCode_Lost_;
  }

  if (!VerifyProcessArgs(pid, arguments)) {
    log << "\tFound a pid but with diffents run args, need restart" << std::endl;
    return ns_Schedule::Step::exitCode_Lost_;
  }

  return ns_Schedule::Step::exitCode_NotSet_;
}

bool ns_Executor::Local::VerifyProcessArgs(pid_t pid, 
    std::vector<std::string> const& expectedArgs) {
  if (expectedArgs.size() < 3) {
    return false;
  }
  std::ifstream cmdline("/proc/" + std::to_string(pid) + "/cmdline");
  if (!cmdline.is_open()) {
    return false;
  }

  size_t expectedArgsSize = expectedArgs.size();

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

bool ns_Executor::Local::PinCoresToProcess(std::vector<uint64_t> const& cores_) {
  std::set<uint64_t> coresSet;
  cpu_set_t mask;
  CPU_ZERO(&mask);
  for(uint64_t core : cores_) {
    CPU_SET(core, &mask);
    coresSet.insert(core);
  }

  if (sched_setaffinity(0, sizeof(mask), &mask) != 0) {
    std::stringstream oss;
    oss << "sched_setaffinity failed: " << strerror(errno) << " core(s): ";
    for(uint64_t core : cores_) {
      oss << core << " ";
    }
    oss << std::endl;
    std::cerr << oss.str();
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

void ns_Executor::Local::SaveArtefacts(ns_Schedule::Step& step) {
  LocalData const* localData = static_cast<LocalData*>(step.executor_data_);
  if (!std::filesystem::exists(localData->artefacts_path_)) {
    return;
  }

  std::ifstream ifs(localData->artefacts_path_);
  if (!ifs.is_open()) {
    throw std::runtime_error("Cannot open artefacts file: " + 
        localData->artefacts_path_.string());
  }

  std::filesystem::path const finalDir = step.task_->artefacts_path_;
  //std::filesystem::create_directories(finalDir);

  rapidjson::Document metadataJSON;
  metadataJSON.SetObject();
  rapidjson::MemoryPoolAllocator<>& metadataAlloc = metadataJSON.GetAllocator();
  rapidjson::Value metadata(rapidjson::kArrayType);

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

    metadata.PushBack(rapidjson::Value(doc, metadataAlloc), metadataAlloc);

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

  metadataJSON.AddMember(rapidjson::Value(step.ID().c_str(), metadataAlloc), 
      metadata, metadataAlloc);

  std::lock_guard<std::mutex> lock(step.task_->metadata_index_lock_);
  rapidjson::StringBuffer metadataBuffer;
  rapidjson::Writer<rapidjson::StringBuffer> writer(metadataBuffer);
  metadataJSON.Accept(writer);
  std::ofstream outFile(finalDir / "metadata.json", std::ios::app);
  outFile << metadataBuffer.GetString() << std::endl;
  outFile.close();
}
