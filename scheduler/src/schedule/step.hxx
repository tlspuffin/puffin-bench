#pragma once

#include <stdint.h>
#include <signal.h>
#include <sys/wait.h>
#include <string>
#include <list>
#include <vector>
#include <chrono>
#include <rapidjson/document.h>

namespace ns_Schedule {

class Step {
public:
  Step(std::string const& name);
  void CopyParameters(Step const& step);

  void ReadFromJSON(rapidjson::Value const& entry);

  pid_t PID() const;
  bool IsFirstStepOfTask() const;
  bool IsReady() const;
  bool IsRunning() const;
  bool IsDone() const;
  bool IsTimedOut() const;

  void Kill();
  void MarkRunning(pid_t pid);
  void MarkDone(uint8_t exit_code);
  void KillAndMarkTimedout();

  std::string name_;
  uint64_t uuid_;
  uint64_t task_id_;
  uint64_t step_id_;
  uint64_t rank_id_;
  uint64_t attempt_id_;
  std::string run_path_;
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
  std::string stdout_;
  std::string stderr_;
  uint16_t exit_code_;
  int32_t monitor_count_;

private:
  int8_t state_;
  pid_t pid_;
  std::chrono::time_point<std::chrono::steady_clock> time_points_[2];
};

inline pid_t Step::PID() const {
  return pid_;
}

inline bool Step::IsFirstStepOfTask() const{
  return ((step_id_ == 0) && (rank_id_ == 0) && (attempt_id_ == 0));
}

inline bool Step::IsReady() const { 
  return state_ == 0 && depend_from_.empty();
}

inline bool Step::IsRunning() const { 
  return state_ == 1;
}

inline bool Step::IsDone() const {
  return state_ == 2;
}

inline bool Step::IsTimedOut() const {
  if (state_ > 1) return (exit_code_ & 0x0200) == 0x0200; 
  auto now = std::chrono::steady_clock::now();
  auto elapsed = std::chrono::duration_cast<std::chrono::seconds>(now - time_points_[0]);
  return (timeout_ > 0) && (elapsed.count() >= timeout_);
}

inline void Step::Kill() {
  kill(-pid_, SIGKILL);
  if (state_ == 1) {
    state_ = 4;
    waitpid(pid_, nullptr, 0);
  }
}

inline void Step::MarkRunning(pid_t pid) {
  state_ = 1;
  pid_ = pid;
  time_points_[0] = std::chrono::steady_clock::now();
}

inline void Step::MarkDone(uint8_t exit_code) {
  state_ = 2;
  pid_ = 0;
  time_points_[1] = std::chrono::steady_clock::now();
  exit_code_ = exit_code;
}

inline void Step::KillAndMarkTimedout() {
  kill(-pid_, SIGKILL);
  state_ = 3;
  pid_ = 0;
  time_points_[1] = std::chrono::steady_clock::now();
  exit_code_ = 0x0200;
}

};