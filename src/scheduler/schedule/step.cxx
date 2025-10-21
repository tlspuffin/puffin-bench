#include "step.hxx"
#include "schedule.hxx"
#include "../utils/rapidjson.hxx"
#include "../utils/logs.hxx"

std::atomic<uint64_t> ns_Schedule::Step::next_uuid_ = 0;

ns_Schedule::Step::Step(ns_Schedule::Step const& source, uint64_t run_id, 
    uint64_t attempt_id) 
    : task_(source.task_), name_(source.name_), id_(source.id_), uuid_(++next_uuid_),
    step_id_(source.step_id_), rank_id_(source.rank_id_), attempt_id_(attempt_id), 
    run_id_(run_id), executor_name_(source.executor_name_), executor_(source.executor_), 
    executor_data_(source.executor_data_), function_(source.function_), 
    args_(source.args_), nb_cores_(source.nb_cores_), nb_retry_(source.nb_retry_), 
    timeout_(source.timeout_), next_(const_cast <ns_Schedule::Step *>(&source)), 
    previous_(const_cast <ns_Schedule::Step *>(&source)), 
    dependencies_(source.dependencies_), depend_from_(source.depend_from_), 
    stdout_(), stderr_(), exit_code_(exitCode_NotSet_), monitor_count_(0), 
    request_cancel_(false), state_(State::Pending), end_processed_(false)
{
  std::string step_name = ID();
  stdout_ = source.task_->logs_path_ / ("stdout." + step_name + ".txt");
  stderr_ = source.task_->logs_path_ / ("stderr." + step_name + ".txt");

  //LOGE(__LINE__ << " Create step " << this << " " << uuid_ << " " << id_);
}

ns_Schedule::Step::Step(ns_Schedule::Step const& source, uint64_t run_id, 
    uint64_t rank_id, uint64_t attempt_id, 
    ns_Executor::ExecutorsProvider const& executorsProvider,
    std::vector<rapidjson::Value const*> configurationStack, 
    rapidjson::Value const* configuration) 
    : task_(source.task_), name_(source.name_), id_(source.id_), uuid_(++next_uuid_),
    step_id_(source.step_id_), rank_id_(rank_id), attempt_id_(attempt_id), 
    run_id_(run_id), executor_name_(source.executor_name_), executor_(source.executor_), 
    executor_data_(source.executor_data_), function_(source.function_), 
    args_(source.args_), nb_cores_(source.nb_cores_), nb_retry_(source.nb_retry_), 
    timeout_(source.timeout_), next_(const_cast <ns_Schedule::Step *>(&source)), 
    previous_(const_cast <ns_Schedule::Step *>(&source)), 
    dependencies_(source.dependencies_), depend_from_(source.depend_from_), 
    stdout_(), stderr_(), exit_code_(exitCode_NotSet_), monitor_count_(0), 
    request_cancel_(false), state_(State::Pending), end_processed_(false)
{
  ReadFromTaskJSON(configurationStack, configuration);

  if (executor_name_.compare(source.executor_name_) != 0) {
    executor_ = executorsProvider.GetExecutor(executor_name_);
  }

  std::string step_name = ID();
  stdout_ = source.task_->logs_path_ / ("stdout." + step_name + ".txt");
  stderr_ = source.task_->logs_path_ / ("stderr." + step_name + ".txt");

  //LOGE(__LINE__ << " Create step " << this << " " << uuid_ << " " << id_);
}

