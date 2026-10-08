#include "../duration_history.hxx"
#include "local.hxx"
#include <thread>
#include <chrono>
#include "../step.hxx"
#include "../../../utils/logs.hxx"
#include "../../../utils/rapidjson.hxx"
#include <signal.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <sys/prctl.h>
#include <fstream>
#include <sstream>
#include <filesystem>
#include <set>
#include <unordered_set>
#include <iostream>
#include <rapidjson/document.h>
#include <rapidjson/stringbuffer.h>
#include <rapidjson/writer.h>
#include <rapidjson/istreamwrapper.h>

#define UPDATE_CHILD_UMASK

#define FREE_ARG_STRINGS(args) for(char* string: args) free(string)

template<typename T>
static bool WriteCGroup(std::string const& filename, T const& value) {
  std::ofstream ofs(filename);
  if (!ofs.is_open()) {
    LOGE << "Unable to open " << filename << Log::Flags::End;
    return true;
  }
  ofs << value;
  ofs.close();
  if (ofs.fail()) {
    LOGE << "Unable to write " << value << " in " << filename << Log::Flags::End;
    return true;
  }
  return false;
}

ns_Executor::LocalTaskData::LocalTaskData() : cgroupPath_(), 
    os_memory_load_(-1), os_cores_load_(-1), 
    os_memory_max_load_(-1), os_cores_max_load_(-1), run_path_(), flag_file_()
{}

ns_Executor::LocalTaskData::LocalTaskData(rapidjson::Value const& config)
    : os_memory_load_(-1), os_cores_load_(-1), 
    os_memory_max_load_(-1), os_cores_max_load_(-1), run_path_(), flag_file_()
{
  if (!config.IsObject()) {
    throw std::runtime_error("LocalData JSON must be an object");
  }
  if (!config.HasMember("cgroup_path") || !config["cgroup_path"].IsString()) {
    throw std::runtime_error("LocalTaskData missing 'cgroup_path' string");
  }
  cgroupPath_ = Get<std::string>(config, "cgroup_path");

  if (config.HasMember("os_load") && config["os_load"].IsObject()) {
    rapidjson::Value const& loadJSON = config["os_load"];
    os_memory_load_ = Get<uint64_t>(loadJSON, "memory");
    os_cores_load_ = Get<uint64_t>(loadJSON, "cores");
    os_memory_max_load_ = Get<uint64_t>(loadJSON, "memory_max");
    os_cores_max_load_ = Get<uint64_t>(loadJSON, "cores_max");
  }

  run_path_ = Get<std::string>(config, "run_path");
  flag_file_ = Get<std::string>(config, "flag_file");
}

void ns_Executor::LocalTaskData::ToJSON(rapidjson::Value& out, 
    rapidjson::Document::AllocatorType& alloc) const {
  out.AddMember("cgroup_path", rapidjson::Value(cgroupPath_.c_str(), alloc), alloc);

  rapidjson::Value osLoad(rapidjson::kObjectType);
  osLoad.AddMember("memory", os_memory_load_, alloc);
  osLoad.AddMember("cores", os_cores_load_, alloc);
  osLoad.AddMember("memory_max", os_memory_max_load_, alloc);
  osLoad.AddMember("cores_max", os_cores_max_load_, alloc);
  out.AddMember("os_load", osLoad, alloc);
  out.AddMember("run_path", rapidjson::Value(run_path_.c_str(), alloc), alloc);
  out.AddMember("flag_file", rapidjson::Value(flag_file_.c_str(), alloc), alloc);
}


ns_Executor::LocalData::LocalData(uint32_t nbCores) 
    : process_status_(Internal), fdCaptureThread_(2), os_memory_load_(0), 
    os_cores_load_(nbCores), os_memory_max_load_(0), os_cores_max_load_(0)
{}

ns_Executor::LocalData::LocalData(rapidjson::Value const& config) 
    : process_status_(External), fdCaptureThread_(2), os_memory_load_(0), 
    os_memory_max_load_(0), os_cores_max_load_(0)
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
  pid_ = Get<uint64_t>(config, "pid");

  artefacts_file_ = Get<std::string>(config, "artefacts_file");

  fatalerror_file_ = Get<std::string>(config, "fatalerror_file");
  done_file_ = Get<std::string>(config, "done_file");

  launcher_file_ = Get<std::string>(config, "launcher_file");
  user_state_file_ = Get<std::string>(config, "user_state_file");
  step_parameters_file_ = Get<std::string>(config, "step_parameters_file");

  cgroup_path_ = Get<std::string>(config, "cgroup_path");

  if (config.HasMember("os_load") && config["os_load"].IsObject()) {
    rapidjson::Value const& loadJSON = config["os_load"];
    os_memory_load_ = Get<uint64_t>(loadJSON, "memory");
    if ((!loadJSON.HasMember("cores")) || (!loadJSON["cores"].IsArray())) {
      throw std::runtime_error("Missing cores array in load object");
    }
    rapidjson::Value const& coresJSON = loadJSON["cores"];
    os_cores_load_.reserve(coresJSON.Size());
    for (size_t i=0; i<coresJSON.Size(); ++i) {
      if (!coresJSON[i].IsUint64()) {
        throw std::runtime_error("Error cores array contains non-numbers");
      }
      os_cores_load_.push_back(coresJSON[i].GetUint64());
    }
    os_memory_max_load_ = Get<uint64_t>(loadJSON, "memory_max");
    os_cores_max_load_ = Get<uint64_t>(loadJSON, "cores_max");
  } else {
    os_cores_load_.resize(cores_.size(), 0);
  }
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

  out.AddMember("artefacts_file", rapidjson::Value(artefacts_file_.c_str(), alloc), alloc);

  out.AddMember("fatalerror_file", rapidjson::Value(fatalerror_file_.c_str(), alloc), alloc);
  out.AddMember("done_file", rapidjson::Value(done_file_.c_str(), alloc), alloc);

  out.AddMember("launcher_file", rapidjson::Value(launcher_file_.c_str(), alloc), alloc);
  out.AddMember("user_state_file", rapidjson::Value(user_state_file_.c_str(), alloc), alloc);
  out.AddMember("step_parameters_file", rapidjson::Value(step_parameters_file_.c_str(), alloc), alloc);

  out.AddMember("cgroup_path", rapidjson::Value(cgroup_path_.c_str(), alloc), alloc);

  rapidjson::Value osLoad(rapidjson::kObjectType);
  osLoad.AddMember("memory", os_memory_load_, alloc);
  rapidjson::Value osCoresLoad(rapidjson::kArrayType);
  for(uint8_t load: os_cores_load_) {
    osCoresLoad.PushBack(load, alloc);
  }
  osLoad.AddMember("cores", osCoresLoad, alloc);
  osLoad.AddMember("memory_max", os_memory_max_load_, alloc);
  osLoad.AddMember("cores_max", os_cores_max_load_, alloc);
  out.AddMember("os_load", osLoad, alloc);
}

ns_Executor::Local::Local(std::string const& name, ns_Executor::LocalConfig const& config, 
    uint16_t serverPort, ns_System::Linux& os)
    : Executor(name), config_(config), os_(os), nbCoresUsed_(0), 
      nbCoresMax_(config_.nbCores_), coresFree_(config_.cores_), nbChild_(0), 
      serverPort_(serverPort), cgroupRoot_(config.cgroupPath_), 
      cgroupRootCapabilities_(0), cgroupDisableUpdateSliceUser_(false), 
      cpuMaxLoad_(config_.cpuMaxLoad_), memMinAllowed_(0)
{
  static int setProcessReaper = prctl(PR_SET_CHILD_SUBREAPER, 1);
  if (setProcessReaper < 0) {
    throw std::runtime_error(std::string("Failed to enable subreaper mode: ") + 
        std::strerror(errno));
  }

  cgroupRootCapabilities_ = DetectCGroupSupport(cgroupRoot_, cgroupRootCapabilitiesString_);
  LOGI << "CGroup are " << (cgroupRoot_.empty() ? "des" : "") << "activated" << Log::Flags::End;

  cgroupDisableUpdateSliceUser_ = (!(cgroupRootCapabilities_ & 2)) ||
      (cgroupRoot_.string().find("/user.slice/") != std::string::npos);
  if (!cgroupDisableUpdateSliceUser_) {
    std::string allCores;
    for (size_t i = 0; i < coresFree_.size(); ++i) {
      if (!allCores.empty()) allCores += ',';
      allCores += std::to_string(i);
    }
    std::string cmd = "sudo -n systemctl set-property user.slice AllowedCPUs=" 
        + allCores + " 2>/dev/null";
    cgroupDisableUpdateSliceUser_ = std::system(cmd.c_str()) != 0;
    if (cgroupDisableUpdateSliceUser_) {
      LOGW <<"sudo systemctl set-property user.slice not available, CPU reservation disabled" << Log::Flags::End;
    } else {
      LOGI << "user.slice CPU reservation enabled" << Log::Flags::End;
    }
  }

  for (size_t i = 0; i < config_.cores_.size(); ++i) {
    if (config_.cores_[i]) {
      ++nbCoresLimit_;
    }
  }
  if (nbCoresMax_ == 0) {
    coresFree_ = config_.cores_;
    nbCoresMax_ = nbCoresLimit_;
  }
  if (nbCoresMax_ > nbCoresLimit_) {
    nbCoresMax_ = nbCoresLimit_;
  }
  nbCoresDefault_ = nbCoresMax_;

  memMinAllowed_ = double(os.Memory().Total()) * config_.memMinRatio_;
}

