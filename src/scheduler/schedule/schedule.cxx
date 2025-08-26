#include "schedule.hxx"
#include "task.hxx"
#include "executor/local.hxx"
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
#include <rapidjson/filereadstream.h>
#include <rapidjson/error/en.h>
#include <rapidjson/document.h>
#include <rapidjson/prettywriter.h>
#include <rapidjson/stringbuffer.h>
#include <rapidjson/filewritestream.h>

#undef RAPIDJSON_ASSERT
#define RAPIDJSON_ASSERT(x) { throw std::runtime_error(x); }

ns_Schedule::Schedule::Schedule(ns_Schedule::Config const& config) 
    : config_(config), exportPath_(config.exportPath_), tasksManager_(config), 
      threadRunning_(false), steps_(), stepsRunning_(), defaultExecutor_("local")
{
  for (auto const& executorConfig : config.executors_) {
    ns_Executor::Executor* executor = ns_Executor::Executor::Build(executorConfig.second);
    executors_.insert(std::make_pair<>(executor->Name(), executor));
  }

  auto [pendingsSteps, stepsRunning, stepsDone] = tasksManager_.LoadStatus(this);
  steps_.insert(steps_.end(), pendingsSteps.begin(), pendingsSteps.end());
  stepsRunning_.insert(stepsRunning_.end(), stepsRunning.begin(), stepsRunning.end());
  stepsDone_.insert(stepsDone_.end(), stepsDone.begin(), stepsDone.end());

  if (steps_.empty()) {
    ExportRunningSteps(config_.exportPath_ / "status.json", stepsRunning_);
  } else {
    threadRunning_ = true;
    thread_ = std::thread(&ns_Schedule::Schedule::ScheduleLoop, this);
  }
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
    std::cerr << "DeleteTasks exception: " << e.what() << std::endl;
  }

  for(auto& executor : executors_) {
    delete executor.second;
  }

  lockThread_.unlock();
}