ns_Schedule::Step::Step(ns_Schedule::Task* task, std::string const& name, 
    uint64_t run_id, uint64_t step_id, 
    std::list<ns_Schedule::Step*> dependFrom, 
    ns_Executor::ExecutorsProvider const& executorsProvider,
    std::vector<rapidjson::Value const*> configurationStack, 
    rapidjson::Value const* configuration) 
    : task_(task), name_(name), id_(), uuid_(++next_uuid_), step_id_(step_id), 
    rank_id_(0), attempt_id_(0), run_id_(run_id), executor_name_("default"), 
    executor_(nullptr), executor_data_(nullptr), function_(name), 
    args_(), nb_cores_(1), nb_retry_(0), timeout_(0), 
    next_(this), previous_(this), dependencies_(), depend_from_(dependFrom), 
    stdout_(), stderr_(), exit_code_(exitCode_NotSet_), monitor_count_(0), 
    request_cancel_(false), state_(State::Pending), end_processed_(false)
{
  ReadFromTaskJSON(configurationStack, configuration);

  executor_ = executorsProvider.GetExecutor(executor_name_);

  std::string step_name = ID();
  stdout_ = task_->logs_path_ / ("stdout." + step_name + ".txt");
  stderr_ = task_->logs_path_ / ("stderr." + step_name + ".txt");

  //LOGE(__LINE__ << " Create step " << this << " " << uuid_ << " " << id_);
}

ns_Schedule::Step::Step(ns_Schedule::Task* task, 
    rapidjson::Value const& config, 
    ns_Executor::ExecutorsProvider const* executorsProvider, 
    struct UUIDDependencies& dependencies) {
  dependencies.Reset();

  if (!config.IsObject()) {
    throw std::runtime_error("Step JSON must be an object");
  }
  if (config.HasMember("task")) {
    throw std::runtime_error("Step JSON is incompatible");
  }

  task_ = task;

  name_ = Get<std::string>(config, "name");
  id_ = Get<std::string>(config, "id");
  uuid_ = Get<uint64_t>(config, "uuid");
  step_id_ = Get<uint64_t>(config, "step_id");
  rank_id_ = Get<uint64_t>(config, "rank_id");
  attempt_id_ = Get<uint64_t>(config, "attempt_id");
  run_id_ = Get<uint64_t>(config, "run_id");
  executor_name_ = Get<std::string>(config, "executor_name");

  function_ = Get<std::string>(config, "function");

  args_.clear();
  if (config.HasMember("args") && config["args"].IsObject()) {
    rapidjson::Value const& argsObj = config["args"];
    for (auto it = argsObj.MemberBegin(); it != argsObj.MemberEnd(); ++it) {
      std::string key = it->name.GetString();
      if (it->value.IsString()) {
        args_[key] = it->value.GetString();
      }
    }
  }

  nb_cores_ = Get<uint64_t>(config, "nb_cores");
  nb_retry_ = Get<uint64_t>(config, "nb_retry");
  timeout_ = Get<uint64_t>(config, "timeout");

  if ((!config.HasMember("dependencies")) || 
      (!config["dependencies"].IsObject())) {
    throw std::runtime_error("");
  }
  rapidjson::Value const& dependenciesJSON = config["dependencies"];
  rapidjson::Value const& up = dependenciesJSON["up"];
  rapidjson::Value const& down = dependenciesJSON["down"];
  if ((!up.IsArray()) || (!down.IsArray())) {
    throw std::runtime_error("");
  }
  dependencies.previous = Get<uint64_t>(dependenciesJSON, "previous");
  dependencies.next = Get<uint64_t>(dependenciesJSON, "next");
  for (rapidjson::SizeType i = 0; i < up.Size(); ++i) {
    dependencies.depend_from.push_back(up[i].GetUint64());
  }
  for (rapidjson::SizeType i = 0; i < down.Size(); ++i) {
    dependencies.dependencies.push_back(down[i].GetUint64());
  }

  stdout_ = Get<std::string>(config, "stdout");
  stderr_ = Get<std::string>(config, "stderr");
  exit_code_ = Get<uint64_t>(config, "exit_code");
  monitor_count_ = Get<uint64_t>(config, "monitor_count");

  request_cancel_ = Get<bool>(config, "request_cancel");

  state_ = StateStringToEnum(Get<std::string>(config, "state"));

  end_processed_ = Get<bool>(config, "end_processed");

  bool hasTimePoints = false;
  if (config.HasMember("time_points_ms") && config["time_points_ms"].IsArray()) {
    rapidjson::Value const& array = config["time_points_ms"];
    if ((array.Size() == 2) && (array[0].IsUint64()) && (array[1].IsUint64())) {
      time_points_[0] = FromMillis(array[0].GetUint64());
      time_points_[1] = FromMillis(array[1].GetUint64());
      hasTimePoints = true;
    }
  }
  if (!hasTimePoints) {
    throw std::runtime_error("Step JSON missing time_points_ms array");
  }

  std::string executorName = GetOrDefault<std::string>(config, "executor", "");
  executor_ = nullptr;
  executor_data_ = nullptr;
  if (!executorName.empty()) {
    executor_ = executorsProvider->GetExecutor(executorName);
    if (executorName.compare(executor_->Name()) != 0) {
      throw std::runtime_error("Step JSON unable to find required executor: " + 
          executor_name_);
    }

    if (config.HasMember("executor_data")) {
      if (!config["executor_data"].IsObject()) {
        throw std::runtime_error("Step JSON executor_data must be an object");
      }
      executor_data_ = executor_->CreateLocalData(config["executor_data"]);
    }
  }

  //LOGE(__LINE__ << " Create step " << this << " " << uuid_ << " " << id_);
}

