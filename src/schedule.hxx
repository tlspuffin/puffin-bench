#pragma once

#include <vector>
#include <list>
#include <string>
#include <mutex>
#include <thread>
#include <rapidjson/document.h>

class Schedule {
public:
  Schedule(uint64_t maxCPU);
  ~Schedule();
  bool AddJob(std::string tasksList, std::vector<std::string> files);

private:
  struct Step {
    std::string name_;
    uint64_t uuid_;
    uint64_t task_id_;
    uint64_t step_id_;
    uint64_t rank_id_;
    std::string run_path;
    std::string function_;
    std::string args_;
    uint32_t nb_cpu_;
    uint32_t nb_retry_;
    uint64_t timeout_;
    Step* next_;
    Step* previous_;
    std::list<Step*> dependencies_;
    std::list<Step*> depend_from_;
    int8_t state_;
    pid_t pid_;
    std::vector<uint64_t> cpus_;
    std::string stdout;
    std::string stderr;
    Step(std::string const& name) : name_(name), uuid_((uint64_t)this), 
        task_id_(0), step_id_(0), rank_id_(0), run_path(), function_(name), 
        args_(), nb_cpu_(1), nb_retry_(0), timeout_(0), next_(this), 
        previous_(this), dependencies_(), depend_from_(), state_(0), 
        pid_(0), cpus_(), stdout(), stderr() {}
    void CloneParameters(Step const& step) {
      args_ = step.args_;
      nb_cpu_ = step.nb_cpu_;
      nb_retry_ = step.nb_retry_;
      timeout_ = step.timeout_;
    }
  };

  std::list<Step*> BuildStepsFromJson(const rapidjson::Value& root);
  void ScheduleLoop();
  void ManageEndOfStep(Schedule::Step* step);
  pid_t Execute(Schedule::Step* step);

  static void DeleteTask(Schedule::Step* rootStep);
  static std::list<Schedule::Step*> SearchTaskToRun(uint64_t nbCPUsFree, std::list<Schedule::Step*>& task);
  static void ExtractStep(Schedule::Step* step, rapidjson::Value const& entry);

  std::string script_path_;
  std::string run_path_;

  uint64_t next_task_id_;
  uint64_t maxCPU_;
  std::mutex lockThread_;
  std::thread thread_;
  bool threadRunning_;
  std::list<Step*> tasks_;
  std::list<Step*> steps_;
};