uint64_t ns_Schedule::Schedule::AddTask(std::string const& tasksList, 
    std::string const& functions, 
    std::unordered_map<std::string, std::vector<uint8_t>>& files,
    std::unordered_map<std::string, std::string>& args) {
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
      tasksManager_.CreateTask(stepsJSON, functions, files, args, *this);

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

  for(ns_Schedule::Step* step : task->root_steps_) {
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

  return task->id_;
}

bool ns_Schedule::Schedule::CancelStep(uint64_t taskID, uint64_t stepUUID) {
  std::lock_guard<std::mutex> lock(lockThread_);
  for(ns_Schedule::Step* step : steps_) {
    if ((step->task_->id_ != taskID) || (step->uuid_ != stepUUID)) {
      continue;
    }
    step->request_cancel_ = true;
    return true;
  }
  return false;
}

bool ns_Schedule::Schedule::CancelTask(uint64_t taskID) {
  std::lock_guard<std::mutex> lock(lockThread_);
  for(ns_Schedule::Step* step : steps_) {
    if (step->task_->id_ != taskID) {
      continue;
    }
    step->task_->request_cancel_ = true;
    return true;
  }
  return false;
}


ns_Executor::Executor* ns_Schedule::Schedule::GetExecutor(std::string const& name) const {
  auto const& executorIT = executors_.find(name);
  if (executorIT == executors_.end()) {
    auto const& executorIT = executors_.find(defaultExecutor_);
    if (executorIT != executors_.end()) {
      return executorIT->second;
    }
    std::cerr << "Unable to retrieve default executor " << defaultExecutor_ << std::endl;
    return nullptr;
  }
  return executorIT->second;
}

std::string ns_Schedule::Schedule::GetOutput(
    std::string const& type, std::string const& taskID, 
    std::string const& stepID, std::string const& rankID, 
    std::string const& attemptID, size_t readSize, 
    ssize_t readOffset, OutputState& state) {
  state = OutputState::UNKNOWN;
  std::string output = tasksManager_.GetRunningOutput(type, 
      std::stoull(taskID), std::stoull(stepID), 
      std::stoull(rankID), std::stoull(attemptID), 
      readSize, readOffset, state);
  if (state != OutputState::UNKNOWN) {
    return output;
  }

  std::filesystem::path outputPath = config_.exportPath_;
  outputPath = outputPath / taskID / "logs";
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
  state = buffer.size() == readSize ? OutputState::GOT_DATA : OutputState::END_OF_DATA; 
  return buffer;
}


std::list<ns_Schedule::Step*> ns_Schedule::Schedule::SearchTasksToRun() {
  std::list<ns_Schedule::Step*> result;

  for(auto const& executor : executors_) {
    std::list<ns_Schedule::Step*> elements = executor.second->FindRunnableSteps(steps_);
    result.insert(result.end(), elements.begin(), elements.end());
  }

  return result;
}

void ns_Schedule::Schedule::ScheduleLoop() {
  std::ofstream stepsDoneFile(config_.exportPath_ / "steps_done.json", std::ios::app);
  std::runtime_error fatal_error("");
  std::list<ns_Schedule::Step*> step_delayed_delete;

  bool updateStatus = false;
  lockThread_.lock();
  while((!steps_.empty()) && (threadRunning_)) {
    std::list<ns_Schedule::Step*> toRun = SearchTasksToRun();
    lockThread_.unlock();

    for(ns_Schedule::Step* step : toRun) {
      step->Execute();
      std::cerr << "Execute step: " << step->ID() << std::endl;
    }
    stepsRunning_.insert(stepsRunning_.end(), toRun.begin(), toRun.end());

    if ((toRun.size() > 0) || updateStatus) {
      tasksManager_.SaveStatus();
      ExportRunningSteps(config_.exportPath_ / "status.json", stepsRunning_);
      updateStatus = false;
    }

    std::this_thread::sleep_for(std::chrono::seconds(1));

    for(auto& executor : executors_) {
      std::list<ns_Schedule::Step*> executorStepsDone = executor.second->CheckFinishedSteps(stepsRunning_);
      stepsDone_.insert(stepsDone_.end(), executorStepsDone.begin(), executorStepsDone.end());
      for(ns_Schedule::Step* step : executorStepsDone) {
        std::cerr << "Done step: " << step->ID() << std::endl;
      }
    }

    for (ns_Schedule::Step* step : stepsRunning_) {
      if (step->IsRunning() && step->IsTimedOut()) {
        std::cout << "Step " << step->ID() << " timeouted" << std::endl;
        step->KillAndMarkTimedout();
        stepsDone_.push_back(step);
      }
    }

    lockThread_.lock();
    try {
      for (ns_Schedule::Step* step : steps_) {
        if (step->task_->request_cancel_ || step->request_cancel_) {
          std::cout << "Step " << step->ID() << " cancelled" << std::endl;
          if (!step->IsRunning()) {
            stepsRunning_.push_back(step);
          }
          step->KillAndMarkCancel();
          stepsDone_.push_back(step);
        }
      }

      updateStatus |= ProcessDelayedCleanup(
          stepsRunning_, step_delayed_delete, stepsDoneFile);

      for(ns_Schedule::Step* step : stepsDone_) {
        if (step->monitor_count_ > 0) {
          step_delayed_delete.push_back(step);
        } else {
          ManageEndOfStep(stepsRunning_, step, stepsDoneFile);
          updateStatus = true;
        }
      }
    } catch (std::runtime_error& e) {
      fatal_error = e;
      goto ns_Schedule__Schedule__ScheduleLoop_fatal;
    }

    stepsDone_.clear();
  }

  tasksManager_.SaveStatus();
  ExportRunningSteps(config_.exportPath_ / "status.json", stepsRunning_);
  /*for (ns_Schedule::Step* step: steps_) {
    if (step->IsRunning()) {
      step->Shutdown();
    }
  }*/
  threadRunning_ = false;
  lockThread_.unlock();
  return;

ns_Schedule__Schedule__ScheduleLoop_fatal:
  threadRunning_ = false;
  lockThread_.unlock();
  throw fatal_error;
}

inline bool ns_Schedule::Schedule::ProcessDelayedCleanup(
    std::list<ns_Schedule::Step*>& steps, 
    std::list<ns_Schedule::Step*>& delayedSteps, 
    std::ofstream& stepsDoneFile) {
  bool aStepProcessed = false;
  for (auto it = delayedSteps.begin(); it != delayedSteps.end(); ) {
    ns_Schedule::Step* step = *it;
    if (step->monitor_count_ == 0) {
      ManageEndOfStep(steps, step, stepsDoneFile);
      it = delayedSteps.erase(it);
      aStepProcessed = true;
    } else {
      ++it;
    }
  }
  return aStepProcessed;
}

void ns_Schedule::Schedule::ManageEndOfStep(
    std::list<ns_Schedule::Step*>& steps, ns_Schedule::Step* step, 
    std::ofstream& stepsDoneFile) {
  std::cerr << "Remove step: " << step->ID() << std::endl;
  AppendStepToFinishLog(step->task_->steps_file_, *step);
  AppendStepToFinishLog(stepsDoneFile, *step);

  steps.remove(step);
  auto itStep = std::find(steps_.begin(), steps_.end(), step);
  if (itStep == steps_.end()) {
    throw std::runtime_error("Trying to delete an unknown step: name=" +
        step->name_ + ", id=" + step->ID());
  }
  bool taskCancelled = step->TaskCancelled();
  if (!taskCancelled) {
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
  if (taskCancelled) {
    for(auto const& aStep: steps_) {
      if (aStep->task_ == step->task_) {
        taskCancelled = false;
        break;
      }
    }
  }
  if (step->TaskDone() || taskCancelled) {
    // todo signal end of the flow
    uint64_t task_id = step->TaskID();
    step->FinalizeAndArchive(config_.exportPath_);
    tasksManager_.TaskEnded(step->task_);
    std::cout << "Tasks " << task_id << " done" << std::endl;
  }

  tasksManager_.SaveStatus();
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
