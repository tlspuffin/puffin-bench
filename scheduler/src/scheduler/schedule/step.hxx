#pragma once

#include "task.hxx"
#include "executor/executor.hxx"
#include "executor/executors_provider.hxx"
#include "step_configurations.hxx"
#include "archiver.hxx"
#include "monitor/task.hxx"
#include <cstdint>
#include <string>
#include <list>
#include <vector>
#include <atomic>
#include <chrono>
#include <filesystem>
#include <rapidjson/document.h>

namespace ns_Schedule {

class Schedule;

class Step {
public:
  static uint16_t constexpr exitCode_NotSet_ = 0x0100;
  static uint16_t constexpr exitCode_Timedout_ = 0x0200;
  static uint16_t constexpr exitCode_Cancelled_ = 0x0400;
  static uint16_t constexpr exitCode_LaunchError_ = 0x0800;
  static uint16_t constexpr exitCode_NoExitCode_ = 0x1000;
  static uint16_t constexpr exitCode_Killed_ = 0x2000;
  static uint16_t constexpr exitCode_Lost_ = 0x4000;

  static uint16_t constexpr stepsGroup_None_ = 0x0000;
  static uint16_t constexpr stepsGroup_In_ = 0x0001;
  static uint16_t constexpr stepsGroup_Begin_ = 0x0003;
  static uint16_t constexpr stepsGroup_End_ = 0x0005;

  struct UUIDDependencies {
    uint64_t next;
    uint64_t previous;
    std::vector<uint64_t> dependencies;
    std::vector<uint64_t> depend_from;

    void Reset() {
      next = 0; previous = 0; depend_from.clear(); dependencies.clear();
    }
  };

  Step(Step const& source, uint64_t run_id, uint64_t attempt_id, 
      std::list<ns_Schedule::Step*> dependFrom);
  Step(Step const& source, uint64_t run_id, 
      uint64_t rank_id, uint64_t attempt_id, uint64_t group_id, 
      std::list<ns_Schedule::Step*> dependFrom, 
      std::vector<rapidjson::Value const*> configurationStack, 
      GroupStepConfigurations const& groupConfigurations, 
      rapidjson::Value const* configuration);
  Step(ns_Schedule::Task* task, std::string const& name, 
    uint64_t run_id, uint64_t step_id, uint64_t group_id, uint16_t group_status, 
    std::list<ns_Schedule::Step*> dependFrom, 
    GroupStepConfigurations const& groupConfigurations, 
    std::vector<rapidjson::Value const*> configurationStack, 
    rapidjson::Value const* configuration,
    rapidjson::Value const* monitorJSON);
  Step(ns_Schedule::Task* task, rapidjson::Value const& config, 
      struct UUIDDependencies& dependencies);
  ~Step();

  void ReadFromTaskJSON(
      std::vector<rapidjson::Value const*> configurationStack, 
      GroupStepConfigurations const& groupConfigurations, 
      rapidjson::Value const* configuration);

  uint64_t TaskID() const;

  bool IsPending() const;
  bool IsReady() const;
  bool IsRunning() const;
  bool IsDone() const;
  bool IsTimedOut() const;
  bool IsOSKilled() const;

  std::chrono::time_point<std::chrono::system_clock> StartTime() const;
  std::chrono::milliseconds RunTime() const;

  void MarkPending();
  void MarkRunning();
  void MarkDone(uint16_t exit_code);
  void MarkCancel();
  void MarkLaunchError();
  void KillAndMarkTimedout();
  void KillAndMarkCancel();

  bool TaskFirstStep();
  bool TaskLastStep();
  bool TaskCancelled();
  void Execute();
  void Shutdown();
  void GatherFilesToLocal();
  struct ArchiveJob FinalizeAndArchive(std::filesystem::path const& savePath);

  void SetUserRunState(std::string const& state);

  void ToJSON(rapidjson::Value& out, 
      rapidjson::Document::AllocatorType& alloc, 
      bool exportTask) const;

  std::string ID() const;
  std::string GID() const;

  void UpdateStats();

  ns_Schedule::Task* task_;
  std::string name_;
  std::string id_;
  uint64_t uuid_;
  uint64_t group_id_;
  uint64_t step_id_;
  uint64_t rank_id_;
  uint64_t attempt_id_;
  uint64_t run_id_;
  ns_Executor::ExecutorData* executor_data_;
  std::string function_;
  std::unordered_map<std::string, std::string> args_;
  uint32_t nb_cores_;
  uint32_t nb_retry_;
  uint64_t memory_max_;
  uint64_t timeout_;
  Step* next_;
  Step* previous_;
  std::list<Step*> dependencies_;
  std::list<Step*> depend_from_;
  std::filesystem::path stdout_;
  std::filesystem::path stderr_;
  uint16_t exit_code_;
  int32_t monitor_count_;

  bool request_cancel_;