ns_Executor::Local::~Local() {
  if (!cgroupRoot_.empty()) {
    std::error_code ec;
    std::filesystem::remove(cgroupRoot_, ec);
    if (ec) {
      LOGE << "Failled to remove cgroup " << cgroupRoot_ << 
          " code: " << ec.value() << ": " << ec.message() << Log::Flags::End;
    }
  }

}

 bool ns_Executor::Local::CanRun(ns_Schedule::Step* step) const {
  // what the executor can run at all: a temporary maximum only delays a step
  return step->nb_cores_ <= std::max(nbCoresDefault_, nbCoresMax_);
}

bool ns_Executor::Local::SetMaxCores(uint64_t maxCores, uint64_t durationSec, std::string& error) {
  std::lock_guard<std::mutex> lock(coresLock_);
  if (maxCores == 0) {
    nbCoresMax_ = nbCoresDefault_;
    nbCoresUntilMs_ = 0;
    LOGI << "Maximum of cores: back to the default " << nbCoresDefault_ << Log::Flags::End;
    return true;
  }
  if (maxCores > nbCoresLimit_) {
    error = "at most " + std::to_string(nbCoresLimit_) + " cores (the cores of the configuration)";
    return false;
  }
  if ((durationSec == 0) || (durationSec > 7 * 24 * 3600)) {
    error = "the duration must be between 1 second and 7 days";
    return false;
  }
  nbCoresMax_ = maxCores;
  nbCoresUntilMs_ = static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(
      std::chrono::system_clock::now().time_since_epoch()).count()) + durationSec * 1000;
  LOGI << "Maximum of cores: " << maxCores << " for " << durationSec << " s (default " << nbCoresDefault_ << ", "
       << nbCoresUsed_ << " in use)" << Log::Flags::End;
  return true;
}

void ns_Executor::Local::CheckMaxCoresExpiry() {
  std::lock_guard<std::mutex> lock(coresLock_);
  if (nbCoresUntilMs_ == 0) {
    return;
  }
  uint64_t const now = static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(
      std::chrono::system_clock::now().time_since_epoch()).count());
  if (now >= nbCoresUntilMs_) {
    LOGI << "Maximum of cores: the temporary " << nbCoresMax_ << " ended, back to " << nbCoresDefault_ << Log::Flags::End;
    nbCoresMax_ = nbCoresDefault_;
    nbCoresUntilMs_ = 0;
  }
}

bool ns_Executor::Local::TaskPrepareToRun(ns_Schedule::Task* task) {
  if (task->executor_data_ == nullptr) {
    task->executor_data_ = new LocalTaskData();
  }
  LocalTaskData* localtaskData = dynamic_cast<LocalTaskData*>(task->executor_data_);
  if (localtaskData == nullptr) {
    return false;
  }

  localtaskData->run_path_ = task->run_root_path_ / "executor";
  localtaskData->flag_file_ = localtaskData->run_path_ / ".flag";

  if (cgroupRoot_.empty()) {
    localtaskData->cgroupPath_.clear();
    return true;
  }
  localtaskData->cgroupPath_ = cgroupRoot_ / std::to_string(task->id_);
  std::error_code ec;
  if ((!std::filesystem::create_directory(localtaskData->cgroupPath_, ec)) || ec) {
    localtaskData->cgroupPath_.clear();
    return true;
  }

  if (cgroupRootCapabilitiesString_.empty()) {
    return true;
  }

  if (WriteCGroup(localtaskData->cgroupPath_ / "cgroup.subtree_control", cgroupRootCapabilitiesString_)) {
    std::filesystem::remove(localtaskData->cgroupPath_);
    localtaskData->cgroupPath_.clear();
    return true;
  }

  return true;
}

bool ns_Executor::Local::TaskFinalize(ExecutorTaskData* data, ns_Schedule::Task* task) {
  ns_Executor::LocalTaskData* localTaskData = 
      dynamic_cast<ns_Executor::LocalTaskData*>(data);
  if (localTaskData == nullptr) {
    throw std::runtime_error("No ns_Executor::LocalTaskData* in task_->executor_data_");
  }
  if (!localTaskData->flag_file_.empty()) {
    std::ifstream ifs(localTaskData->flag_file_);
    if (ifs.is_open()) {
      task->flag_.assign((std::istreambuf_iterator<char>(ifs)), std::istreambuf_iterator<char>());
    } else {
      LOGE << "Unable to access flag file " << localTaskData->flag_file_ << " for task " << 
          task->id_ << Log::Flags::End;
    }
  }

  if (cgroupRoot_.empty()) {
    return true;
  }
  LocalTaskData* localData = dynamic_cast<LocalTaskData*>(data);
  if (localData == nullptr) {
    return false;
  }
  std::error_code ec;
  return std::filesystem::remove(localData->cgroupPath_, ec) && (!ec);
}

std::list<ns_Schedule::Step*> ns_Executor::Local::FindRunnableSteps(
    std::list<ns_Schedule::Step*> const& steps) {
  std::list<ns_Schedule::Step*> result;

  GatherStats();
  // a temporary maximum of cores ends here (also when nothing waits)
  CheckMaxCoresExpiry();

  if (steps.empty()) {
    return result;
  }

  uint64_t freeMemory = stats_.freeMemory;
  uint64_t nbCoresFree = FreeCores();

  if (stats_.cores > cpuMaxLoad_) {
  //if ((!(cgroupRootCapabilities_ & 2)) && (stats_.cores > cpuMaxLoad_)) {
    return result;
  }
  if (freeMemory < memMinAllowed_) {
    return result;
  }
  freeMemory -= memMinAllowed_;
  // too little free disk on the run and export storage: running steps go on, new ones wait (a full disk makes the
  // builds and the archives of the tasks fail)
  diskBlocked_ = (config_.diskMinimumGB_ > 0) && (MinFreeDisk() < config_.diskMinimumGB_ * 1024 * 1024 * 1024);
  if (diskBlocked_) {
    return result;
  }

  int64_t priority = (*steps.begin())->task_->priority_;
  bool stepSkiped = false;

  for(auto const step : steps) {
    if (step->task_->executor_ != this) {
      continue;
    }
    int64_t curPriority = step->task_->priority_;
    if (curPriority != priority) {
      if (stepSkiped) {
        break;
      }
      priority = curPriority;
    }

    uint64_t nbCoresRequired = step->nb_cores_;
    uint64_t memoryRequired = step->memory_max_;
    if ((!step->IsReady()) || (nbCoresRequired > nbCoresFree) || 
        ((memoryRequired > 0) && (memoryRequired > freeMemory))) {
      stepSkiped |= step->IsPending();
      continue;
    }
    nbCoresFree -= nbCoresRequired;
    freeMemory -= memoryRequired;
    {
      std::stringstream oss;
      oss << "Can run step " << step->task_->id_ << " / " << step->ID() << 
          " requires " << nbCoresRequired << " cores, left " << nbCoresFree << 
          " cores " << ", memory " << memoryRequired << ", left " << freeMemory;
      LOGD << oss.str() << Log::Flags::End;
    }
    result.push_back(step);
  }

  return result;
}

