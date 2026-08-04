#include "step.hxx"
#include "schedule.hxx"
#include "../../utils/rapidjson.hxx"
#include "../../utils/logs.hxx"

std::atomic<uint64_t> ns_Schedule::Step::next_uuid_ = 0;

// duplicate attempt Step
ns_Schedule::Step::Step(ns_Schedule::Step const& source, uint64_t run_id, 
    uint64_t attempt_id, std::list<ns_Schedule::Step*> dependFrom) 
    : task_(source.task_), name_(source.name_), id_(source.id_), uuid_(++next_uuid_),
    group_id_(source.group_id_), step_id_(source.step_id_), rank_id_(source.rank_id_), 
    attempt_id_(attempt_id), run_id_(run_id), executor_data_(nullptr), 
    function_(source.function_), args_(source.args_), nb_cores_(source.nb_cores_), 
    nb_retry_(source.nb_retry_), memory_max_(source.memory_max_), timeout_(source.timeout_), 
    next_(const_cast <ns_Schedule::Step *>(&source)), 
    previous_(const_cast <ns_Schedule::Step *>(&source)), 
    dependencies_(source.dependencies_), depend_from_(source.depend_from_), 
    stdout_(), stderr_(), exit_code_(exitCode_NotSet_), monitor_count_(0), 
    request_cancel_(false), monitor_(source.monitor_), monitor_path_(), 
    message_from_run_(""), state_(State::Pending), end_processed_(false),
    user_run_state_(""), group_status_(source.group_status_), readable_files_(source.readable_files_), 
    estimatedStartTime_(0)
{
  if ((group_status_ == stepsGroup_In_) || (group_status_ == stepsGroup_End_)) {
    depend_from_.clear();
    for(Step* step: dependFrom) {
      if ((step->rank_id_ == rank_id_) && (step->attempt_id_ == attempt_id_)) {
        depend_from_.push_back(step);
      }
    }
  }
  std::string step_name = ID();
  stdout_ = source.task_->logs_path_ / ("stdout." + step_name + ".txt");
  stderr_ = source.task_->logs_path_ / ("stderr." + step_name + ".txt");

  if (monitor_) {
    monitor_path_ = task_->monitors_path_ / (std::to_string(task_->id_) + "-" + ID() + ".txt");
  }

  //LOGE(__LINE__ << " Create step " << this << " " << uuid_ << " " << id_);
}

// duplicate rank Step
ns_Schedule::Step::Step(ns_Schedule::Step const& source, uint64_t run_id, 
    uint64_t rank_id, uint64_t attempt_id, uint64_t group_id, 
    std::list<ns_Schedule::Step*> dependFrom, 
    std::vector<rapidjson::Value const*> configurationStack, 
    GroupStepConfigurations const& groupConfigurations, 
    rapidjson::Value const* configuration) 
    : task_(source.task_), name_(source.name_), id_(source.id_), uuid_(++next_uuid_),
    group_id_(source.group_id_), step_id_(source.step_id_), rank_id_(rank_id), 
    attempt_id_(attempt_id), run_id_(run_id), executor_data_(nullptr), 
    function_(source.function_), args_(source.args_), nb_cores_(source.nb_cores_), 
    nb_retry_(source.nb_retry_), memory_max_(source.memory_max_), timeout_(source.timeout_), 
    next_(const_cast <ns_Schedule::Step *>(&source)), 
    previous_(const_cast <ns_Schedule::Step *>(&source)), 
    dependencies_(source.dependencies_), depend_from_(source.depend_from_), 
    stdout_(), stderr_(), exit_code_(exitCode_NotSet_), monitor_count_(0), 
    request_cancel_(false), monitor_(source.monitor_), monitor_path_(), message_from_run_(""), 
    state_(State::Pending), end_processed_(false), user_run_state_(""), 
    group_status_(source.group_status_), readable_files_(source.readable_files_), 
    estimatedStartTime_(0)
{
  if ((group_status_ == stepsGroup_In_) || (group_status_ == stepsGroup_End_)) {
    depend_from_.clear();
    for(Step* step: dependFrom) {
      if ((step->rank_id_ == rank_id_) && (step->attempt_id_ == attempt_id_)) {
        depend_from_.push_back(step);
      }
    }
  }
  ReadFromTaskJSON(configurationStack, groupConfigurations, configuration);

  std::string step_name = ID();
  stdout_ = source.task_->logs_path_ / ("stdout." + step_name + ".txt");
  stderr_ = source.task_->logs_path_ / ("stderr." + step_name + ".txt");

  if (monitor_) {
    monitor_path_ = task_->monitors_path_ / (std::to_string(task_->id_) + "-" + ID() + ".txt");
  }

  //LOGE(__LINE__ << " Create step " << this << " " << uuid_ << " " << id_);
}

