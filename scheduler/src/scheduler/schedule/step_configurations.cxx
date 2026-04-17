#include "step_configurations.hxx"
#include "../../utils/rapidjson.hxx"

void ns_Schedule::GroupStepConfigurations::ReadFromTaskJSON(rapidjson::Value const& entry) {
  if (!entry.IsObject()) {
    throw std::runtime_error("`configurations` must be an object");
  }
  nb_retry_[""] = GetOrDefault<uint32_t>(entry, "nb_retry", nb_retry_[""]);

  rapidjson::Value const emptyObject(rapidjson::kObjectType);
  rapidjson::Value::ConstObject customConfig = 
      GetOrDefault<rapidjson::Value::ConstObject>(entry, "custom", emptyObject.GetObject());
  for (auto const& config: customConfig) {
    nb_retry_[config.name.GetString()] = GetOrDefault<uint32_t>(config.value, "nb_retry", nb_retry_[""]);
  }
}

uint32_t ns_Schedule::GroupStepConfigurations::NbRetry(std::string const& configName) const {
  auto const& it = nb_retry_.find(configName);
  if (it != nb_retry_.end()) {
    return it->second;
  } else {
    return nb_retry_.at("");
  }
}

ns_Schedule::StepConfigurations::Configuration::Configuration() : 
    executor_name_(""), nb_cores_(1), nb_retry_(1), 
    timeout_(0), args_{} {
}

ns_Schedule::StepConfigurations::Configuration::Configuration(
    std::string id, std::string const& executor_name, uint32_t nb_cores, 
    uint32_t nb_retry, uint64_t memory_core, uint64_t memory_consumption, 
    uint64_t timeout, std::unordered_map<std::string, std::string> const& args) 
    : id_(id), executor_name_(executor_name), nb_cores_(nb_cores), 
    nb_retry_(nb_retry), memory_max_(memory_core+(memory_consumption*timeout)), 
    timeout_(timeout), args_(args), memory_core_(memory_core), 
    memory_consumption_(memory_consumption) {
}

ns_Schedule::StepConfigurations::StepConfigurations() :
    defaultConfiguration_(".", "", 1ul, 1ul, 0ull, 0ull, 0ull, {}) {

}

void ns_Schedule::StepConfigurations::ReadFromTaskJSON(rapidjson::Value const& entry) {
  configurations_.clear();

  if (!entry.IsObject()) {
    throw std::runtime_error("`configurations` must be an object");
  }

  rapidjson::Value emptyConfigurationJSON(rapidjson::kObjectType);
  configurations_.emplace("", defaultConfiguration_);

  for (auto it = entry.MemberBegin(); it != entry.MemberEnd(); ++it) {
    const std::string name(it->name.GetString(), it->name.GetStringLength());
    const rapidjson::Value& config = it->value;
    try {
      Configuration configuration = ReadEntryFromTaskJSON(name, config, defaultConfiguration_);
      configurations_.emplace(name, std::move(configuration));
    } catch (const std::exception& e) {
      throw std::runtime_error("invalid configuration for `" + name + "`: " + e.what());
    }
  }
}

