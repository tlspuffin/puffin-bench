#include "step.hxx"

static uint64_t parseTimeout(const std::string& str) {
    if (str.empty()) return 0;
    char unit = str.back();
    int value = std::stoi(str.substr(0, str.size() - 1));
    if (unit == 'm') return value * 60;
    if (unit == 's') return value;
    return value;
}

ns_Schedule::Step::Step(std::string const& name) 
    : name_(name), uuid_((uint64_t)this), task_id_(0), step_id_(0), 
      rank_id_(0), attempt_id_(0), run_path_(), function_(name), args_(), nb_cpu_(1), 
      nb_retry_(0), timeout_(0), next_(this), previous_(this), 
      dependencies_(), depend_from_(), state_(0), pid_(0), cpus_(), 
      stdout_(), stderr_(), exit_code_(256), monitor_count_(0)
{
}

void ns_Schedule::Step::CopyParameters(Step const& step) {
  task_id_ = step.task_id_;
  depend_from_ = step.depend_from_;
  run_path_ = step.run_path_;
  args_ = step.args_;
  nb_cpu_ = step.nb_cpu_;
  nb_retry_ = step.nb_retry_;
  timeout_ = step.timeout_;
}

void ns_Schedule::Step::ReadFromJSON(rapidjson::Value const& entry) {
  if (entry.HasMember("args") && entry["args"].IsString())
    args_ = entry["args"].GetString();
  if (entry.HasMember("nbcpu") && entry["nbcpu"].IsInt())
    nb_cpu_ = static_cast<uint32_t>(entry["nbcpu"].GetInt());
  if (entry.HasMember("retry") && entry["retry"].IsInt())
    nb_retry_ = static_cast<uint32_t>(entry["retry"].GetInt());
  if (entry.HasMember("maxtime") && entry["maxtime"].IsString())
    timeout_ = parseTimeout(entry["maxtime"].GetString());
}