void ns_Executor::Local::EstimatedStepsStartTime(std::list<ns_Schedule::Step*> const& steps) const {
  if (steps.empty()) {
    return;
  }

  for (auto step : steps) {
    if (step->task_->executor_ != this) {
      continue;
    }
    step->task_->estimatedEndTime_ = 0;
  }

  uint64_t freeCores = nbCoresMax_;
  std::vector<uint64_t> cores(nbCoresMax_, 0);
  std::vector<uint64_t> indexFreeCores(freeCores);
  for(uint64_t i=0; i<freeCores; ++i) {
    indexFreeCores[i] = i;
  }
  uint64_t const nowMs = std::chrono::duration_cast<std::chrono::milliseconds>(
      std::chrono::system_clock::now().time_since_epoch()).count();
  // the simulated time of the estimate: now, then the successive ends of busy cores (advance below)
  uint64_t minTime = nowMs;

  std::unordered_set<ns_Schedule::Step*> stepsSet;
  std::list<ns_Schedule::Step*> currentSteps;
  for(auto step : steps) {
    if (step->task_->executor_ != this) {
      continue;
    }
    if (step->IsPending()) {
      if (step->nb_cores_ > nbCoresMax_) {
        for(auto step : steps) {
          if (step->task_->executor_ != this) {
            continue;
          }
          if (step->IsPending()) {
            step->estimatedStartTime_ = 0;
            step->task_->estimatedEndTime_ = 0;
          }
        }
        return;
      }
      step->estimatedStartTime_ = 0;
      auto const& [_, success] = stepsSet.insert(step);
      if (success) {
        currentSteps.push_back(step);
      }
    } else {
      if (step->IsRunning()) {
        if (step->nb_cores_ > freeCores) {
          for(auto step : steps) {
            if (step->task_->executor_ != this) {
              continue;
            }
            if (step->IsPending()) {
              step->estimatedStartTime_ = 0;
              step->task_->estimatedEndTime_ = 0;
            }
          }
          return;
        }
        // from the durations of the same step in past tasks (see DurationHistory)
        uint64_t endTime = ns_Schedule::DurationHistory::Instance().EstimatedEnd(*step, nowMs);
        if (step->dependencies_.empty() && (step->task_->estimatedEndTime_ < endTime)) {
          step->task_->estimatedEndTime_ = endTime;
        }
        cores[freeCores-1] = endTime;
        for(uint64_t i=1; i<step->nb_cores_; ++i) {
          cores[(freeCores-1)-i] = endTime;
        }
        freeCores -= step->nb_cores_;
      }

      for(ns_Schedule::Step* child: step->dependencies_) {
        bool available = true;
        for(ns_Schedule::Step* parent: child->depend_from_) {
          if (parent->estimatedStartTime_ == 0) {
            available = false;
            break;
          }
        }
        if (!available) {
          continue;
        }
        auto const& [_, success] = stepsSet.insert(child);
        if (success) {
          child->estimatedStartTime_ = 0;
          currentSteps.push_back(child);
        }
      }
    }
  }
  if (currentSteps.empty()) {
    return;
  }
  // Moves the simulated time to the next end of a busy core; every core busy until then or earlier is free. The
  // former version only freed the cores ending exactly then: a step could then never fit, the next end became
  // "infinite" and this loop spun for ever, holding the schedule lock (submissions hung, the stop never ended).
  // Returns false when no core gets free later: nothing more can be estimated.
  auto advance = [&]() -> bool {
    uint64_t next = std::numeric_limits<uint64_t>::max();
    for (uint64_t i = 0; i < nbCoresMax_; ++i) {
      if ((cores[i] > minTime) && (cores[i] < next)) {
        next = cores[i];
      }
    }
    if (next == std::numeric_limits<uint64_t>::max()) {
      return false;
    }
    minTime = next;
    freeCores = 0;
    for (uint64_t i = 0; i < nbCoresMax_; ++i) {
      if (cores[i] <= minTime) {
        indexFreeCores[freeCores++] = i;
      }
    }
    return true;
  };
  if ((freeCores == 0) && !advance()) {
    return;
  }
  // a guard against any other way of not progressing: the estimate is only informative
  uint64_t iterations = 0;
  uint64_t const maxIterations = 1000 + 100 * currentSteps.size() * (nbCoresMax_ + 1);

  auto stepStart = currentSteps.begin();
  int64_t priority = (*stepStart)->task_->priority_;
  bool skipped = false;
  auto stepIT = stepStart;
  while(true) {
    if (++iterations > maxIterations) {
      LOGW << "Estimated start times: stopped after " << iterations << " iterations (" << currentSteps.size() <<
          " steps left)" << Log::Flags::End;
      return;
    }
    int64_t curPriority = priority;
    if (stepIT != currentSteps.end()) {
      ns_Schedule::Step& step = *(*stepIT);
      curPriority = step.task_->priority_;
    }
    if ((curPriority < priority) || (stepIT == currentSteps.end())) {
      if (skipped) {
        stepIT = stepStart;
        skipped = false;
        if (!advance()) {
          return;
        }
        continue;
      } else if (stepIT == currentSteps.end()) {
        break;
      }
      priority = curPriority;
      stepStart = stepIT;
    }
    ns_Schedule::Step& step = *(*stepIT);
    if (!step.IsPending() || step.estimatedStartTime_ != 0) {
      ++stepIT;
      continue;
    }
    uint64_t notStartBefore = 0;
    for (ns_Schedule::Step* parent : step.depend_from_) {
      notStartBefore = std::max(notStartBefore, EstimatedFinishTime(parent));
    }
    if ((step.nb_cores_ <= freeCores) && (minTime >= notStartBefore)) {
      step.estimatedStartTime_ = minTime;
      uint64_t const stepDuration = ns_Schedule::DurationHistory::Instance().Estimate(step);
      // the task ends with its last steps: their estimated end, not their start
      if (step.dependencies_.empty() && (step.task_->estimatedEndTime_ < minTime + stepDuration)) {
        step.task_->estimatedEndTime_ = minTime + stepDuration;
      }

      bool firstChild = true;
      for(ns_Schedule::Step* child: step.dependencies_) {
        bool available = true;
        for(ns_Schedule::Step* parent: child->depend_from_) {
          if (parent->estimatedStartTime_ == 0) {
            available = false;
            break;
          }
        }
        if (!available) {
          continue;
        }
        child->estimatedStartTime_ = 0;
        auto childIT = currentSteps.insert(stepIT, child);
        if (firstChild && (stepIT == stepStart)) {
          stepStart = childIT;
        }
        firstChild = false;
        skipped = true;
      }
      bool stepITisStart = stepIT == stepStart;
      stepIT = currentSteps.erase(stepIT);
      if (stepITisStart) {
        stepStart = stepIT;
      }

      uint64_t endTime = minTime + stepDuration;
      for(uint64_t i=0; i<step.nb_cores_; ++i) {
        cores[indexFreeCores[(freeCores - 1) - i]] = endTime;
      }
      freeCores -= step.nb_cores_;
      if (freeCores == 0) {
        if (!advance()) {
          return;
        }
        if (skipped) {
          stepIT =  stepStart;
          skipped = false;
          continue;
        }
      }
    } else {
      skipped = true;
      ++stepIT;
    }
  }
}

inline bool RedirectOutput(int outhandler, int errhandler){
  return ((close(1) == 0) && (dup(outhandler) == 1) && (close(outhandler) == 0) &&
      (close(2) == 0) && (dup(errhandler) == 2) && (close(errhandler) == 0));
}

