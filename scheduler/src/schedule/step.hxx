#pragma once

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

  Step(std::string const& name);
  void CopyParameters(Step const& step);

  void ReadFromJSON(rapidjson::Value const& entry);

  pid_t PID() const;
  bool IsFirstStepOfTask() const;
  bool IsReady() const;
  bool IsRunning() const;
  bool IsDone() const;
  bool IsTimedOut() const;

  void MarkRunning(pid_t pid);
  void MarkDone(uint8_t exit_code);
  void KillAndMarkTimedout();

  void Execute();
  void Shutdown();
  void FinalClean();

  void ToJSON(rapidjson::Value& out, 
      rapidjson::Document::AllocatorType& alloc) const;

  std::string name_;
  uint64_t uuid_;
  uint64_t task_id_;
  uint64_t step_id_;
  uint64_t rank_id_;
  uint64_t attempt_id_;
  std::string executor_name_;
  ns_Executor::Executor* executor_;
  std::filesystem::path run_root_path_;
  std::filesystem::path run_path_;
  std::filesystem::path functions_path_;
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
  pid_t pid_;
  std::chrono::time_point<std::chrono::steady_clock> time_points_[2];

  static std::atomic<uint64_t> next_uuid_;
  static uint64_t ToMillis(std::chrono::time_point<std::chrono::steady_clock> const& tp);
};

inline pid_t Step::PID() const {
  return pid_;
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
  return state_ == State::Done;
}

inline bool Step::IsTimedOut() const {
  if (state_ > State::Running) return (exit_code_ & 0x0200) == 0x0200; 
  auto now = std::chrono::steady_clock::now();
  auto elapsed = std::chrono::duration_cast<std::chrono::seconds>(now - time_points_[0]);
  return (timeout_ > 0) && (elapsed.count() >= timeout_);
}

inline void Step::MarkRunning(pid_t pid) {
  state_ = State::Running;
  pid_ = pid;
  time_points_[0] = std::chrono::steady_clock::now();
}

inline void Step::MarkDone(uint8_t exit_code) {
  if (state_ != State::Running) return;
  state_ = State::Done;
  pid_ = 0;
  time_points_[1] = std::chrono::steady_clock::now();
  exit_code_ = exit_code;
}

inline void Step::KillAndMarkTimedout() {
  executor_->Shutdown(*this);
  state_ = State::TimedOut;
  pid_ = 0;
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

inline void Step::FinalClean() {
  if (state_ >= State::Running) {
    executor_->FinalClean(*this);
  }
}

};