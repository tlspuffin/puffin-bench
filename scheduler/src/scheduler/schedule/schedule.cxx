#include "schedule.hxx"
#include "task.hxx"
#include "executor/local.hxx"
#include "../../utils/file.hxx"
#include "../../utils/variables.hxx"
#include "../../utils/file_compressed.hxx"
#include "../../utils/logs.hxx"
#include <stdlib.h>
#include <iostream>
#include <fstream>
#include <sstream>
#include <stack>
#include <unordered_set>
#include <algorithm>
#include <fcntl.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <signal.h>
#include <rapidjson/filereadstream.h>
#include <rapidjson/error/en.h>
#include <rapidjson/document.h>
#include <rapidjson/prettywriter.h>
#include <rapidjson/stringbuffer.h>
#include <rapidjson/filewritestream.h>

#undef RAPIDJSON_ASSERT
#define RAPIDJSON_ASSERT(x) { throw std::runtime_error(x); }
#define DEBUG_STEP_MSG(label, step) {\
  std::stringstream oss;\
  oss << label << ": " << step->task_->id_ << " / " << step->ID()  << \
      " uuid: " << step->uuid_;\
  LOGD << oss.str() << Log::Flags::End;\
}

bool ns_Schedule::Schedule::shutdownTasksAtExit__ = true;

ns_Schedule::Schedule::Schedule(ns_Schedule::Config const& config, ns_API::UsersAPI& users, 
    ns_System::Linux& os, uint16_t cachePort) 
    : config_(config), exportPath_(config.exportPath_), tasksManager_(config), 
      threadRunning_(false), steps_(), stepsRunning_(), defaultExecutor_("local"), 
      monitor_(config.monitorsPath_), archiver_(), os_(os), users_(users)
{
  static int installHandler = InstallSigUSRHandler();

  for (auto const& executorConfig : config.executors_) {
    ns_Executor::Executor* executor = ns_Executor::Executor::Build(executorConfig.second, cachePort, os_);
    executors_.insert(std::make_pair<>(executor->Name(), executor));
  }

  //if (resetStatus) { true because LoadStatus call disable
    SaveStatus(true);
  //}

  // Disable LoadStatus, step group not managed by Executor::Local reload system
  // To remove disable too true in Taskmanager constructor
  /*auto [pendingsSteps, stepsRunning, stepsDone] = tasksManager_.LoadStatus(this);
  steps_.insert(steps_.end(), pendingsSteps.begin(), pendingsSteps.end());
  stepsRunning_.insert(stepsRunning_.end(), stepsRunning.begin(), stepsRunning.end());
  stepsDone_.insert(stepsDone_.end(), stepsDone.begin(), stepsDone.end());*/

  //if (steps_.empty()) {
    ExportRunningSteps(config_.exportPath_ / "status.json", stepsRunning_);
  /*} else {
    monitor_.Add(stepsRunning_);
    threadRunning_ = true;
    thread_ = std::thread(&ns_Schedule::Schedule::ScheduleLoop, this);
  }*/

  threadRunning_ = true;
  thread_ = std::thread(&ns_Schedule::Schedule::ScheduleLoop, this);
}

ns_Schedule::Schedule::~Schedule() {
  lockThread_.lock();
  if (threadRunning_) {
    threadRunning_ = false;
  }
  if (thread_.joinable()) {
    lockThread_.unlock();
    thread_.join();
    lockThread_.lock();
  }
  try {
    tasksManager_.DeleteTasks();
  } catch(std::exception const& e) {
    LOGE << "DeleteTasks exception: " << e.what() << Log::Flags::End;
  }

  for(auto& executor : executors_) {
    delete executor.second;
  }

  lockThread_.unlock();
}