ns_Schedule::Step::~Step() {
  //LOGE(__LINE__ << " Delete step " << this << " " << uuid_ << " " << id_);
  if (executor_data_ != nullptr) {
    delete executor_data_;
  }
}

void ns_Schedule::Step::ReadFromTaskJSON(
    std::vector<rapidjson::Value const*> configurationStack, 
    rapidjson::Value const* configuration) {
  StepConfigurations::Configuration stepConfiguration;
  if (configuration->IsString()) {
    stepConfiguration = task_->configurations_.MakeWithOverrides(
        configuration->GetString(), configurationStack);
  } else if (configuration->IsObject()) {
    if ((configuration->HasMember("configuration")) && ((*configuration)["configuration"].IsString()) && 
        (configuration->HasMember("override")) && ((*configuration)["override"].IsObject())) {
      configurationStack.push_back(&((*configuration)["override"]));
      stepConfiguration = task_->configurations_.MakeWithOverrides(
          (*configuration)["configuration"].GetString(), configurationStack);
    } else {
      configurationStack.push_back(configuration);
      stepConfiguration = task_->configurations_.MakeWithOverrides("", configurationStack);
    }
  } else {
    throw std::runtime_error("step configuration not have expected format");
  }
 
  id_ = stepConfiguration.id_;
  executor_name_ = stepConfiguration.executor_name_;
  nb_cores_ = stepConfiguration.nb_cores_;
  nb_retry_ = stepConfiguration.nb_retry_;
  timeout_ = stepConfiguration.timeout_;
  args_= stepConfiguration.args_;
}

bool ns_Schedule::Step::TaskLastStep() {
  if (dependencies_.empty() || task_->request_cancel_) {
    for(ns_Schedule::Step* itStep = next_; itStep != this; itStep = itStep->next_) {
      if (!itStep->end_processed_) {
        return false;
      }
    }
    return true;
  }
  return false;
}