// new Step
ns_Schedule::Step::Step(ns_Schedule::Task* task, std::string const& name, 
    uint64_t run_id, uint64_t step_id, uint64_t group_id, uint16_t group_status, 
    std::list<ns_Schedule::Step*> dependFrom, 
    GroupStepConfigurations const& groupConfigurations, 
    std::vector<rapidjson::Value const*> configurationStack, 
    rapidjson::Value const* configuration,
    rapidjson::Value const* monitorJSON, rapidjson::Value const* streamsConfigJSON[2]) 
    : task_(task), name_(name), id_(), uuid_(++next_uuid_), group_id_(group_id), 
    step_id_(step_id), rank_id_(0), attempt_id_(0), run_id_(run_id), 
    executor_data_(nullptr), 
    function_(name), args_(), nb_cores_(1), nb_retry_(0), memory_max_(0), 
    timeout_(0), next_(this), previous_(this), dependencies_(), 
    depend_from_(dependFrom), stdout_(), stderr_(), exit_code_(exitCode_NotSet_), 
    monitor_count_(0), request_cancel_(false), monitor_(), monitor_path_(), 
    message_from_run_(""), state_(State::Pending), end_processed_(false), 
    user_run_state_(""), group_status_(group_status), 
    readable_files_(MergeStreamsConfig(streamsConfigJSON)), estimatedStartTime_(0)
{
  if ((group_status_ == stepsGroup_In_) || (group_status_ == stepsGroup_End_)) {
    depend_from_.clear();
    for(Step* step: dependFrom) {
      if ((step->rank_id_ == rank_id_) && (step->attempt_id_ == attempt_id_)) {
        depend_from_.push_back(step);
      }
    }
  }
  ReadFromTaskJSON(configurationStack, groupConfigurations, configuration);

  std::string step_name = ID();
  stdout_ = task_->logs_path_ / ("stdout." + step_name + ".txt");
  stderr_ = task_->logs_path_ / ("stderr." + step_name + ".txt");

  std::shared_ptr<ns_Monitor::Task> monitor;
  if (monitorJSON != nullptr) {
    monitor_ = std::make_shared<ns_Monitor::Task>(this, *monitorJSON);
    monitor_path_ = task_->monitors_path_ / (std::to_string(task_->id_) + "-" + ID() + ".txt");
  }

  //LOGE(__LINE__ << " Create step " << this << " " << uuid_ << " " << id_);
}

ns_Schedule::Step::Step(ns_Schedule::Task* task, 
    rapidjson::Value const& config, 
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
  group_id_ = Get<uint64_t>(config, "group_id");
  step_id_ = Get<uint64_t>(config, "step_id");
  rank_id_ = Get<uint64_t>(config, "rank_id");
  attempt_id_ = Get<uint64_t>(config, "attempt_id");
  run_id_ = Get<uint64_t>(config, "run_id");

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
  memory_max_ = Get<uint64_t>(config, "memory_max");
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

  user_run_state_ = Get<std::string>(config, "user_run_state");

  group_status_ = Get<uint16_t>(config, "group_status");

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

  if (config.HasMember("monitor") && config["monitor"].IsObject()) {
    monitor_ = std::make_shared<ns_Monitor::Task>(this, config["monitor"]);
    monitor_path_ = GetPath(config, "monitor_path");
    message_from_run_ = Get<std::string>(config, "message_from_run");
  }

  executor_data_ = nullptr;
  if (task_->executor_ != nullptr) {
    if (config.HasMember("executor_data")) {
      if (!config["executor_data"].IsObject()) {
        throw std::runtime_error("Step JSON executor_data must be an object");
      }
      executor_data_ = task_->executor_->CreateLocalData(config["executor_data"]);
    }
  }

  if (config.HasMember("streams") && config["streams"].IsArray()) {
    for (auto const& entry : config["streams"].GetArray()) {
      if (!entry.IsObject()) {
        continue;
      }
      if ((!entry.HasMember("name") || !entry["name"].IsString()) || 
          (!entry.HasMember("path") || !entry["path"].IsString())) {
            continue;
      }
      std::string name = entry["name"].GetString();
      readable_files_.push_back({ name, entry["path"].GetString() });
    }
  }

  estimatedStartTime_ = Get<uint64_t>(config, "estimated_start_time");
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
    GroupStepConfigurations const& groupConfigurations, 
    rapidjson::Value const* configuration) {
  StepConfigurations::Configuration stepConfiguration;
  std::string configName;
  if (configuration->IsString()) {
    configName = configuration->GetString();
    stepConfiguration = task_->configurations_.MakeWithOverrides(
        configName, configurationStack);
  } else if (configuration->IsObject()) {
    if ((configuration->HasMember("configuration")) && ((*configuration)["configuration"].IsString()) && 
        (configuration->HasMember("override")) && ((*configuration)["override"].IsObject())) {
      configName = (*configuration)["configuration"].GetString();
      configurationStack.push_back(&((*configuration)["override"]));
      stepConfiguration = task_->configurations_.MakeWithOverrides(
          configName, configurationStack);
    } else {
      configurationStack.push_back(configuration);
      stepConfiguration = task_->configurations_.MakeWithOverrides("", configurationStack);
    }
  } else {
    throw std::runtime_error("step configuration not have expected format");
  }
 
  id_ = stepConfiguration.id_;
  nb_cores_ = stepConfiguration.nb_cores_;
  nb_retry_ = stepConfiguration.nb_retry_;
  memory_max_ = stepConfiguration.memory_max_;
  timeout_ = stepConfiguration.timeout_;
  args_= stepConfiguration.args_;

  if (group_status_ != stepsGroup_None_) {
    nb_retry_ = groupConfigurations.NbRetry(configName);
  }
}