void ns_Executor::Local::Execute(ns_Schedule::Step& step) {
  if (step.nb_cores_ == 0) {
    throw std::runtime_error("Fatal erreor: a step required a number of core");
  }

  ns_Executor::LocalTaskData* localTaskData = 
      dynamic_cast<ns_Executor::LocalTaskData*>(step.task_->executor_data_);
  if (localTaskData == nullptr) {
    throw std::runtime_error("No ns_Executor::LocalTaskData* in task_->executor_data_");
  }
  LocalData* localData = new LocalData(step.nb_cores_);
  if (step.group_id_ == 0) {
    localData->run_path_ = localTaskData->run_path_ / step.ID();
    localData->artefacts_file_ = localTaskData->run_path_ / (step.ID() + "-artefacts.json");
  } else {
    localData->run_path_ = localTaskData->run_path_ / step.GID();
    localData->artefacts_file_ = localTaskData->run_path_ / (step.GID() + "-artefacts.json");
  }
  localData->fatalerror_file_ = localTaskData->run_path_ / ("fe-" + step.ID());
  localData->done_file_ = localTaskData->run_path_ / (".done-" + step.ID());

  localData->launcher_file_ = localTaskData->run_path_ / (step.ID() + "-launcher");
  localData->user_state_file_ = localTaskData->run_path_ / (step.ID() + "-userstate");
  localData->step_parameters_file_ = localTaskData->run_path_ / (step.ID() + "-parameters");

  step.executor_data_ = localData;

  std::error_code ec;
  if (!std::filesystem::create_directories(localData->run_path_, ec)) {
    if ((step.group_status_ == ns_Schedule::Step::stepsGroup_None_) || 
        (step.group_status_ == ns_Schedule::Step::stepsGroup_Begin_) || 
        (ec.value() != 0)) {
      throw std::runtime_error(
          std::string("create dir ") + localData->run_path_.string() + 
          std::string(" failed: errno=") + std::to_string(ec.value()) +
          " (" + ec.message() + ")"
      );
    }
  } 
#ifdef UPDATE_CHILD_UMASK
  else {
    std::filesystem::permissions(localData->run_path_, 
        std::filesystem::perms::owner_all | std::filesystem::perms::group_read | 
        std::filesystem::perms::group_exec | std::filesystem::perms::others_read | 
        std::filesystem::perms::others_exec, ec);
  }
#endif

  if (pipe(localData->pipeFDOut) != 0) {
    throw std::runtime_error(
        std::string("creation of pipe for stdout failed: ") + std::to_string(errno) +
        " (" + std::strerror(errno) + ")"
    );
  }
  if (fcntl(localData->pipeFDOut[1], F_SETPIPE_SZ, 1048576) == -1) {
    LOGW << "Unable to upgrade stdout pipe buffer size for " << step.task_->id_ << "/" << step.ID() << Log::Flags::End;
  }
  if (pipe(localData->pipeFDErr) != 0) {
    close(localData->pipeFDOut[0]);
    close(localData->pipeFDOut[1]);
    throw std::runtime_error(
        std::string("creation of pipe for stderr failed: ") + std::to_string(errno) +
        " (" + std::strerror(errno) + ")"
    );
  }
  if (fcntl(localData->pipeFDErr[1], F_SETPIPE_SZ, 1048576) == -1) {
    LOGW <<"Unable to upgrade stderr pipe buffer size for " << step.task_->id_ << "/" << step.ID() << Log::Flags::End;
  }
  if (!localData->fdCaptureThread_.AddFD(localData->pipeFDOut[0], 
      new ns_Executor::MemoryRing{step.stdout_, config_.logsSize_})) {
    close(localData->pipeFDOut[0]);
    close(localData->pipeFDOut[1]);
    close(localData->pipeFDErr[0]);
    close(localData->pipeFDErr[1]);
    throw std::runtime_error(
        std::string("adding rotation log for stdout failed: ") + step.stdout_.c_str()
    );
  }
  if (!localData->fdCaptureThread_.AddFD(localData->pipeFDErr[0], 
      new ns_Executor::MemoryRing{step.stderr_, config_.logsSize_})) {
    close(localData->pipeFDOut[0]);
    close(localData->pipeFDOut[1]);
    close(localData->pipeFDErr[0]);
    close(localData->pipeFDErr[1]);
    localData->fdCaptureThread_.RemoveFD(localData->pipeFDOut[0]);
    throw std::runtime_error(
        std::string("adding rotation log for stderr failed: ") + step.stderr_.c_str()
    );
  }
  int outhandler = localData->pipeFDOut[1];
  int errhandler = localData->pipeFDErr[1];

  localData->cgroup_path_.clear();
  if (!cgroupRoot_.empty()) {
    localData->cgroup_path_ = cgroupRoot_ / std::to_string(step.TaskID()) / step.ID();
  }

  localData->cores_ = AssignCores(step.nb_cores_);

  pid_t pid = fork();
  if (pid == 0) {
    pid = getpid();

#ifdef UPDATE_CHILD_UMASK
    umask(0022);
#endif

    std::string cores;
    for(uint64_t core: localData->cores_) {
      cores += std::to_string(core) + ',';
    }
    cores.pop_back();

    if (!cgroupRoot_.empty()) {
      std::filesystem::create_directories(localData->cgroup_path_);

      if ((cgroupRootCapabilities_ & 1) && (step.memory_max_ > 0)) {
        if (WriteCGroup(localData->cgroup_path_ / "memory.max", step.memory_max_)) {
          LOGE << "unable to set cgroup memory.max for step" << step.ID() << Log::Flags::End;
          exit(-1);
        } else {
          LOGD << "Step " << step.ID() << " set memory max to " << step.memory_max_ << Log::Flags::End;
        }
      }

      if (cgroupRootCapabilities_ & 2) {
        if (WriteCGroup(localData->cgroup_path_ / "cpuset.cpus", cores)) {
          LOGW << "Unable to force cpuset.cpus" << Log::Flags::End;
        }
      }

      if (WriteCGroup(localData->cgroup_path_ / "cgroup.procs", pid)) {
        LOGE << "unable to self register in cgroup for step" << step.ID() << Log::Flags::End;
        exit(-1);
      } else {
        LOGD << "Step " << step.ID() << " use " << localData->cgroup_path_ << Log::Flags::End;
      }
    }

    pid_t spid = setsid();
    if (spid == -1) {
      LOGE << "setsid failed" << Log::Flags::End;
      exit(-1);
    }
    if (!PinCoresToProcess(localData->cores_)) {
      LOGE << "set core affinity failed" << Log::Flags::End;
      exit(-1);
    }
    if (chdir(localData->run_path_.c_str()) != 0) {
      LOGE << "chdir failed" << Log::Flags::End;
      exit(-1);
    }

    std::ofstream stepParameters = std::ofstream(localData->step_parameters_file_, std::ios::trunc);
    for(auto const& [ key, value ]: step.args_) {
      stepParameters << key << "=\"" << value << "\" ";
    }
    stepParameters.close();

    std::ofstream stepLauncher = std::ofstream(localData->launcher_file_, std::ios::trunc);
    stepLauncher << "THEJOB_ROOT_PATH=\"" << localData->run_path_ << "\"\n"
        << "THEJOB_FUNCTIONS_PATH=\"" << step.task_->functions_path_ << "\"\n"
        << "THEJOB_ENV_PATH=\"" << step.task_->env_path_ << "\"\n"
        << "THEJOB_USER_FILES_PATH=\"" << step.task_->files_path_ << "\"\n"
        << "THEJOB_OUT_PATH=\"" << step.task_->outputs_path_ << "\"\n"
        << "THEJOB_ARTEFACTS_FILE=\"" << localData->artefacts_file_ << "\"\n"
        << "THEJOB_ARTEFACTS_PATH=\"" << step.task_->artefacts_path_ << "\"\n"
        << "THEJOB_TOOLS_PATH=\"" << step.task_->tools_path_ << "\"\n"
        << "THEJOB_USER=\"" << step.task_->user_ << "\"\n"
        << "THEJOB_UNIQ_STEP=" << (step.next_ == &step) << "\n"
        << "THEJOB_PID=" << pid << "\n"
        << "THEJOB_API_URL=\"" << step.task_->apiURL_ << "\"\n"
        << "THEJOB_TASK_ID=" << step.task_->id_ << "\n"
        << "THEJOB_STEP_UUID=\"" << step.uuid_ << "\"\n"
        << "THEJOB_STEP_ID=\"" << step.id_ << "\"\n"
        << "THEJOB_STEP_NUMID=\"" << step.step_id_ << "\"\n"
        << "THEJOB_STEP_RANK_ID=\"" << step.rank_id_ << "\"\n"
        << "THEJOB_STEP_ATTEMPT_ID=" << step.attempt_id_ << "\n"
        << "THEJOB_RUN_ID=" << step.run_id_ << "\n"
        << "THEJOB_CORES=\"" << cores << "\"\n"
        << "THEJOB_ENTRYPOINT=\"" << step.function_ << "\"\n"
        << "THEJOB_PARAMETERS_PATH=\"" << localData->step_parameters_file_ << "\"\n"
        << "THEJOB_STDOUT_PATH=\"" << step.stdout_ << "\"\n"
        << "THEJOB_STDERR_PATH=\"" << step.stderr_ << "\"\n"
        << "THEJOB_SERVER_PORT=\"" << serverPort_ << "\"\n"
        << "THEJOB_USER_STATE_FILE=\"" << localData->user_state_file_ << "\"\n"
        << "THEJOB_FLAG_FILE=\"" << localTaskData->flag_file_ << "\"\n"
        << "THEJOB_DONE_FILE=\"" << localData->done_file_ << "\"\n";
    if (step.monitor_) {
      stepLauncher << "THEJOB_MONITOR_PARAMETERS_PATH=\"" << step.monitor_->ToArgs() << 
        " " << step.monitor_path_.string() << "\"\n";
    }
    if (step.group_status_ != ns_Schedule::Step::stepsGroup_None_) {
      stepLauncher << "THEJOB_STEP_GROUP_ID=\"" << step.group_id_ << "\"\n";
    }
    stepLauncher.close();

    std::vector<std::string> args_strings = BuildExecutorArgs(step);
    if (args_strings.empty()) {
      LOGE << "Can not build args for process" << Log::Flags::End;
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
          " uuid: " << step.uuid_ << " with pid: " << pid;
      LOGD << oss.str() << Log::Flags::End;
    }

    if (!RedirectOutput(outhandler, errhandler)) {
      LOGE << "RedirectOutput failed" << Log::Flags::End;
      exit(-1);
    }

    close_range(3, ~0U, 0);

    std::filesystem::path script = config_.scriptPath_ / "executor.sh";
    int retval = execv(script.c_str(), args_chars.data());

    LOGE << "Unable to excecute " << script << " : " 
        << strerror(errno) << Log::Flags::End;

    std::ofstream fatalErrorProf(localData->fatalerror_file_, std::ios::trunc);
    fatalErrorProf << "0";
    fatalErrorProf.close();
    sync();

    exit(-1);
  }

  localData->pid_ = pid;

  if (pid == -1) {
    ReleaseCores(localData->cores_);
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
    if ((step->IsDone()) || (step->task_->executor_ != this)) {
      continue;
    }
    LocalData* localData = dynamic_cast<LocalData*>(step->executor_data_);
    if (localData == nullptr) {
      throw std::runtime_error("ExecutorData are not of type LocalData");
    }
    int status = 0;
    pid_t childPID = 0;
    if (localData->process_status_ == ns_Executor::LocalData::Internal) {
      while((childPID = waitpid(-localData->pid_, &status, WNOHANG)) > 0) {
        if (childPID == localData->pid_) {
          break;
        }
      }
    } else {
      std::stringstream log;
      status = CheckExternalProcessIsRunning(localData->pid_, localData->arguments_, 
          localData->fatalerror_file_, localData->done_file_, log);
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
      if (std::filesystem::exists(localData->fatalerror_file_, ec)) {
        step->MarkLaunchError();
      } else {
        if (localData->process_status_ != ns_Executor::LocalData::External) {
          KillSession(childPID, localData->cgroup_path_, step, "Step run");
        }

        if (WIFSIGNALED(status) && (WTERMSIG(status) == SIGKILL)) {
          step->MarkDone(ns_Schedule::Step::exitCode_Killed_);
        } else {
          step->MarkDone(WIFEXITED(status) ? WEXITSTATUS(status) : ns_Schedule::Step::exitCode_NoExitCode_);
        }
      }
      EndRun(*step, localData, true);
      result.push_back(step);
    }
  }

  return result;
}

