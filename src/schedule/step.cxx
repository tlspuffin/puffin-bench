#include "step.hxx"

uint16_t const ns_Schedule::Step::exitCode_NotSet_ = 0x0100;
uint16_t const ns_Schedule::Step::exitCode_Timedout_ = 0x0200;
uint16_t const ns_Schedule::Step::exitCode_StepLaunchError_ = 0x0400;
std::atomic<uint64_t> ns_Schedule::Step::next_uuid_ = 0;

static uint64_t parseTimeout(const std::string& str) {
    if (str.empty()) return 0;
    char unit = str.back();
    int value = std::stoi(str.substr(0, str.size() - 1));
    if (unit == 'd') return value * 60 * 60 * 24;
    if (unit == 'h') return value * 60 * 60;
    if (unit == 'm') return value * 60;
    if (unit == 's') return value;
    return value;
}

ns_Schedule::Step::Step(ns_Schedule::Task* task, std::string const& name) 
    : task_(task), name_(name), uuid_(++next_uuid_), step_id_(0), 
      rank_id_(0), attempt_id_(0), run_id_(0), executor_name_("default"), 
      executor_(nullptr), executor_data_(nullptr), run_path_(), 
      function_(name), args_(), nb_cores_(1), nb_retry_(0), timeout_(0), 
      next_(this), previous_(this), dependencies_(), depend_from_(), 
      state_(State::Pending), stdout_(), stderr_(), 
      exit_code_(exitCode_NotSet_), monitor_count_(0)
{
}

ns_Schedule::Step::~Step() {
  if (executor_data_ != nullptr) {
    delete executor_data_;
  }
}

void ns_Schedule::Step::CopyParameters(Step const& step) {
  executor_ = step.executor_;
  function_ = step.function_;
  depend_from_ = step.depend_from_;

  args_ = step.args_;
  nb_cores_ = step.nb_cores_;
  nb_retry_ = step.nb_retry_;
  timeout_ = step.timeout_;
}

void ns_Schedule::Step::ReadFromTaskJSON(rapidjson::Value const& entry) {
  if (entry.HasMember("executor") && entry["executor"].IsString())
    executor_name_ = entry["executor"].GetString();
  if (entry.HasMember("args") && entry["args"].IsString())
    args_ = entry["args"].GetString();
  if (entry.HasMember("nbCores") && entry["nbCores"].IsInt())
    nb_cores_ = static_cast<uint32_t>(entry["nbCores"].GetInt());
  if (entry.HasMember("retry") && entry["retry"].IsInt())
    nb_retry_ = static_cast<uint32_t>(entry["retry"].GetInt());
  if (entry.HasMember("maxtime") && entry["maxtime"].IsString())
    timeout_ = parseTimeout(entry["maxtime"].GetString());
}

bool ns_Schedule::Step::TaskDone() {
  if (dependencies_.empty()) {
    bool allStepDone = true;
    for(ns_Schedule::Step* itStep = next_; itStep != this; itStep = itStep->next_) {
      allStepDone &= itStep->IsDone();
    }
    return allStepDone;
  }
  return false;
}

void ns_Schedule::Step::ToJSON(rapidjson::Value& out, 
    rapidjson::Document::AllocatorType& alloc) const {
  out.SetObject();

  auto executorTaskData = task_->executors_.find(executor_);
  if (executorTaskData != task_->executors_.end()) {
    rapidjson::Value executorTaskDataJSON(rapidjson::kObjectType);
    executorTaskData->second->ToJSON(executorTaskDataJSON, alloc);
    out.AddMember("task_executor_data", executorTaskDataJSON, alloc);
  }
  out.AddMember("name", rapidjson::Value(name_.c_str(), alloc), alloc);
  out.AddMember("uuid", uuid_, alloc);
  out.AddMember("task_id", TaskID(), alloc);
  out.AddMember("step_id", step_id_, alloc);
  out.AddMember("rank_id", rank_id_, alloc);
  out.AddMember("attempt_id", attempt_id_, alloc);
  out.AddMember("run_id", run_id_, alloc);
  out.AddMember("executor_name", rapidjson::Value(executor_name_.c_str(), alloc), alloc);
  out.AddMember("run_root_path", rapidjson::Value(RunRootPath().c_str(), alloc), alloc);
  out.AddMember("run_path", rapidjson::Value(run_path_.c_str(), alloc), alloc);
  out.AddMember("files_path", rapidjson::Value(FilesPath().c_str(), alloc), alloc);
  out.AddMember("functions_path", rapidjson::Value(FunctionsPath().c_str(), alloc), alloc);
  out.AddMember("function", rapidjson::Value(function_.c_str(), alloc), alloc);
  out.AddMember("args", rapidjson::Value(args_.c_str(), alloc), alloc);
  out.AddMember("nb_cores", nb_cores_, alloc);
  out.AddMember("nb_retry", nb_retry_, alloc);
  out.AddMember("timeout", timeout_, alloc);
  out.AddMember("stdout", rapidjson::Value(stdout_.c_str(), alloc), alloc);
  out.AddMember("stderr", rapidjson::Value(stderr_.c_str(), alloc), alloc);
  out.AddMember("exit_code", exit_code_, alloc);
  out.AddMember("monitor_count", monitor_count_, alloc);
  char const* stateStr = nullptr;
  switch (state_) {
    case State::Pending: stateStr = "Pending"; break;
    case State::Running: stateStr = "Running"; break;
    case State::Done: stateStr = "Done"; break;
    case State::TimedOut: stateStr = "TimedOut"; break;
    case State::Shutdown: stateStr = "Shutdown"; break;
  }
  out.AddMember("state", rapidjson::Value(stateStr, alloc), alloc);
  if (executor_ != nullptr) {
    out.AddMember("executor", rapidjson::Value(executor_->Name().c_str(), alloc), alloc);  
  }
  if (executor_data_ != nullptr) {
    rapidjson::Value executorDataJSON(rapidjson::kObjectType);
    executor_data_->ToJSON(executorDataJSON, alloc);
    out.AddMember("executor_data", executorDataJSON, alloc);
  }
  rapidjson::Value timepoints(rapidjson::kArrayType);
  timepoints.PushBack(ToMillis(time_points_[0]), alloc);
  timepoints.PushBack(ToMillis(time_points_[1]), alloc);
  out.AddMember("time_points_ms", timepoints, alloc);
}

inline uint64_t ns_Schedule::Step::ToMillis(
    std::chrono::time_point<std::chrono::steady_clock> const& tp) {
  return static_cast<uint64_t>(
      std::chrono::duration_cast<std::chrono::milliseconds>(
      tp.time_since_epoch()).count());
}