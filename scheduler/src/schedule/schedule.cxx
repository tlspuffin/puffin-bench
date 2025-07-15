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
      threadRunning_(false), defaultExecutor_("local")
{
  for (auto const& executorConfig : config.executors_) {
    ns_Executor::Executor* executor = ns_Executor::Executor::Build(executorConfig.second);
    executors_.insert(std::make_pair<>(executor->Name(), executor));
  }

  std::list<ns_Schedule::Step*> running;
  std::list<ns_Schedule::Step*> step_delayed_delete;
  ExportRunningSteps(config_.exportPath_ / "status.json", running);
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
    std::unordered_map<std::string, std::vector<uint8_t>>& files) {
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
      tasksManager_.CreateTask(stepsJSON, functions, files, 
      defaultExecutor_, executors_);

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
  std::list<ns_Schedule::Step*> running;
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
    running.insert(running.end(), toRun.begin(), toRun.end());

    if ((toRun.size() > 0) || updateStatus) {
      ExportRunningSteps(config_.exportPath_ / "status.json", running);
      updateStatus = false;
    }

    std::list<ns_Schedule::Step*> stepsDone;
    //while(threadRunning_ && (stepsDone.size() == 0)) {
      std::this_thread::sleep_for (std::chrono::seconds(1));
      for(auto& executor : executors_) {
        std::list<ns_Schedule::Step*> executorStepsDone = executor.second->CheckFinishedSteps(running);
        stepsDone.insert(stepsDone.end(), executorStepsDone.begin(), executorStepsDone.end());
        for(ns_Schedule::Step* step : executorStepsDone) {
          std::cerr << "Done step: " << step->ID() << std::endl;
        }
      }

      for (ns_Schedule::Step* step : running) {
        if (step->IsRunning() && step->IsTimedOut()) {
          std::cout << "Step " << step->ID() << " timeouted" << std::endl;
          step->KillAndMarkTimedout();
          stepsDone.push_back(step);
        }
      }
    //}

    lockThread_.lock();
    try {
      ProcessDelayedCleanup(running, step_delayed_delete);

      for(ns_Schedule::Step* step : stepsDone) {
        if (step->monitor_count_ > 0) {
          step_delayed_delete.push_back(step);
        } else {
          ManageEndOfStep(running, step);
          AppendStepToFinishLog(stepsDoneFile, *step);
          updateStatus = true;
          std::cerr << "Remove step: " << step->ID() << std::endl;
        }
      }
    } catch (std::runtime_error& e) {
      fatal_error = e;
      goto ns_Schedule__Schedule__ScheduleLoop_fatal;
    }
  }

  for (ns_Schedule::Step* step: steps_) {
    if (step->IsRunning()) {
      step->Shutdown();
    }
  }
  ExportRunningSteps(config_.exportPath_ / "status.json", running);
  threadRunning_ = false;
  lockThread_.unlock();
  return;

ns_Schedule__Schedule__ScheduleLoop_fatal:
  threadRunning_ = false;
  lockThread_.unlock();
  throw fatal_error;
}

inline void ns_Schedule::Schedule::ProcessDelayedCleanup(std::list<ns_Schedule::Step*>& steps, 
    std::list<ns_Schedule::Step*>& delayedSteps) {
  for (auto it = delayedSteps.begin(); it != delayedSteps.end(); ) {
    ns_Schedule::Step* step = *it;
    if (step->monitor_count_ == 0) {
      ManageEndOfStep(steps, step);
      it = delayedSteps.erase(it);
    } else {
      ++it;
    }
  }
}

void ns_Schedule::Schedule::ManageEndOfStep(
    std::list<ns_Schedule::Step*>& steps, ns_Schedule::Step* step) {
  steps.remove(step);
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
        step->name_ + ", id=" + step->ID());
  }
  steps_.remove(step);
  if (step->TaskDone()) {
    // todo signal end of the flow
    step->FinalClean(config_.exportPath_);
    tasksManager_.TaskEnded(step->task_);
    std::cout << "Tasks " << step->TaskID() << " done" << std::endl;
  }
}

void ns_Schedule::Schedule::ExportRunningSteps(std::string const& filename, 
    std::list<ns_Schedule::Step*> const& steps) const {
  rapidjson::Document doc;
  doc.SetObject();
  rapidjson::MemoryPoolAllocator<>& alloc = doc.GetAllocator();

  rapidjson::Value arr(rapidjson::kArrayType);
  for (Step const* step : steps) {
    rapidjson::Value val;
    step->ToJSON(val, alloc);
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
  step.ToJSON(doc, doc.GetAllocator());
  doc.Accept(writer);

  log << buffer.GetString() << std::endl;
  log.flush();
}
