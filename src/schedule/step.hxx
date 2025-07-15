#pragma once

#include "task.hxx"
#include "executor/executor.hxx"
#include <cstdint>
#include <string>
#include <list>
#include <vector>
#include <atomic>
#include <chrono>
#include <filesystem>
#include <rapidjson/document.h>

namespace ns_Schedule {

class Step {
public:
  static uint16_t const exitCode_NotSet_;
  static uint16_t const exitCode_Timedout_;
  static uint16_t const exitCode_StepLaunchError_;

  Step(ns_Schedule::Task* task, std::string const& name);
  ~Step();

  void CopyParameters(Step const& step);

  void ReadFromJSON(rapidjson::Value const& entry);

  uint64_t TaskID() const;
  std::filesystem::path const& RunRootPath() const;
  std::filesystem::path const& FilesPath() const;
  std::filesystem::path const& FunctionsPath() const;

  bool IsFirstStepOfTask() const;
  bool IsReady() const;
  bool IsRunning() const;
  bool IsDone() const;
  bool IsTimedOut() const;

  void MarkRunning();
  void MarkDone(uint8_t exit_code);
  void KillAndMarkTimedout();

  bool TaskDone();
  void Execute();
  void Shutdown();
  void FinalClean(std::filesystem::path const& savePath);

  void ToJSON(rapidjson::Value& out, 
      rapidjson::Document::AllocatorType& alloc) const;

  std::string ID();

  ns_Schedule::Task* task_;
  std::string name_;
  uint64_t uuid_;
  uint64_t step_id_;
  uint64_t rank_id_;
  uint64_t attempt_id_;
  uint64_t run_id_;
  std::string executor_name_;
  ns_Executor::Executor* executor_;
  ns_Executor::ExecutorData* executor_data_;
  std::filesystem::path run_path_;
  std::string function_;
  std::string args_;
  uint32_t nb_cpu_;
  uint32_t nb_retry_;
  uint64_t timeout_;
  Step* next_;
  Step* previous_;
  std::list<Step*> dependencies_;
  std::list<Step*> depend_from_;
  std::vector<uint64_t> cpus_;
  std::filesystem::path stdout_;
  std::filesystem::path stderr_;
  uint16_t exit_code_;
  int32_t monitor_count_;

private:
  enum class State { 
    Pending, 
    Running, 
    Done, 
    TimedOut, 
    Shutdown
  };
  State state_;
  std::chrono::time_point<std::chrono::steady_clock> time_points_[2];

  static std::atomic<uint64_t> next_uuid_;
  static uint64_t ToMillis(std::chrono::time_point<std::chrono::steady_clock> const& tp);
};

inline uint64_t Step::TaskID() const {
  return task_->id_;
}

inline std::filesystem::path const& Step::RunRootPath() const {
  return task_->run_root_path_;
}

inline std::filesystem::path const& Step::FilesPath() const {
  return task_->files_path_;
}

inline std::filesystem::path const& Step::FunctionsPath() const {
  return task_->functions_path_;
}

inline bool Step::IsFirstStepOfTask() const{
  return ((step_id_ == 0) && (rank_id_ == 0) && (attempt_id_ == 0));
}

inline bool Step::IsReady() const { 
  return state_ == State::Pending && depend_from_.empty();
}

inline bool Step::IsRunning() const { 
  return state_ == State::Running;
}

inline bool Step::IsDone() const {
  return state_ >= State::Done;
}

inline bool Step::IsTimedOut() const {
  if (state_ > State::Running) {
    return (exit_code_ & 0x0200) == 0x0200;
  }
  auto now = std::chrono::steady_clock::now();
  auto elapsed = std::chrono::duration_cast<std::chrono::seconds>(now - time_points_[0]);
  return (timeout_ > 0) && (elapsed.count() >= timeout_);
}

inline void Step::MarkRunning() {
  state_ = State::Running;
  time_points_[0] = std::chrono::steady_clock::now();
}

inline void Step::MarkDone(uint8_t exit_code) {
  if (state_ != State::Running) {
    throw std::runtime_error("Can not mark done a not running task");
  }
  state_ = State::Done;
  time_points_[1] = std::chrono::steady_clock::now();
  exit_code_ = exit_code;
}

inline void Step::KillAndMarkTimedout() {
  executor_->Shutdown(*this);
  state_ = State::TimedOut;
  time_points_[1] = std::chrono::steady_clock::now();
  exit_code_ = exitCode_Timedout_;
}

inline void Step::Execute() {
  executor_->Execute(*this);
}

inline void Step::Shutdown() {
  if (state_ == State::Running) {
    executor_->Shutdown(*this, true);
    state_ = State::Shutdown;
  }
}

inline void Step::FinalClean(std::filesystem::path const& savePath) {
  if (state_ >= State::Running) {
    executor_->FinalClean(savePath, *task_);
  }
}

inline std::string Step::ID() {
  return std::to_string(task_->id_) + '-' +
    std::to_string(step_id_) + '-' +
    std::to_string(rank_id_) + '-' +
    std::to_string(attempt_id_);
}

};