namespace {
// How long a step's shutdown script may run before it is killed.
constexpr std::chrono::seconds shutdownTimeout__{60};
};

pid_t ns_Executor::Local::WaitForPidOrKill(pid_t pid,
    std::filesystem::path const& cgroupPath, ns_Schedule::Step* step) {
  auto const deadline = std::chrono::steady_clock::now() + shutdownTimeout__;
  while (true) {
    pid_t const done = waitpid(pid, nullptr, WNOHANG);
    if (done != 0) {
      return done;
    }
    if (std::chrono::steady_clock::now() >= deadline) {
      LOGW << "Shutdown script of step " << step->ID() << " still running after " <<
          shutdownTimeout__.count() << " s: killing it" << Log::Flags::End;
      KillSession(pid, cgroupPath, step, "Step shutdown timeout");
      return waitpid(pid, nullptr, 0);
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(50));
  }
}

void ns_Executor::Local::Shutdown(ns_Schedule::Step& step) {
  LocalData* localData = dynamic_cast<LocalData*>(step.executor_data_);
  if (localData == nullptr) {
    throw std::runtime_error("ExecutorData are not of type LocalData");
  }

  KillSession(localData->pid_, localData->cgroup_path_, &step, "Step timeout run");

  if (!std::filesystem::exists(localData->fatalerror_file_)) {
    pid_t pid = RunShutdown(step, localData);
    if (pid <= 0) {
      throw std::runtime_error("Executor::Local was unable to run shutdown for: " + 
          std::to_string(step.TaskID()) + ":" + step.ID());
    }
    LOGD << "Step shutdown final pid: " << pid << Log::Flags::End;
    // Bounded wait: one shutdown script that never ends would hold the stop back for ever.
    pid_t retval = WaitForPidOrKill(pid, localData->cgroup_path_, &step);
    LOGD << "Step shutdown final pid: " << pid << " wait return: " << retval << " errno: " << errno << Log::Flags::End;
    KillSession(pid, localData->cgroup_path_, &step, "Step shutdown final");
  }

  EndRun(step, localData, true);
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
    logSS << "Step " << step.ID() << " marked Running but no LocalData, marking Pending";
    goto Local__CheckReloadRunning__Error;
  }

  localData->arguments_ = BuildExecutorArgs(step);
  if (localData->arguments_.empty()) {
    logSS << "Step " << step.ID() << " failed to build expected args, marking Pending";
    goto Local__CheckReloadRunning__Error;
  }

  status = CheckExternalProcessIsRunning(localData->pid_, localData->arguments_, 
      localData->fatalerror_file_, localData->done_file_, logSS);
  if (status == ns_Schedule::Step::exitCode_NotSet_) {
    if (VerifyProcessArgs(localData->pid_, localData->arguments_)) {
      LOGD << "Step " << step.ID() << " process still running, re-reserving " << 
          localData->cores_.size() << " cores" << Log::Flags::End;
      ReAssignCores(localData->cores_);
      ++nbChild_;
      return;
    }
    logSS << "Step " << step.uuid_ << " (" << localData->pid_ << 
        ") no more running, marking Pending";
  } else if (status == ns_Schedule::Step::exitCode_LaunchError_) {
    step.MarkLaunchError();
    return;
  } else if (status == ns_Schedule::Step::exitCode_Lost_) {
  } else {
    step.MarkDone(status);
    EndRun(step, localData, false);
    return;
  }

Local__CheckReloadRunning__Error:
  LOGE << step.task_->id_ << " step " << step.ID() << "\n" << logSS.str() << Log::Flags::End;

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

void ns_Executor::Local::GetRunningOutput(
    ns_Schedule::Step const& step, std::string const& type, 
    struct FileExtractedText& data) const {
  LocalData* localData = dynamic_cast<LocalData*>(step.executor_data_);
  if (localData == nullptr) {
    return;
  }

  int fd = -1;
  std::filesystem::path file;
  if (type == "stdout") {
    fd = localData->pipeFDOut[0];
    file = step.stdout_;
  } else if (type == "stderr") {
    fd = localData->pipeFDErr[0];
    file = step.stderr_;
  }
  if (fd != -1) {
    localData->fdCaptureThread_.Read(fd, data);
  } else if ((type != "stdout") && (type != "stderr")) {
    try {
      data.live = true;
      data.supportSeek = true;
      data.partialFile = true;
      int index = std::stoi(type);
      if (index < step.readable_files_.size()) {
        file = localData->run_path_ / step.readable_files_[index].path;
        // the step ended (its run folder is gone): the copy kept next to its stdout (see EndRun)
        std::error_code ec;
        std::filesystem::path const kept = std::filesystem::path(step.stdout_).parent_path() /
            (std::to_string(index) + "." + step.ID() + ".txt");
        if (!std::filesystem::exists(file, ec) && std::filesystem::exists(kept, ec)) {
          file = kept;
          data.live = false;
          data.partialFile = false;
        }
      } else {
        throw std::runtime_error("");
      }
    } catch(...) {
      data.buffer.resize(0);
      data.state = FileReadState::Error_Access;
    }
  }
  if (data.state != FileReadState::NotExecuted) {
    return;
  }
  FileExtractText(file, data);
}