bool ns_Schedule::Step::TaskFirstStep() {
  bool inRootSteps = false;
  bool allPending = true;
  for(Step const* step: task_->root_steps_) {
    allPending &= step->IsPending();
    if (step == this) {
      inRootSteps = true;
    }
  }
  return inRootSteps && allPending;
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
  out.AddMember("group_id", group_id_, alloc);
  out.AddMember("step_id", step_id_, alloc);
  out.AddMember("rank_id", rank_id_, alloc);
  out.AddMember("attempt_id", attempt_id_, alloc);
  out.AddMember("run_id", run_id_, alloc);

  if (executor_data_ != nullptr) {
    rapidjson::Value executorDataJSON(rapidjson::kObjectType);
    executor_data_->ToJSON(executorDataJSON, alloc);
    out.AddMember("executor_data", executorDataJSON, alloc);
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
  out.AddMember("memory_max", memory_max_, alloc);
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

  out.AddMember("user_run_state", rapidjson::Value(user_run_state_.c_str(), alloc), alloc);

  out.AddMember("group_status", group_status_, alloc);

  rapidjson::Value timepoints(rapidjson::kArrayType);
  timepoints.PushBack(ToMillis(time_points_[0]), alloc);
  timepoints.PushBack(ToMillis(time_points_[1]), alloc);
  out.AddMember("time_points_ms", timepoints, alloc);

  if (monitor_) {
    rapidjson::Value monitor(rapidjson::kObjectType);
    monitor_->ToJSON(monitor, alloc);
    out.AddMember("monitor", monitor, alloc);
    out.AddMember("monitor_path", rapidjson::Value(monitor_path_.c_str(), alloc), alloc);
    out.AddMember("message_from_run", rapidjson::Value(message_from_run_.c_str(), alloc), alloc);
  }

  rapidjson::Value streamsArray(rapidjson::kArrayType);
  for (auto const& stream : readable_files_) {
    rapidjson::Value entry(rapidjson::kObjectType);
    entry.AddMember("name", rapidjson::Value(stream.name.c_str(), alloc), alloc);
    entry.AddMember("path", rapidjson::Value(stream.path.c_str(), alloc), alloc);
    streamsArray.PushBack(entry, alloc);
  }
  out.AddMember("streams", streamsArray, alloc);

  out.AddMember("estimated_start_time", estimatedStartTime_, alloc);
}

void ns_Schedule::Step::UpdateStats() {
  task_->executor_->UpdateStepStats(this->executor_data_);
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

std::vector<ns_Schedule::Step::Stream> ns_Schedule::Step::MergeStreamsConfig(
      rapidjson::Value const* streamsConfigJSON[2]) {
  std::vector<Stream> result;
  std::unordered_map<std::string, Stream> streams;
  for(size_t i=0; i<2; ++i) {
    auto const config = streamsConfigJSON[i];
    if (config == nullptr) {
      continue;
    }
    for (auto const& entry : config->GetArray()) {
      if (!entry.IsObject()) {
        continue;
      }
      if ((!entry.HasMember("name") || !entry["name"].IsString()) || 
          (!entry.HasMember("path") || !entry["path"].IsString())) {
        continue;
      }
      std::string name = entry["name"].GetString();
      std::string path = entry["path"].GetString();

      if (path.empty()) {
        if (streams.erase(name) != 1) {
          LOGW << "Warning, removing an unexisting stream " << name << Log::Flags::End;
        }
      } else {
        streams[name] = Stream{name, path};
      }
    }
  }
  for(auto const& [_, stream]: streams) {
    result.push_back(stream);
  }
  return result;
}