void ns_Schedule::Step::ToJSON(rapidjson::Value& out, 
    rapidjson::Document::AllocatorType& alloc, 
    bool exportTask) const {
  out.SetObject();

  if (exportTask) {
    rapidjson::Value taskJSON(rapidjson::kObjectType);
    task_->ToJSON(taskJSON, alloc, this);
    out.AddMember("task", taskJSON, alloc);
  } else {
    out.AddMember("task_id", task_->id_, alloc);
  }

  out.AddMember("name", rapidjson::Value(name_.c_str(), alloc), alloc);
  out.AddMember("id", rapidjson::Value(id_.c_str(), alloc), alloc);
  out.AddMember("uuid", uuid_, alloc);
  out.AddMember("step_id", step_id_, alloc);
  out.AddMember("rank_id", rank_id_, alloc);
  out.AddMember("attempt_id", attempt_id_, alloc);
  out.AddMember("run_id", run_id_, alloc);
  out.AddMember("executor_name", rapidjson::Value(executor_name_.c_str(), alloc), alloc);

  if (executor_ != nullptr) {
    out.AddMember("executor", rapidjson::Value(executor_->Name().c_str(), alloc), alloc);
    if (executor_data_ != nullptr) {
      rapidjson::Value executorDataJSON(rapidjson::kObjectType);
      executor_data_->ToJSON(executorDataJSON, alloc);
      out.AddMember("executor_data", executorDataJSON, alloc);
    }
  }

  out.AddMember("function", rapidjson::Value(function_.c_str(), alloc), alloc);

  rapidjson::Value argsObj(rapidjson::kObjectType);
  for (const auto& [ key, value ] : args_) {
    rapidjson::Value keyJSON(key.c_str(), alloc);
    rapidjson::Value valJSON(value.c_str(), alloc);
    argsObj.AddMember(keyJSON, valJSON, alloc);
  }
  out.AddMember(rapidjson::StringRef("args"), argsObj, alloc);

  out.AddMember("nb_cores", nb_cores_, alloc);
  out.AddMember("nb_retry", nb_retry_, alloc);
  out.AddMember("timeout", timeout_, alloc);

  rapidjson::Value stepDependencies(rapidjson::kObjectType);
  stepDependencies.AddMember("next", next_ != nullptr ? next_->uuid_ : 0, alloc);
  stepDependencies.AddMember("previous", previous_ != nullptr ? previous_->uuid_ : 0, alloc);
  rapidjson::Value stepDependenciesDown(rapidjson::kArrayType);
  for (Step const* step: dependencies_) {
    stepDependenciesDown.PushBack(step->uuid_, alloc);
  }
  stepDependencies.AddMember("down", stepDependenciesDown, alloc);
  rapidjson::Value stepDependenciesUp(rapidjson::kArrayType);
  for (Step const* step: depend_from_) {
    stepDependenciesUp.PushBack(step->uuid_, alloc);
  }
  stepDependencies.AddMember("up", stepDependenciesUp, alloc);
  out.AddMember("dependencies", stepDependencies, alloc);

  out.AddMember("stdout", rapidjson::Value(stdout_.c_str(), alloc), alloc);
  out.AddMember("stderr", rapidjson::Value(stderr_.c_str(), alloc), alloc);
  out.AddMember("exit_code", exit_code_, alloc);
  out.AddMember("monitor_count", monitor_count_, alloc);

  out.AddMember("request_cancel", request_cancel_, alloc);

  out.AddMember("state", rapidjson::Value(StateEnumToString(state_).c_str(), alloc), alloc);

  out.AddMember("end_processed", end_processed_, alloc);

  rapidjson::Value timepoints(rapidjson::kArrayType);
  timepoints.PushBack(ToMillis(time_points_[0]), alloc);
  timepoints.PushBack(ToMillis(time_points_[1]), alloc);
  out.AddMember("time_points_ms", timepoints, alloc);
}

inline uint64_t ns_Schedule::Step::ToMillis(
    std::chrono::time_point<std::chrono::system_clock> const& tp) {
  return static_cast<uint64_t>(
      std::chrono::duration_cast<std::chrono::milliseconds>(
      tp.time_since_epoch()).count());
}

inline std::chrono::system_clock::time_point ns_Schedule::Step::FromMillis(
    uint64_t millis) {
  return std::chrono::system_clock::time_point(
      std::chrono::milliseconds(millis));
}

std::string ns_Schedule::Step::StateEnumToString(ns_Schedule::Step::State state) {
  static std::unordered_map<ns_Schedule::Step::State, std::string> map {
      { State::Pending, "Pending" }, 
      { State::Running, "Running" }, 
      { State::Done, "Done" }, 
      { State::TimedOut, "TimedOut" }, 
      { State::Cancelled, "Cancelled" },
      { State::Shutdown, "Shutdown" }, 
      { State::LaunchError, "LaunchError" }, 
  };
  return map.at(state);
}

ns_Schedule::Step::State ns_Schedule::Step::StateStringToEnum(std::string const& state) {
  static std::unordered_map<std::string, ns_Schedule::Step::State> map {
      { "Pending", State::Pending }, 
      { "Running", State::Running }, 
      { "Done", State::Done }, 
      { "TimedOut", State::TimedOut }, 
      { "Cancelled", State::Cancelled },
      { "Shutdown", State::Shutdown }, 
      { "LaunchError", State::LaunchError }, 
  };
  return map.at(state);
}