ns_Executor::ExecutorTaskData* ns_Executor::Local::CreateLocalTaskData(
    rapidjson::Value const& config) const {
  return new LocalTaskData(config);
}

ns_Executor::ExecutorData* ns_Executor::Local::CreateLocalData(
    rapidjson::Value const& config) const {
  return new LocalData(config);
}

std::pair<bool, bool> ns_Executor::Local::LimitsState() {
  // if cgroup up and was enough cpu to start a task, does not check cpu limit during task lifecycle
  return std::make_pair<>(
      (!(cgroupRootCapabilities_ & 2)) && (stats_.cores > cpuMaxLoad_), 
      stats_.freeMemory < memMinAllowed_
  );
}

std::pair<int8_t, int8_t> ns_Executor::Local::UpdateTaskStats(ExecutorTaskData* data, std::vector<ExecutorData*> stepsData) const {
  ns_Executor::LocalTaskData* localTaskData = dynamic_cast<ns_Executor::LocalTaskData*>(data);
  if (localTaskData == nullptr) {
    return std::make_pair<>(0, 0);
  }
  if (localTaskData->cgroupPath_.empty() || (!(cgroupRootCapabilities_ & 1)) ||
      !CGroupMemoryUsed(localTaskData->cgroupPath_ / "memory.stat", localTaskData->os_memory_load_)) {
    localTaskData->os_memory_load_ = stats_.memory;
  }
  if (localTaskData->os_memory_load_ > localTaskData->os_memory_max_load_) {
    localTaskData->os_memory_max_load_ = localTaskData->os_memory_load_;
  }
  //localTaskData->os_cores_load_ = stats_.cores;
  localTaskData->os_cores_load_ = 0;
  uint64_t totalLoad = 0;
  uint64_t nbLoad = 0;
  for (ns_Executor::ExecutorData const* stepData: stepsData) {
    ns_Executor::LocalData const* localData = dynamic_cast<ns_Executor::LocalData const*>(stepData);
    if (localData == nullptr) {
      continue;
    }
    for(uint8_t const load : localData->os_cores_load_) {
      totalLoad += load;
      ++nbLoad;
    }
  }
  localTaskData->os_cores_load_ = totalLoad / nbLoad;
  if (localTaskData->os_cores_load_ > localTaskData->os_cores_max_load_) {
    localTaskData->os_cores_max_load_ = localTaskData->os_cores_load_;
  }
  return std::make_pair<>(localTaskData->os_cores_load_, localTaskData->os_memory_load_);
}

void ns_Executor::Local::UpdateStepStats(ExecutorData* data) const {
  ns_Executor::LocalData* localData = dynamic_cast<ns_Executor::LocalData*>(data);
  if (localData == nullptr) {
    return;
  }
  if (localData->cgroup_path_.empty() || (!(cgroupRootCapabilities_ & 1)) || 
      (!CGroupMemoryUsed(localData->cgroup_path_ / "memory.stat", localData->os_memory_load_))) {
    localData->os_memory_load_ = stats_.memory;
  }
  if (localData->os_memory_load_ > localData->os_memory_max_load_) {
    localData->os_memory_max_load_ = localData->os_memory_load_;
  }

  uint64_t cpuLoad = 0;
  for(size_t i=0; i<localData->cores_.size(); ++i) {
    localData->os_cores_load_[i] = stats_.perCores[localData->cores_[i]];
    cpuLoad += stats_.perCores[localData->cores_[i]];
  }
  cpuLoad /= localData->cores_.size();
  if (cpuLoad > localData->os_cores_max_load_) {
    localData->os_cores_max_load_ = cpuLoad;
  }
}

// the least free space among the storages of the executor (run and export paths), in bytes
uint64_t ns_Executor::Local::MinFreeDisk() const {
  uint64_t least = UINT64_MAX;
  for (auto const& [name, values] : stats_.storages) {
    least = std::min(least, values.second);
  }
  return least;
}

void ns_Executor::Local::ToJSON(rapidjson::Value &root, rapidjson::MemoryPoolAllocator<>& alloc) const {
  root.AddMember("name", rapidjson::Value(Name().c_str(), alloc), alloc);
  // the maximum of cores: its default, a temporary one until (ms, 0: none), the cores in use, the cores at most; a
  // temporary maximum past its end is shown as the default (the next scheduling round restores it)
  uint64_t const nowMs = static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(
      std::chrono::system_clock::now().time_since_epoch()).count());
  bool const temporary = (nbCoresUntilMs_ != 0) && (nowMs < nbCoresUntilMs_);
  root.AddMember("nb_cores", temporary ? nbCoresMax_ : nbCoresDefault_, alloc);
  root.AddMember("nb_cores_default", nbCoresDefault_, alloc);
  root.AddMember("nb_cores_until", temporary ? nbCoresUntilMs_ : 0, alloc);
  root.AddMember("nb_cores_used", nbCoresUsed_, alloc);
  root.AddMember("nb_cores_limit", nbCoresLimit_, alloc);
  // free disk needed to start a step (bytes), and whether new steps wait for it
  root.AddMember("disk_minimum", config_.diskMinimumGB_ * 1024 * 1024 * 1024, alloc);
  root.AddMember("disk_blocked", diskBlocked_, alloc);
  rapidjson::Value stats(rapidjson::kObjectType);
  stats.AddMember("load_memory", stats_.memory, alloc);
  // the machine's memory (bytes): total, and what the steps need left free to start (memMinimumRatio)
  stats.AddMember("memory_total", static_cast<uint64_t>(os_.Memory().Total()), alloc);
  stats.AddMember("memory_minimum", static_cast<uint64_t>(memMinAllowed_), alloc);
  stats.AddMember("load_cores", stats_.cores, alloc);
  rapidjson::Value loadPerCore(rapidjson::kArrayType);
  for(auto const loadCore : stats_.perCores) {
    loadPerCore.PushBack(loadCore, alloc);
  }
  stats.AddMember("load_per_core", loadPerCore, alloc);
  rapidjson::Value storages(rapidjson::kObjectType);
  for(auto const& [ name, values ]: stats_.storages) {
    rapidjson::Value storage(rapidjson::kObjectType);
    storage.AddMember("capacity", values.first, alloc);
    storage.AddMember("available", values.second, alloc);
    storages.AddMember(rapidjson::Value(name.c_str(), alloc), storage, alloc);
  }
  stats.AddMember("storage", storages, alloc);
  root.AddMember("stats", stats, alloc);
}

void ns_Executor::Local::SyncTaskEnvironment(ExecutorTaskData* data) const {
}

void ns_Executor::Local::UpdateTaskEnvironment(ExecutorTaskData* data) {
}

void ns_Executor::Local::WaitSessionEnd(pid_t sessionID, ns_Schedule::Step* step, std::string const& label) {
  pid_t killedPID = 0;
  while((killedPID = waitpid(-sessionID, nullptr, 0)) > 0) {
    /*LOGD << label << " cleanup: " << step->task_->id_ << " / " << step->ID()  << 
      " uuid: " << step->uuid_ << " session: " << sessionID << 
      " cleaned_pid: " << killedPID << Log::Flags::End;*/
    LOGD << label << " cleanup: " << step->task_->id_ << " / " << step->ID()  << 
        " uuid: " << step->uuid_ << " session: " << sessionID << 
        " cleaned_pid: " << killedPID << Log::Flags::End;
  }
  std::vector<pid_t> pids = os_.Process().GetPidsBySid(sessionID);
  for(pid_t pid: pids) {
    LOGD << "waiting for " << pid << Log::Flags::End;
    waitpid(pid, nullptr, 0);
    LOGD << "waiting for " << pid << " done" << Log::Flags::End;
  }
  LOGD << label << " done: " << step->ID() << " session: " << sessionID << " errno: " << errno << Log::Flags::End;

  if (kill(-sessionID, 0) == 0) {
    LOGE << "WaitSessionEnd done, but session" << sessionID << " seems to still have process" << Log::Flags::End;
  }
}

void ns_Executor::Local::KillSession(pid_t sessionID, 
    std::filesystem::path const& cgroupPath, ns_Schedule::Step* step, 
    std::string const& label) {

  if (!cgroupPath.empty()) {
    KillCGroupSession(cgroupPath, step, label);
  } else {
    for(int sig: std::vector<int>{SIGTERM, SIGKILL}) {
      if (kill(-sessionID, 0) != 0) {
        break;
      }
      kill(-sessionID, sig);
      if (sig == SIGKILL) {
        break;
      }
      std::this_thread::sleep_for(std::chrono::seconds(4));
    }
  }
  WaitSessionEnd(sessionID, step, label);
}

