#pragma once

#include <stdint.h>
#include <string>
#include <list>
#include <vector>
#include <rapidjson/document.h>

namespace ns_Schedule {

class Step {
public:
  Step(std::string const& name);
  void CopyParameters(Step const& step);

  void ReadFromJSON(rapidjson::Value const& entry);

  bool IsFirstStepOfTask() const;
  bool IsReady() const;
  bool IsRunning() const;
  bool IsDone() const;

  void MarkRunning();
  void MarkDone();

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
  pid_t pid_;
  std::vector<uint64_t> cpus_;
  std::string stdout_;
  std::string stderr_;
  uint16_t exit_code_;

private:
  int8_t state_;
};

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

inline void Step::MarkRunning() {
  state_ = 1;
}

inline void Step::MarkDone() {
  state_ = 2;
}

};