ns_Schedule::StepConfigurations::Configuration  
ns_Schedule::StepConfigurations::MakeWithOverrides(std::string const& name,
    std::vector<rapidjson::Value const*> const& overrides) const {
  std::string id;
  std::string executor_name;
  uint32_t nb_cores = 1;
  uint32_t nb_retry = 1;
  uint64_t memory_core = 0;
  uint64_t memory_consumption = 0;
  uint64_t timeout = 0;
  std::unordered_map<std::string, std::string> args;
  auto configurationIT = configurations_.find(name);
  if (configurationIT != configurations_.end()) {
    ns_Schedule::StepConfigurations::Configuration const& base = configurationIT->second;

    id = base.id_;
    executor_name = base.executor_name_;
    nb_cores = base.nb_cores_;
    nb_retry = base.nb_retry_;
    memory_core = base.memory_core_;
    memory_consumption = base.memory_consumption_;
    timeout = base.timeout_;
    args = base.args_;
  }
  for (rapidjson::Value const* override : overrides) {
    if (!override || !override->IsObject()) {
      throw std::runtime_error("override_configurations entry must be an object");
    }
    id = GetOrDefault<std::string>(*override, "id", id);
    executor_name = GetOrDefault<std::string>(*override, "executor_name", executor_name);
    nb_cores = GetOrDefault<uint32_t>(*override, "nb_cores", nb_cores);
    nb_retry = GetOrDefault<uint32_t>(*override, "nb_retry", nb_retry);
    memory_core = GetOrDefault<uint64_t>(*override, "memory_core", memory_core);
    memory_consumption = GetOrDefault<uint64_t>(*override, "memory_consumption", memory_consumption);
    std::string timeoutStr = GetOrDefault<std::string>(
        *override, "timeout", std::to_string(timeout)+"s");
    timeout = ParseDurationToSeconds(timeoutStr);
    if (override->HasMember("args")) {
      rapidjson::Value const& argsJSON = (*override)["args"];
      if (!argsJSON.IsObject()) {
        throw std::runtime_error("`args` must be an object");
      }
      for (auto it = argsJSON.MemberBegin(); it != argsJSON.MemberEnd(); ++it) {
        std::string const key = it->name.GetString();
        if (!it->value.IsString()) {
          throw std::runtime_error("`args values` must be strings");
        }
        rapidjson::Value const& val = it->value;
        args[key] = val.GetString();
      }
    }
  }
  if (id.empty()) {
    id = name.empty() ? "." : name;
  }
  return ns_Schedule::StepConfigurations::Configuration
      (id, executor_name, nb_cores, nb_retry, memory_core, memory_consumption, timeout, args);
}


ns_Schedule::StepConfigurations::Configuration  
ns_Schedule::StepConfigurations::ReadEntryFromTaskJSON(std::string const& name, 
    rapidjson::Value const& entry, 
    Configuration& defaultConfiguration) {
  if (!entry.IsObject()) {
    throw std::runtime_error("step configuration require an object");
  }
  std::string configName = GetOrDefault<std::string>(entry, "id", name);
  std::string executor_name = GetOrDefault<std::string>(
      entry, "executor_name", defaultConfiguration.executor_name_);
  uint32_t nb_cores = GetOrDefault<uint32_t>(
      entry, "nb_cores", defaultConfiguration.nb_cores_);
  uint32_t nb_retry = GetOrDefault<uint32_t>(
      entry, "nb_retry", defaultConfiguration.nb_retry_); 
  std::string timeoutString = GetOrDefault<std::string>(
      entry, "timeout", std::to_string(defaultConfiguration.timeout_)+"s");
  uint64_t timeout = ParseDurationToSeconds(timeoutString);

  uint64_t memory_core = GetOrDefault<uint64_t>(
      entry, "memory_core", defaultConfiguration.memory_core_);
  uint64_t memory_consumption = GetOrDefault<uint64_t>(
      entry, "memory_consumption", defaultConfiguration.memory_consumption_);

  std::unordered_map<std::string, std::string> args;
  if (entry.HasMember("args")) {
    rapidjson::Value const& argsJSON = entry["args"];
    if (!argsJSON.IsObject()) {
      throw std::runtime_error("`args` must be an object");
    }
    for (auto it = argsJSON.MemberBegin(); it != argsJSON.MemberEnd(); ++it) {
      std::string const key = it->name.GetString();
      if (!it->value.IsString()) {
        throw std::runtime_error("`args values` must be strings");
      }
      rapidjson::Value const& val = it->value;
      args.emplace(key, val.GetString());
    }
  }

  return ns_Schedule::StepConfigurations::Configuration
      (configName, executor_name, nb_cores, nb_retry, memory_core, memory_consumption, 
      timeout, args);
}