void ns_Executor::Local::KillCGroupSession(std::filesystem::path const& cgroupPath, 
    ns_Schedule::Step* step, std::string const& label) {
  if (!std::filesystem::exists(cgroupPath)) {
    return;
  }
  int nbAttempts = 0;
  std::error_code ec;
  do {
    std::ofstream killFile(cgroupPath / "cgroup.kill");
    if (killFile.is_open()) {
      killFile << 1;
      killFile.close();
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
    std::filesystem::remove(cgroupPath, ec);
  } while (ec && (ec.value() == 16) && (++nbAttempts < 20));
  LOGD << label << " cleanup: " << step->task_->id_ << " / " << step->ID()  << 
        " uuid: " << step->uuid_ << " cgroup: " << cgroupPath << 
        (ec ? " failure: " + ec.message() : " success") << Log::Flags::End;
}

pid_t ns_Executor::Local::RunShutdown(ns_Schedule::Step& step, LocalData* localData) {
  int outhandler = localData->pipeFDOut[1];
  int errhandler = localData->pipeFDErr[1];

  pid_t pid = fork();

  if (pid == 0) {
    pid_t localPID = getpid();

#ifdef UPDATE_CHILD_UMASK
    umask(0022);
#endif

    if (!localData->cgroup_path_.empty()) {
      std::filesystem::create_directory(localData->cgroup_path_);
      std::ofstream procFile(localData->cgroup_path_ / "cgroup.procs");
      if (procFile.is_open()) {
        procFile << localPID;
        procFile.close();
      } else {
        LOGE << "unable to self register in cgroup" << Log::Flags::End;
        exit(-1);
     }
    }

    pid_t spid = setsid();
    if (spid == -1) {
      LOGE << "setsid failed" << Log::Flags::End;
      exit(-1);
    }
    if (chdir(localData->run_path_.c_str()) != 0) {
      LOGE << "chdir failed" << Log::Flags::End;
      exit(-1);
    }

    std::ofstream stepLauncher = std::ofstream(localData->launcher_file_, std::ios::app);
    stepLauncher << "THEJOB_SHUTDOWN=1\n";
    stepLauncher.close();

    std::vector<std::string> args_strings = BuildExecutorArgs(step);
    if (args_strings.empty()) {
      LOGE << "Can not build args for process" << Log::Flags::End;
      exit(-1);
    }
    std::vector<char*> args_chars;
    for(std::string const& arg: args_strings) {
      args_chars.push_back(strdup(arg.c_str()));
    }
    args_chars.push_back(nullptr);

    LOGD << "Step running shutdown: " << step.task_->id_ << " / " << step.ID()  << \
        " uuid: " << step.uuid_ << " with pid: " << spid << Log::Flags::End;

    if (!RedirectOutput(outhandler, errhandler)) {
      LOGE << "RedirectOutput failed" << Log::Flags::End;
      exit(-1);
    }

    close_range(3, ~0U, 0);

    std::filesystem::path script = config_.scriptPath_ / "executor.sh";
    int retval = execv(script.c_str(), args_chars.data());

    LOGE << "Unable to excecute " << script << " : " 
        << strerror(errno) << Log::Flags::End;

    std::ofstream fatalErrorProf(localData->fatalerror_file_, std::ios::app);
    fatalErrorProf << "0";
    fatalErrorProf.close();
    sync();

    exit(-1);
  }

  if (pid == -1) {
    throw std::runtime_error("Local Executor failed to fork " + 
        std::to_string(step.step_id_) + " : " + std::strerror(errno));
  }

  return pid;
}

void ns_Executor::Local::EndRun(ns_Schedule::Step& step, LocalData* localData, bool releaseCores) {

  if (!localData->cgroup_path_.empty()) {
    KillCGroupSession(localData->cgroup_path_, &step, "End run");
  }

  // The files the step declares as streams (e.g. the fuzzer's error log) are read from its run folder, which goes away:
  // keep their state at the end of the step next to its stdout and stderr (logs/<index>.<step>.txt, archived with the
  // task), so that a finished task still shows them. At most the last 16 MB of each.
  for (size_t index = 0; index < step.readable_files_.size(); ++index) {
    std::error_code ec;
    std::filesystem::path const source = localData->run_path_ / step.readable_files_[index].path;
    if (!std::filesystem::is_regular_file(source, ec)) {
      continue;
    }
    std::filesystem::path const target = std::filesystem::path(step.stdout_).parent_path() /
        (std::to_string(index) + "." + step.ID() + ".txt");
    constexpr std::uintmax_t maxSize = 16 * 1024 * 1024;
    std::uintmax_t const size = std::filesystem::file_size(source, ec);
    std::ifstream in(source, std::ios::binary);
    std::ofstream out(target, std::ios::binary | std::ios::trunc);
    if (ec || !in || !out) {
      continue;
    }
    if (size > maxSize) {
      in.seekg(static_cast<std::streamoff>(size - maxSize));
    }
    out << in.rdbuf();
  }

  localData->fdCaptureThread_.RemoveFD(localData->pipeFDOut[0]);
  localData->fdCaptureThread_.RemoveFD(localData->pipeFDErr[0]);
  close(localData->pipeFDOut[1]);
  close(localData->pipeFDErr[1]);
  localData->pipeFDOut[0] = -1;
  localData->pipeFDOut[1] = -1;
  localData->pipeFDErr[0] = -1;
  localData->pipeFDErr[1] = -1;

  std::string userStateFile = localData->user_state_file_;
  std::ifstream ifs(userStateFile);
  if (ifs.is_open()) {
    std::stringstream oss;
    oss << ifs.rdbuf();
    ifs.close();
    step.SetUserRunState(oss.str());
  } else {
    LOGD << "Unable to open user state: " + userStateFile << Log::Flags::End;
  }

  if (releaseCores) {
    ReleaseCores(localData->cores_);
  }

  std::error_code ec;
  if ((step.group_status_ == ns_Schedule::Step::stepsGroup_None_) || 
      (step.group_status_ == ns_Schedule::Step::stepsGroup_End_) ||
      step.task_->request_cancel_) {
    SaveArtefacts(step);
    std::filesystem::remove_all(localData->run_path_, ec);
  }
  std::filesystem::remove(localData->step_parameters_file_, ec);
  std::filesystem::remove(localData->user_state_file_, ec);
  std::filesystem::remove(localData->launcher_file_, ec);
  std::filesystem::remove(localData->done_file_, ec);
  std::filesystem::remove(localData->fatalerror_file_, ec);
}

std::vector<uint64_t> ns_Executor::Local::AssignCores(uint64_t nbCores) {
  std::lock_guard<std::mutex> lock(coresLock_);
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
    result = os_.Cores().SelectMostIdleCores(nbCores, &coresFree_);
    for (size_t i=0; i<result.size(); ++i) {
      coresFree_[result[i]] = false;
    }
  }
  nbCoresUsed_ += result.size();

  UpdateUserSliceCpuset();

  return result;
}

void ns_Executor::Local::ReAssignCores(std::vector<uint64_t>& cores) {
  std::lock_guard<std::mutex> lock(coresLock_);
  uint64_t nbCores = 0;
  for (uint64_t core: cores) {
    if (core < coresFree_.size()) {
      coresFree_[core] = false;
      ++nbCores;
    }
  }

  nbCoresUsed_ += nbCores;

  UpdateUserSliceCpuset();
}

inline void ns_Executor::Local::ReleaseCores(std::vector<uint64_t>& cores) {
  std::lock_guard<std::mutex> lock(coresLock_);
  for(uint64_t core: cores) {
    coresFree_[core] = true;
  }
  nbCoresUsed_ = nbCoresUsed_ > cores.size() ? nbCoresUsed_ - cores.size() : 0;

  UpdateUserSliceCpuset();
}