uint64_t ns_Schedule::Schedule::AddTask(std::string const& name, 
    std::string const& tasksListPattern, 
    std::string const& functions, 
    std::unordered_map<std::string, std::vector<uint8_t>>& files,
    std::unordered_map<std::string, std::string>& args, 
    std::unordered_map<std::string, std::string>& runtimeConfig, 
    std::string const& user, std::string const& jobType) {

  std::string tasksList;
  {
    std::unordered_map<std::string, std::string> variablesValue;
    for (auto const& [key, value, defaultValue]: {
          std::tuple{"NB_RUN", "RUNTIME_NB_RUN", "1"},
          std::tuple{"NB_CORES", "RUNTIME_NB_CORES", "1"},
          std::tuple{"TIMEOUT", "RUNTIME_TIMEOUT", "3h"},
          std::tuple{"MEMORY_CORE", "RUNTIME_MEMORY_CORE", "0"},
          std::tuple{"MEMORY_CONSUMPTION", "RUNTIME_MEMORY_CONSUMPTION", "0"},
          std::tuple{"RUN_SELECT", "RUNTIME_RUN_SELECT", ""},
          std::tuple{"RUN_CONFIG", "RUNTIME_RUN_CONFIG", ""},
          std::tuple{"PRIORITY", "RUNTIME_PRIORITY", "0"},
        }) {
      auto const it = runtimeConfig.find(key);
      variablesValue.emplace(value, it != runtimeConfig.end() ? it->second : defaultValue);
    }
    tasksList = ResolveVariables(tasksListPattern, variablesValue);
  }

  rapidjson::Document stepsJSON;
  stepsJSON.Parse(tasksList.c_str());

  if (stepsJSON.HasParseError()) {
    throw std::runtime_error(
        std::string("Parsing JSON Error : ") +
        rapidjson::GetParseError_En(stepsJSON.GetParseError()) +
        " byte " + std::to_string(stepsJSON.GetErrorOffset())
    );
  }

  ns_Schedule::Task* task = 
      tasksManager_.CreateTask(name, stepsJSON, functions, files, args, user, jobType, *this);

  std::string taskFilePath = (config_.userPath_ / std::to_string(task->id_) / 
      std::string(std::to_string(task->id_) + ".json")).string();
  std::ofstream taskFile(taskFilePath, std::ios::trunc);
  if (!taskFile.is_open()) {
    throw std::runtime_error(
      "Unable to open file '" + taskFilePath + 
      "': " + std::strerror(errno));
  }
  taskFile << tasksList;
  taskFile.close();

  lockThread_.lock();

  users_.Add(task, true);
  SaveStatus(false);

  int64_t priority = task->priority_;
  auto stepIT = steps_.begin();
  for(; stepIT != steps_.end(); ++stepIT) {
    if ((*stepIT)->task_->priority_ < priority) {
      break;
    }
  }
  for(ns_Schedule::Step* step : task->root_steps_) {
    steps_.insert(stepIT, step);
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

  return task->id_;
}

bool ns_Schedule::Schedule::CancelStep(uint64_t taskID, uint64_t stepUUID) {
  std::lock_guard<std::mutex> lock(lockThread_);
  for(ns_Schedule::Step* step : steps_) {
    if ((step->task_->id_ != taskID) || (step->uuid_ != stepUUID)) {
      continue;
    }
    step->request_cancel_ = true;
    SaveStatus(false);
    return true;
  }
  return false;
}

bool ns_Schedule::Schedule::CancelTask(uint64_t taskID, std::string const& source) {
  std::lock_guard<std::mutex> lock(lockThread_);
  for (auto it = steps_.begin(); it != steps_.end(); ++it) {
    ns_Schedule::Step* step = *it;
    if (step->task_->id_ == taskID) {
      step->task_->Cancel(source);
      SaveStatus(false);
      return true;
    }
  }
  return false;
}

bool ns_Schedule::Schedule::TaskUpdatePriority(uint64_t taskID, int64_t newPriority) {
  std::lock_guard<std::mutex> lock(lockThread_);
  auto itBegin = steps_.begin();
  auto itEnd = steps_.end();
  bool found = false;
  for (auto it = steps_.begin(); it != steps_.end(); ++it) {
    ns_Schedule::Step* step = *it;
    if ((step->task_->id_ == taskID) && (!found)) {
      itBegin = it;
      found = true;
      if (step->task_->priority_ == newPriority) {
        return true;
      }
    } else if ((found) && (step->task_->id_ != taskID)) {
      itEnd = it;
      break;
    }
  }
  if (!found) {
    return false;
  }
  auto stepIT = steps_.begin();
  for(; stepIT != steps_.end(); ++stepIT) {
    if ((*stepIT)->task_->priority_ < newPriority) {
      break;
    }
  }
  (*itBegin)->task_->priority_ = newPriority;
  if (stepIT != itBegin) {
    steps_.splice(stepIT, steps_, itBegin, itEnd);
  }
  SaveStatus(false);
  return true;
}

ns_Executor::Executor* ns_Schedule::Schedule::GetExecutor(std::string const& name) const {
  auto const& executorIT = executors_.find(name);
  if (executorIT == executors_.end()) {
    auto const& executorIT = executors_.find(defaultExecutor_);
    if (executorIT != executors_.end()) {
      return executorIT->second;
    }
    LOGE << "Unable to retrieve default executor " << defaultExecutor_ << Log::Flags::End;
    return nullptr;
  }
  return executorIT->second;
}

void ns_Schedule::Schedule::GetOutput(
    std::string const& type, std::string const& taskID, 
    uint64_t stepUUID, std::string const& stepID,
    struct FileExtractedText& data) {

  tasksManager_.GetRunningOutput(type, 
      std::stoull(taskID), stepUUID, data);
  if (data.state != FileReadState::NotExecuted) {
    return;
  }

  if ((type.compare("stdout") != 0) && (type.compare("stderr") != 0)) {
    return;
  }

  std::string archiveName;
  for(auto const& name: { 
      config_.exportPath_ / (taskID + ".zip"), 
      config_.exportCanceledPath_ / (taskID + ".zip"), 
      config_.exportPath_ / (taskID + ".tgz"), 
      config_.exportCanceledPath_ / (taskID + ".tgz") }) {
    if (std::filesystem::exists(name)) {
      archiveName = name;
      break;
    }
  }
  if (archiveName.empty()) {
    return;
  }
  FileCompressed fileCompressed(archiveName);
  std::string outputFile = "logs/" + type + "." + stepID + ".txt";
  data.buffer.resize(data.requestReadOffset + data.requestReadSize);
  data.supportSeek = true;
  data.partialFile = false;
  try {
    int64_t readSize = fileCompressed.ExtractFileData(outputFile, data.buffer.size(), data.buffer.data(), &data.filesize);
    fileCompressed.StopExtractFileData();
    data.buffer.resize(readSize);
    if (data.buffer.size() > data.requestReadOffset) {
      data.buffer.erase(0, data.requestReadOffset);
    }
    data.startOffset = data.requestReadOffset;
    data.state = data.buffer.size() == data.requestReadSize ? FileReadState::Ok : FileReadState::EndOfFile;
  } catch(...) {
    LOGW << "GetOutput error: unable to find " << outputFile << " in " << archiveName << Log::Flags::End;
    data.buffer.resize(0);
    data.state = FileReadState::Error_Access;
    return;
  }
}

bool ns_Schedule::Schedule::GetTaskData(std::string const& task_id, 
    std::string& fileStateJSON, std::string& fileArtefacts) {
  if (GetTaskFinalData(task_id, fileStateJSON, fileArtefacts)) {
    return true;
  }
  fileStateJSON = tasksManager_.GetTaskState(stoull(task_id));
  return !fileStateJSON.empty();
}

bool ns_Schedule::Schedule::GetTaskFinalData(std::string const& task_id, 
    std::string& fileStateJSON, std::string& fileArtefacts) const {
  fileStateJSON = config_.exportPath_ / (task_id + ".json");
  fileArtefacts = config_.exportPath_ / (task_id + ".zip");
  bool artefactFound = std::filesystem::exists(fileArtefacts);
  if (!artefactFound) {
    fileArtefacts = config_.exportPath_ / (task_id + ".tgz");
    artefactFound = std::filesystem::exists(fileArtefacts);
  }
  if (std::filesystem::exists(fileStateJSON) && artefactFound) {
    return true;
  }
  fileStateJSON = config_.exportCanceledPath_ / (task_id + ".json");
  fileArtefacts = config_.exportCanceledPath_ / (task_id + ".zip");
  artefactFound = std::filesystem::exists(fileArtefacts);
  if (!artefactFound) {
    fileArtefacts = config_.exportCanceledPath_ / (task_id + ".tgz");
    artefactFound = std::filesystem::exists(fileArtefacts);
  }
  if (std::filesystem::exists(fileStateJSON) && artefactFound) {
    return true;
  }
  fileStateJSON.clear();
  fileArtefacts.clear();
  return false;
}

std::list<ns_Schedule::Step*> ns_Schedule::Schedule::SearchTasksToRun() {
  std::list<ns_Schedule::Step*> result;

  for(auto const& [name, executor] : executors_) {
    executor->EstimatedStepsStartTime(steps_);
    std::list<ns_Schedule::Step*> elements = executor->FindRunnableSteps(steps_);
    result.insert(result.end(), elements.begin(), elements.end());
  }

  return result;
}

void ns_Schedule::Schedule::ScheduleLoop() {
  std::ofstream stepsDoneFile(config_.exportPath_ / "steps_done.json", std::ios::app);
  std::runtime_error fatal_error("");
  std::list<ns_Schedule::Step*> stepDelayedDelete;

  bool updateStatus = false;
  lockThread_.lock();
  while(/*(!steps_.empty()) &&*/ (threadRunning_)) {
    std::list<ns_Schedule::Step*> toRun = SearchTasksToRun();
    lockThread_.unlock();

    for(ns_Schedule::Step* step : toRun) {
      step->Execute();
      DEBUG_STEP_MSG("Step execute", step);
    }
    stepsRunning_.insert(stepsRunning_.end(), toRun.begin(), toRun.end());
    monitor_.Add(toRun);

    updateStatus |= LimitRessourcesUsages();

    //if ((toRun.size() > 0) || updateStatus) {
      lockThread_.lock();
      SaveStatus(true);
      lockThread_.unlock();
      updateStatus = false;
    //}

    std::this_thread::sleep_for(std::chrono::milliseconds(500));

    for(auto& executor : executors_) {
      std::list<ns_Schedule::Step*> executorStepsDone = executor.second->CheckFinishedSteps(stepsRunning_);
      stepsDone_.insert(stepsDone_.end(), executorStepsDone.begin(), executorStepsDone.end());
      for(ns_Schedule::Step* step : executorStepsDone) {
        DEBUG_STEP_MSG("Step done", step);
        if (step->IsOSKilled()) {
          CancelTask(step->task_->id_, "Killed by SIGKILL (maybe cgroup memory.max)");
        }
      }
    }

    for (ns_Schedule::Step* step : stepsRunning_) {
      if (step->IsRunning() && step->IsTimedOut()) {
        DEBUG_STEP_MSG("Step timeouted", step);
        step->KillAndMarkTimedout();
        stepsDone_.push_back(step);
      }
    }

    updateStatus |= monitor_.GetChange();

    lockThread_.lock();
    try {
      for (ns_Schedule::Step* step : steps_) {
        if (step->task_->request_cancel_ || step->request_cancel_) {
          if (step->IsRunning()) {
            DEBUG_STEP_MSG("Running step / task cancelled", step);
            step->KillAndMarkCancel();
            stepsDone_.push_back(step);
          } else if (step->IsPending()) {
            DEBUG_STEP_MSG("Step / Task cancelled", step);
            step->MarkCancel();
            stepsDone_.push_back(step);
          }
        }
      }

      updateStatus |= ProcessDelayedCleanup(stepDelayedDelete, stepsDoneFile);

      monitor_.Remove(stepsDone_);
      for(ns_Schedule::Step* step : stepsDone_) {
        if (step->monitor_count_ > 0) {
          stepDelayedDelete.push_back(step);
        } else {
          ManageEndOfStep(step, stepsDoneFile);
          updateStatus = true;
        }
      }
    } catch (std::runtime_error& e) {
      fatal_error = e;
      goto ns_Schedule__Schedule__ScheduleLoop_fatal;
    }

    stepsDone_.clear();
  }

  SaveStatus(true);
  if (shutdownTasksAtExit__) {
    for (ns_Schedule::Step* step: steps_) {
      if (step->IsRunning()) {
        step->Shutdown();
      }
    }
  }

  archiver_.WaitForCompletion();

  threadRunning_ = false;
  lockThread_.unlock();
  return;

ns_Schedule__Schedule__ScheduleLoop_fatal:
  threadRunning_ = false;
  lockThread_.unlock();
  throw fatal_error;
}

inline bool ns_Schedule::Schedule::ProcessDelayedCleanup(
    std::list<ns_Schedule::Step*>& delayedSteps, 
    std::ofstream& stepsDoneFile) {
  bool aStepProcessed = false;
  for (auto it = delayedSteps.begin(); it != delayedSteps.end(); ) {
    ns_Schedule::Step* step = *it;
    if (step->monitor_count_ == 0) {
      ManageEndOfStep(step, stepsDoneFile);
      it = delayedSteps.erase(it);
      aStepProcessed = true;
    } else {
      ++it;
    }
  }
  return aStepProcessed;
}

void ns_Schedule::Schedule::ManageEndOfStep(
    ns_Schedule::Step* step, std::ofstream& stepsDoneFile) {
  DEBUG_STEP_MSG("Step removed", step);
  AppendStepToFinishLog(step->task_->steps_file_, *step);
  AppendStepToFinishLog(stepsDoneFile, *step);

  stepsRunning_.remove(step);
  auto itStep = std::find(steps_.begin(), steps_.end(), step);
  if (itStep == steps_.end()) {
    throw std::runtime_error("Trying to delete an unknown step: name=" +
        step->name_ + ", id=" + step->ID());
  }

  if (!step->TaskCancelled()) {
    for (auto rit = step->dependencies_.rbegin(); rit != step->dependencies_.rend(); ++rit) {
      ns_Schedule::Step* stepChild = *rit;
      stepChild->depend_from_.remove(step);
      if (stepChild->depend_from_.size() == 0) {
        steps_.insert(itStep, stepChild);
      }
    }
  }
  steps_.remove(step);
  step->GatherFilesToLocal();

  if (step->TaskLastStep()) {
    uint64_t task_id = step->TaskID();
    ArchiveJob archiveJob = step->FinalizeAndArchive(
        step->task_->request_cancel_ ? config_.exportCanceledPath_ : config_.exportPath_);
    if (archiveJob.sources_.size() > 0) {
      archiveJob.doPublish_ = !step->task_->request_cancel_;
      archiver_.AddJob(archiveJob);
    }
    users_.Add(step->task_, false);
    tasksManager_.TaskEnded(step->task_);
    LOGI << "Tasks " << task_id << " done" << Log::Flags::End;
  }

  SaveStatus(false);
}

void ns_Schedule::Schedule::ExportRunningSteps(std::string const& filename, 
    std::list<ns_Schedule::Step*> const& steps) const {
  rapidjson::Document doc;
  doc.SetObject();
  rapidjson::MemoryPoolAllocator<>& alloc = doc.GetAllocator();

  rapidjson::Value arr(rapidjson::kArrayType);
  for (Step const* step : steps) {
    rapidjson::Value val;
    step->ToJSON(val, alloc, true);
    arr.PushBack(val, alloc);
  }
  doc.AddMember("running_steps", arr, alloc);

  FILE* fp = std::fopen((filename + "tmp").c_str(), "w");
  if (!fp) {
    throw std::system_error(errno, std::generic_category(), "Impossible d'ouvrir " + filename);
  }
  char buffer[65536];
  rapidjson::FileWriteStream os(fp, buffer, sizeof(buffer));
  rapidjson::PrettyWriter<rapidjson::FileWriteStream> writer(os);
  doc.Accept(writer);
  std::fclose(fp);

  std::filesystem::rename((filename + "tmp"), filename);
}

void ns_Schedule::Schedule::SaveStatus(bool exportRunningSteps) {
  rapidjson::Document doc;
  doc.SetObject();
  rapidjson::MemoryPoolAllocator<>& alloc = doc.GetAllocator();
  rapidjson::Value tasksManagerJSON(rapidjson::kObjectType);
  tasksManager_.ToJSON(tasksManagerJSON, alloc);
  doc.AddMember("tasksmanager", tasksManagerJSON, alloc);
  rapidjson::Value executorsJSON(rapidjson::kArrayType);
  for(auto const& [name, executor] : executors_) {
    rapidjson::Value executorJSON(rapidjson::kObjectType);
    executor->ToJSON(executorJSON, alloc);
    executorsJSON.PushBack(executorJSON, alloc);
  }
  doc.AddMember("executors", executorsJSON, alloc);
  std::string filename = TaskManagerStateFile();
  FILE* fp = std::fopen((filename + "tmp").c_str(), "w");
  if (!fp) {
    throw std::system_error(errno, std::generic_category(), "Unable to open " + filename);
  }
  char buffer[65536];
  rapidjson::FileWriteStream os(fp, buffer, sizeof(buffer));
  rapidjson::PrettyWriter<rapidjson::FileWriteStream> writer(os);
  doc.Accept(writer);
  std::fclose(fp);

  std::filesystem::rename((filename + "tmp"), filename);

  if (exportRunningSteps) {
    ExportRunningSteps(config_.exportPath_ / "status.json", stepsRunning_);
  }
}

void ns_Schedule::Schedule::AppendStepToFinishLog(std::ofstream& log, ns_Schedule::Step const& step) {
  rapidjson::StringBuffer buffer;
  rapidjson::Writer<rapidjson::StringBuffer> writer(buffer);

  rapidjson::Document doc;
  doc.SetObject();
  step.ToJSON(doc, doc.GetAllocator(), true);
  doc.Accept(writer);

  log << buffer.GetString() << std::endl;
  log.flush();
}

bool ns_Schedule::Schedule::LimitRessourcesUsages() {
  bool updateStatus = false;
  std::unordered_map<ns_Executor::Executor*, std::vector<struct SRessourcesSummary>> executorsMemoryFull;
  std::unordered_map<ns_Executor::Executor*, std::vector<struct SRessourcesSummary>> executorsCPUFull;
  for(auto& executor : executors_) {
    auto const& [cpuFull, memFull] = executor.second->LimitsState();
    if (memFull) {
      executorsMemoryFull[executor.second] = {};
    }
    if (cpuFull) {
      executorsCPUFull[executor.second] = {};
    }
  }
  std::unordered_map<ns_Schedule::Task*, std::vector<ns_Schedule::Step*>> runningTasksAndSteps;
  for (ns_Schedule::Step* step : stepsRunning_) {
    runningTasksAndSteps[step->task_].push_back(step);
    step->UpdateStats();
    updateStatus = true;
  }
  for (auto& [task, steps] : runningTasksAndSteps) {
    struct SRessourcesSummary ressourcesSummary = task->UpdateStats(steps);
    auto itMem = executorsMemoryFull.find(task->executor_);
    if (itMem != executorsMemoryFull.end()) {
      itMem->second.push_back(ressourcesSummary);
    }
    auto itCPU = executorsCPUFull.find(task->executor_);
    if (itCPU != executorsCPUFull.end()) {
      itCPU->second.push_back(ressourcesSummary);
    }
  }
  for (auto& [executor, tasks] : executorsMemoryFull) {
    if (tasks.empty()) {
      continue;
    }
    SRessourcesSummary const* worst = SRessourcesSummary::ToKillMem(tasks);
    CancelTask(worst->task->id_, "memory pressure too high");
    
    auto it = executorsCPUFull.find(executor);
    if (it == executorsCPUFull.end()) {
      continue;
    }
    auto toRemove = std::find_if(it->second.begin(), it->second.end(),
        [&worst](SRessourcesSummary const& summary) { return summary.task->id_ == worst->task->id_; });
    if (toRemove != it->second.end()) {
      it->second.erase(toRemove);
    }
  }
  for (auto& [executor, tasks] : executorsCPUFull) {
    if (tasks.empty()) {
      continue;
    }
    SRessourcesSummary const* worst = SRessourcesSummary::ToKillCPU(tasks);
    CancelTask(worst->task->id_, "cpu load is too high");
  }
  return updateStatus;
}

void ns_Schedule::Schedule::HandlerUSR1(int sig) {
  shutdownTasksAtExit__ = !shutdownTasksAtExit__;
  std::stringstream oss;
  oss << "ctl + c will shutdown tasks at exit: " << 
      (shutdownTasksAtExit__ ? "true" : "false");
  LOGE << oss.str() << Log::Flags::End;
}

int ns_Schedule::Schedule::InstallSigUSRHandler() {
    struct sigaction sa = {0};
    sa.sa_handler = HandlerUSR1;
    return sigaction(SIGUSR1, &sa, NULL);
}