  std::shared_ptr<ns_Monitor::Task> monitor_;
  std::filesystem::path monitor_path_;
  std::string message_from_run_;

  uint16_t group_status_;

private:
  enum class State { 
    Pending, 
    Running, 
    Done, 
    TimedOut, 
    Cancelled, 
    Shutdown, 
    LaunchError, 
  };
  State state_;
  bool end_processed_;
  std::chrono::time_point<std::chrono::system_clock> time_points_[2];
  std::string user_run_state_;

  Step(Step const& src);

  static std::atomic<uint64_t> next_uuid_;
  static uint64_t ToMillis(std::chrono::time_point<std::chrono::system_clock> const& tp);
  static std::chrono::system_clock::time_point FromMillis(uint64_t millis);
  static std::string StateEnumToString(State state);
  static State StateStringToEnum(std::string const& state);
};

inline uint64_t Step::TaskID() const {
  return task_->id_;
}

inline bool Step::IsPending() const { 
  return state_ == State::Pending;
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
  auto now = std::chrono::system_clock::now();
  auto elapsed = std::chrono::duration_cast<std::chrono::seconds>(now - time_points_[0]);
  return (timeout_ > 0) && (elapsed.count() >= timeout_);
}

inline bool Step::IsOSKilled() const {
  return (state_ == State::Done) && (exit_code_ == Step::exitCode_Killed_);
}

inline std::chrono::time_point<std::chrono::system_clock> Step::StartTime() const {
  if (state_ < State::Running) {
    return std::chrono::time_point<std::chrono::system_clock>::clock::now();
  }
  return time_points_[0];
}

inline std::chrono::milliseconds Step::RunTime() const {
  if ((state_ != State::Done) && (state_ != State::TimedOut)) {
    return std::chrono::milliseconds::zero();
  }
  return std::chrono::duration_cast<std::chrono::milliseconds>(time_points_[1] - time_points_[0]);
}


inline void Step::MarkPending() {
  state_ = State::Pending;
  if (executor_data_ != nullptr) {
    delete executor_data_;
    executor_data_ = nullptr;
  }
}

inline void Step::MarkRunning() {
  if (state_ != State::Pending) {
    throw std::runtime_error("Can not mark running a not pending task");
  }
  state_ = State::Running;
  time_points_[0] = std::chrono::system_clock::now();
}

inline void Step::MarkDone(uint16_t exit_code) {
  if (state_ != State::Running) {
    throw std::runtime_error("Can not mark done a not running task");
  }
  state_ = State::Done;
  time_points_[1] = std::chrono::system_clock::now();
  exit_code_ = exit_code;
}

inline void Step::MarkCancel() {
  if (state_ != State::Pending) {
    throw std::runtime_error("Can not mark cancel a not pending task");
  }
  state_ = State::Cancelled;
  time_points_[1] = std::chrono::system_clock::now();
  exit_code_ = exitCode_Cancelled_;
}

inline void Step::MarkLaunchError() {
  state_ = State::LaunchError;
  time_points_[1] = std::chrono::system_clock::now();
  exit_code_ = exitCode_LaunchError_;
}

inline void Step::KillAndMarkTimedout() {
  task_->executor_->Shutdown(*this);
  state_ = State::TimedOut;
  time_points_[1] = std::chrono::system_clock::now();
  exit_code_ = exitCode_Timedout_;
}

inline void Step::KillAndMarkCancel() {
  if (state_ == State::Running) {
    task_->executor_->Shutdown(*this);
  }
  state_ = State::Cancelled;
  time_points_[1] = std::chrono::system_clock::now();
  exit_code_ = exitCode_Cancelled_;
}

inline bool Step::TaskCancelled() {
  return task_->request_cancel_;
}

inline void Step::Execute() {
  if (TaskFirstStep()) {
    task_->PrepareToRun();
  }
  task_->executor_->Execute(*this);
}

inline void Step::Shutdown() {
  if (state_ == State::Running) {
    task_->executor_->Shutdown(*this);
    state_ = State::Shutdown;
  }
}

inline void Step::GatherFilesToLocal() {
  if (state_ >= State::Running) {
    task_->executor_->GatherFilesToLocal(*this);
  }
  end_processed_ = true;
}

inline struct ArchiveJob Step::FinalizeAndArchive(std::filesystem::path const& savePath) {
  if (state_ >= State::Running) {
    return task_->FinalizeAndArchive(request_cancel_ ? savePath / "Canceled" : savePath);
  }
  return ArchiveJob();
}

inline void Step::SetUserRunState(std::string const& state) {
  user_run_state_ = state;
}

inline std::string Step::ID() const {
  return std::to_string(step_id_) + '-' +
    std::to_string(rank_id_) + '-' +
    std::to_string(attempt_id_);
}

inline std::string Step::GID() const {
  return std::to_string(group_id_ - 1) + '-' +
    std::to_string(rank_id_) + '-' +
    std::to_string(attempt_id_);
}

};