void ns_Executor::Local::UpdateUserSliceCpuset() {
  if (cgroupDisableUpdateSliceUser_) {
    return;
  }

  std::string cpuList;
  for (size_t i=0; i<coresFree_.size(); ++i) {
    if (coresFree_[i] || !config_.cores_[i]) {
      if (!cpuList.empty()) {
        cpuList += ',';
      }
      cpuList += std::to_string(i);
    }
  }
  if (cpuList.empty()) {
    return;
  }
  std::string cmd = "sudo -n systemctl set-property user.slice AllowedCPUs=" + cpuList + " 2>/dev/null";
  LOGD << cmd << Log::Flags::End;;
  if (std::system(cmd.c_str()) != 0) {
    LOGE << "Failed to update user.slice AllowedCPUs to " << cpuList << Log::Flags::End;;
  }
}


std::vector<std::string> ns_Executor::Local::BuildExecutorArgs(
    ns_Schedule::Step const& step) {
  LocalData* localData = dynamic_cast<LocalData*>(step.executor_data_);

  std::vector<std::string> arg_strings;
  arg_strings.push_back("task");
  arg_strings.push_back(localData->launcher_file_);
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

int32_t ns_Executor::Local::DetectCGroupSupport(std::filesystem::path& cgroupRoot, std::string& capabilitiesString) const {
  capabilitiesString.clear();
  if (faccessat(AT_FDCWD, cgroupRoot.c_str(), W_OK | X_OK, AT_EACCESS) != 0) {
    LOGW << "No access to " << cgroupRoot << Log::Flags::End;
    cgroupRoot.clear();
    return 0;
  }

  std::filesystem::path serverFolder = cgroupRoot / "server";
  std::error_code ec;
  std::filesystem::create_directory(serverFolder, ec);
  if (!std::filesystem::exists(serverFolder)) {
    LOGW << "Unable to create folder " << serverFolder << Log::Flags::End;
    cgroupRoot.clear();
    return 0;
  }

  pid_t pid = getpid();
  if (WriteCGroup(serverFolder / "cgroup.procs", pid)) {
    cgroupRoot.clear();
    return 0;
  }

  std::string capabilitiesFile = cgroupRoot / "cgroup.subtree_control";
  int32_t capabilities = 7;
  std::vector<std::string> capabilitiesName {"+memory", "+cpuset", "+pids"};
  for(size_t i=0; i<capabilitiesName.size(); ++i) {
    if (WriteCGroup(capabilitiesFile, capabilitiesName[i])) {
      capabilities -= (1 << i);
    } else {
      capabilitiesString += capabilitiesName[i] + " ";
    }
  }

  if (capabilities == 0) {
    cgroupRoot.clear();
    return 0;
  }

  cgroupRoot /= ("scheduler-" + std::to_string(pid));
  if ((!std::filesystem::create_directories(cgroupRoot, ec)) || ec) {
    LOGE << "Unable to create " << cgroupRoot << Log::Flags::End;
    capabilitiesString.clear();
    cgroupRoot.clear();
    return 0;
  }

  capabilitiesFile = cgroupRoot / "cgroup.subtree_control";
  if (WriteCGroup(capabilitiesFile, capabilitiesString)) {
    std::filesystem::remove(cgroupRoot);
    capabilitiesString.clear();
    cgroupRoot.clear();
    return 0;
  }

  return capabilities;
}

bool ns_Executor::Local::CGroupMemoryUsed(std::filesystem::path const& cgroupMemoryPath, int8_t& percentOfUsedMemory) const {
  percentOfUsedMemory = 0;
  std::ifstream ifs(cgroupMemoryPath);
  if (!ifs.is_open()) {
    return false;
  }
  uint64_t usedMemory = 0;
  std::string key;
  uint64_t value;
  while (ifs >> key >> value) {
    if (key == "anon") usedMemory += value;
    else if (key == "shmem") usedMemory += value;
  }
  if (usedMemory == 0) {
    return false;
  }
  percentOfUsedMemory = ((double)usedMemory / (double)os_.Memory().Total()) * 100.0;
  return true;
}

void ns_Executor::Local::GatherStats() {
  ns_System::CoreStats global;
  std::vector<ns_System::CoreStats> perCores;
  ns_System::MemoryMonitor::MemoryStats memory;
  os_.GetLoad(global, perCores, memory, stats_.storages);
  stats_.memory = memory.UsedRatio() * 100.0;
  stats_.freeMemory = memory.available_kb * 1024;
  stats_.totalMemory = memory.total_kb * 1024;
  stats_.cores = 100 - (global.values_[ns_System::CoreStats::IDLE_INDEX] * 100.0);
  stats_.perCores.resize(perCores.size());
  for(size_t i=0; i<perCores.size(); ++i) {
    stats_.perCores[i] = 100 - (perCores[i].values_[ns_System::CoreStats::IDLE_INDEX] * 100.0);
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
    LOGE << "sched_setaffinity failed: " << strerror(errno) << " core(s): ";
    for(uint64_t core : cores_) {
      LOGE << core << " ";
    }
    LOGE << Log::Flags::End;
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
  if (!std::filesystem::exists(localData->artefacts_file_)) {
    return;
  }

  std::ifstream ifs(localData->artefacts_file_);
  if (!ifs.is_open()) {
    throw std::runtime_error("Cannot open artefacts file: " + 
        localData->artefacts_file_.string());
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
      LOGW << "Invalid JSON on line " << lineNumber << ": " << line << Log::Flags::End;
      continue;
    }

    if (!doc.HasMember("path") || !doc["path"].IsString()) {
      LOGW << "Missing or invalid 'path' on line " << lineNumber << Log::Flags::End;
      continue;
    }

    std::string srcPath = doc["path"].GetString();

    struct stat srcStat;
    if ((!std::filesystem::exists(srcPath)) || 
        (stat(srcPath.c_str(), &srcStat) != 0)) {
      LOGE << "Failed to move artefact: " << srcPath << 
          " (does not exist))" << Log::Flags::End;
      continue;
    }

    std::string destName;
    if (doc.HasMember("name") && doc["name"].IsString()) {
      destName = doc["name"].GetString();
    } else {
      destName = std::filesystem::path(srcPath).filename().string();
    }

    std::filesystem::path destPath = finalDir / destName;
    std::filesystem::path destDir = destPath.parent_path();
    std::filesystem::create_directories(destDir);
    struct stat dstStat;
    if (stat(destDir.c_str(), &dstStat) != 0) {
      LOGE << "Failed to move artefact: " << srcPath << " -> " << destPath
          << " (error while creating destination)" << Log::Flags::End;
      continue;
    }
    bool canMove = srcStat.st_dev == dstStat.st_dev;

    try {
      if (canMove) {
        std::filesystem::rename(srcPath, destPath);
      } else {
        std::filesystem::copy_options copyOptions = 
            std::filesystem::copy_options::overwrite_existing |
            std::filesystem::copy_options::recursive;
            std::filesystem::copy(srcPath, destPath, copyOptions);
      }
      LOGI << "Saved artefact to: " << destPath << Log::Flags::End;

      metadata.PushBack(rapidjson::Value(doc, metadataAlloc), metadataAlloc);
    } catch (const std::exception& ex) {
      LOGE << "Failed to move artefact: " << srcPath << " -> " << destPath
          << " (" << ex.what() << ")" << Log::Flags::End;
    }
  }

  std::string const metadataKey = (step.group_id_ == 0) ? step.ID() : step.GID();
  metadataJSON.AddMember(rapidjson::Value(metadataKey.c_str(), metadataAlloc), 
      metadata, metadataAlloc);

  std::lock_guard<std::mutex> lock(step.task_->metadata_index_lock_);
  rapidjson::StringBuffer metadataBuffer;
  rapidjson::Writer<rapidjson::StringBuffer> writer(metadataBuffer);
  metadataJSON.Accept(writer);
  std::ofstream outFile(finalDir / "metadata.json", std::ios::app);
  outFile << metadataBuffer.GetString() << std::endl;
  outFile.close();

  std::error_code ec;
  std::filesystem::remove(localData->artefacts_file_, ec);
}

inline uint64_t ns_Executor::Local::EstimatedFinishTime(ns_Schedule::Step const* step) {
  if (step->IsDone()) {
    auto endTP = step->StartTime() + step->RunTime();
    return std::chrono::duration_cast<std::chrono::milliseconds>(
        endTP.time_since_epoch()).count();
  }

  if (step->IsRunning()) {
    uint64_t const nowMs = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count();
    return ns_Schedule::DurationHistory::Instance().EstimatedEnd(*step, nowMs);
  }
  return step->estimatedStartTime_ + ns_Schedule::DurationHistory::Instance().Estimate(*step);
}
