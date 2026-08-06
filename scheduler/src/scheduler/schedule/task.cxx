#include "task.hxx"
#include "step.hxx"
#include "schedule.hxx"
#include "executor/executor.hxx"
#include "../../utils/logs.hxx"
#include "../../utils/rapidjson.hxx"
#include "../../utils/variables.hxx"
#include "../../utils/dir.hxx"
#include <unordered_set>
#include <fstream>
#include <regex>
#include <rapidjson/ostreamwrapper.h>
#include <rapidjson/prettywriter.h>

ns_Schedule::Task::Task(uint64_t id, std::string const& name, 
    rapidjson::Value const& configJSON, 
    std::filesystem::path const& inDataPath, 
    std::filesystem::path const& functionsFile, 
    std::filesystem::path const& toolsFolders, 
    std::filesystem::path const& runRootPath, 
    std::filesystem::path const& monitorsRootPath,
    std::unordered_map<std::string, PublisherConfig> const& publishersConfig, 
    std::unordered_map<std::string, std::string>& args, 
    std::string const& user, std::string const& jobType, 
    std::map<std::string, std::string> md5, std::string apiURL,
    ns_Executor::ExecutorsProvider const& executorsProvider)
    : id_(id), name_(name), files_path_(inDataPath), 
    functions_path_(functionsFile),
    tools_path_(toolsFolders), 
    run_root_path_(runRootPath / std::to_string(id)), 
    logs_path_(run_root_path_ / "logs"), 
    env_path_(run_root_path_ / ".taskenv"), 
    outputs_path_(run_root_path_ / "output"),
    artefacts_path_(run_root_path_ / "artefacts"),
    monitors_path_(monitorsRootPath),
    args_(args), configurations_(), executor_data_(nullptr), 
    root_steps_(), steps_file_(), user_(user), job_type_(jobType), 
    request_cancel_(false), cancel_source_(), publish_(), 
    md5_(std::move(md5)), state_(Task::State::Pending), publish_link_(), 
    flag_(), apiURL_(apiURL), priority_(0)
{
  if (name_.empty()) {
    name_ = GetOrDefault<std::string>(configJSON, "name", "");
  }

  static rapidjson::Value const emptyObject(rapidjson::kObjectType);
  rapidjson::Value const& extraArgs = GetOrDefault<rapidjson::Value const&>(configJSON, "args", emptyObject);
  for(auto it = extraArgs.MemberBegin(); it != extraArgs.MemberEnd(); ++it) {
    if ((!it->name.IsString()) || (!it->value.IsString())) {
      continue;
    }
    args_.emplace(it->name.GetString(), it->value.GetString());
  }

  std::unordered_map<std::string, std::string> variables;
  for (const auto& [key, value] : args_) {
    variables.emplace(key, value);
  }
  variables.emplace("task_id", std::to_string(id_));
  name_ = ResolveVariables(name_, variables);
  name_.erase(std::remove_if(name_.begin(), name_.end(), [](char c) {
    return !std::isalnum(c) && c != '@' && c != '-' && c != '_' && c != '.' && c != ' ';
  }), name_.end());

  executor_name_ = GetOrDefault<std::string>(
      configJSON, "executor_name", "default");
  executor_ = executorsProvider.GetExecutor(executor_name_);
  if (executor_ == nullptr) {
    throw std::runtime_error("Task error, unable to find executor " + executor_name_);
  }

  rapidjson::Value const* publisherConfiguration = nullptr;
  if (configJSON.HasMember("publish")) {
    if (!configJSON["publish"].IsObject()) {
      throw std::runtime_error("Invalid 'publish' in JSON");
    }
    publisherConfiguration = &configJSON["publish"];
  }
  rapidjson::Value const* configurations = nullptr;
  if (configJSON.HasMember("configurations") && 
      (configJSON["configurations"].IsObject())) {
    configurations = &configJSON["configurations"];
  }

  if (publisherConfiguration != nullptr) {
    publish_.ReadJSON(publishersConfig, *publisherConfiguration);
  }
  if (configurations != nullptr) {
    configurations_.ReadFromTaskJSON(*configurations);
  }

  priority_ = GetOrDefault<int64_t>(configJSON, "priority", priority_);

  CreateStepsFromJson(configJSON);
}

ns_Schedule::Task::Task(rapidjson::Value const& config, 
    std::unordered_map<std::string, PublisherConfig> const& publishersConfig, 
    ns_Executor::ExecutorsProvider const& executorsProvider, 
    std::list<ns_Schedule::Step*>& stepsPending, 
    std::list<ns_Schedule::Step*>& stepsRunning, 
    std::list<ns_Schedule::Step*>& stepsDone) 
    : executor_data_(nullptr) {
  if (!config.IsObject()) {
    throw std::runtime_error("Task JSON must be an object");
  }

  id_ = Get<uint64_t>(config, "id");
  name_ = Get<std::string>(config, "name");
  files_path_ = GetPath(config, "files_path");
  functions_path_ = GetPath(config, "functions_path");
  tools_path_ = GetPath(config, "tools_path");
  run_root_path_ = GetPath(config, "run_root_path");
  logs_path_ = GetPath(config, "logs_path");
  env_path_ = GetPath(config, "env_path");
  outputs_path_ = GetPath(config, "outputs_path");
  artefacts_path_ = GetPath(config, "artefacts_path");
  monitors_path_ = GetPath(config, "monitors_path");
  executor_name_ = Get<std::string>(config, "executor_name");
  executor_ = executorsProvider.GetExecutor(executor_name_);
  if (executor_ == nullptr) {
    throw std::runtime_error("Task error, unable to find executor " + executor_name_);
  }
  if (config.HasMember("executor_data") && config["executor_data"].IsObject()) {
    executor_data_ = executor_->CreateLocalTaskData(config["executor_data"]);
  }

  if ((config.HasMember("args")) && (config["args"].IsArray())) {
    rapidjson::Value const& argsArray = config["args"];
    for (rapidjson::SizeType i = 0; i < argsArray.Size(); i++) {
      rapidjson::Value const& argObject = argsArray[i];
      if (!argObject.IsObject()) {
        LOGE << "Warning: Invalid arg object at index " << i << Log::Flags::End;
        continue;
      }
      try {
        std::string key = Get<std::string>(argObject, "key");
        std::string value = Get<std::string>(argObject, "value");
        if (!key.empty()) {
          args_[key] = value;
        }
      } catch (const std::exception& e) {
        LOGE << "Warning: Failed to parse arg at index " << i 
            << ": " << e.what() << Log::Flags::End;
      }
    }
  }

  std::list<ns_Schedule::Step*> loadedSteps;
  std::unordered_map<uint64_t, ns_Schedule::Step*> loadedStepsIndex;
  std::unordered_map<uint64_t, ns_Schedule::Step::UUIDDependencies> loadedStepsDeps;
  if (config.HasMember("steps") && config["steps"].IsObject()) {
    rapidjson::Value const& stepsObject = config["steps"];
    for (auto stepIt = stepsObject.MemberBegin(); 
        stepIt != stepsObject.MemberEnd(); ++stepIt) {
      uint64_t stepUUID = std::stoull(stepIt->name.GetString());
      const rapidjson::Value& stepConfig = stepIt->value;
      ns_Schedule::Step::UUIDDependencies& dependencies = loadedStepsDeps[stepUUID];
      ns_Schedule::Step* step = new Step(this, stepConfig, dependencies);
      loadedSteps.push_back(step);
      loadedStepsIndex.emplace(stepUUID, step);
    }
  }
  for (ns_Schedule::Step* step: loadedSteps) {
    uint64_t uuid = step->uuid_;
    step->next_ = loadedStepsIndex[loadedStepsDeps[uuid].next];
    step->previous_ = loadedStepsIndex[loadedStepsDeps[uuid].previous];
    for(auto& stepUUID: loadedStepsDeps[uuid].depend_from) {
      step->depend_from_.push_back(loadedStepsIndex[stepUUID]);
    }
    for(auto& stepUUID: loadedStepsDeps[uuid].dependencies) {
      step->dependencies_.push_back(loadedStepsIndex[stepUUID]);
    }
    if (step->IsRunning()) {
      executor_->CheckReloadRunning(*step);
      if (step->IsRunning()) {
        stepsRunning.push_back(step);
        stepsPending.push_back(step);
      } else if (step->IsDone()) {
        stepsDone.push_back(step);
        stepsPending.push_back(step);
      }
    }
    if (step->IsReady()) {
      stepsPending.push_back(step);
    }
  }

  if (config.HasMember("root_steps") && config["root_steps"].IsArray()) {
    const rapidjson::Value& rootStepsArray = config["root_steps"];
    for (rapidjson::SizeType i = 0; i < rootStepsArray.Size(); i++) {
      if (!rootStepsArray[i].IsUint64()) {
        LOGW << "Warning: Invalid root_step UUID at index " << i << Log::Flags::End;
        continue;
      }
      uint64_t stepUUID = rootStepsArray[i].GetUint64();
      root_steps_.push_back(loadedStepsIndex[stepUUID]);
    }
  }

  if (root_steps_.empty()) {
    throw std::runtime_error("Task must have at least one root step");
  }

  std::filesystem::path stepsFile = logs_path_ / ".steps.json";
  steps_file_.open(stepsFile, std::ios::app);
  if (!steps_file_.is_open()) {
    throw std::runtime_error("Unable to create file " + 
        stepsFile.string());
  }

  user_ = GetOrDefault<std::string>(config, "user", "anonymous");
  job_type_ = GetOrDefault<std::string>(config, "job_type", "unknown");

  request_cancel_ = Get<bool>(config, "request_cancel");
  cancel_source_ = Get<std::string>(config, "cancel_source");

  if (config.HasMember("publish")) {
    publish_.ReadJSON(publishersConfig, config["publish"]);
  }

  rapidjson::Value::ConstObject md5Object = Get<rapidjson::Value::ConstObject>(config, "md5");
  for(auto const& md5: md5Object) {
    if ((!md5.name.IsString()) || (!md5.value.IsString())) {
      throw std::runtime_error("Task have malformated md5 informations");
    }
    md5_[md5.name.GetString()] = md5.value.GetString();
  }

  state_ = StateStringToEnum(Get<std::string>(config, "state"));
  publish_link_ = Get<std::string>(config, "publish_link");
  flag_ = ParseJSONObject(config, "flag", false);

  apiURL_ = Get<std::string>(config, "api_url");

  priority_ = Get<int64_t>(config, "priority");
}

ns_Schedule::Task::~Task() {
  if (steps_file_.is_open()) {
    steps_file_.close();
  }
  if (executor_data_ != nullptr) {
    delete executor_data_;
  }
}

void ns_Schedule::Task::Cancel(std::string const& source) {
  if (!request_cancel_) {
    cancel_source_ = source;
  }
  state_ = Task::State::Cancelled;
  request_cancel_ = true;
  LOGI << "Cancel task " << id_ << " 1st source:" << cancel_source_ << Log::Flags::End;
}

bool ns_Schedule::Task::PrepareToRun() {
  executor_->TaskPrepareToRun(this);

  CreateRunFolders();

  SaveGlobalParameters(args_, env_path_);

  std::filesystem::path stepsFile = logs_path_ / ".steps.json";
  steps_file_.open(stepsFile);
  if (!steps_file_.is_open()) {
    throw std::runtime_error("Unable to create file " + 
        stepsFile.string());
  }

  state_ = Task::State::Running;

  return true;
}

struct ns_Schedule::ArchiveJob ns_Schedule::Task::FinalizeAndArchive(
    std::filesystem::path const& savePath) {
  if (steps_file_.is_open()) {
    steps_file_.close();
  }

  std::string id = std::to_string(id_);
  std::filesystem::path finalSavePath = savePath / id;

  std::filesystem::path taskJSONfile = savePath / (id+".json");
  try {
    if (!std::filesystem::create_directory(finalSavePath)) {
      throw std::runtime_error("Unable to create save directory (" + finalSavePath.string() + ")");
    }

    if (state_ == Task::State::Running) {
      state_ = Task::State::Done;
    }

    rapidjson::Document doc;
    doc.SetObject();
    rapidjson::MemoryPoolAllocator<>& alloc = doc.GetAllocator();
    rapidjson::Value taskJSON(rapidjson::kObjectType);
    ToJSON(taskJSON, alloc, nullptr);
    doc.AddMember("task", taskJSON, alloc);
    std::ofstream ofs(taskJSONfile);
    if (ofs.is_open()) {
      rapidjson::OStreamWrapper osw(ofs);
      rapidjson::PrettyWriter<rapidjson::OStreamWrapper> writer(osw);
      doc.Accept(writer);
      ofs.close();
    } else {
      LOGE << "Error while saving task informations in save storage: " << taskJSONfile << Log::Flags::End;
    }

    std::filesystem::rename(artefacts_path_, finalSavePath / "artefacts");
    //std::filesystem::rename(outputs_path_, finalSavePath / "output");
    std::filesystem::rename(logs_path_, finalSavePath / "logs");
  } catch(std::runtime_error const& e) {
    LOGE << "Error while moving resultats from running to save storage\n" <<
        "All keep in " << run_root_path_ << "\n\t" << e.what() << Log::Flags::End;
    return ArchiveJob();
  } catch(...) {
    LOGE << "Unknown Error while moving resultats from running to save storage\n" <<
        "All keep in " << run_root_path_ << Log::Flags::End;
    return ArchiveJob();
  }

  std::unordered_map<std::string, std::string> variables = LoadGlobalParameters(env_path_);
  for (const auto& [key, value] : args_) {
    variables.emplace(key, value);
  }
  variables.emplace("TASK_ID", id);
  variables.emplace("TASK_USER", user_);
  variables.emplace("TASK_JOB_TYPE", job_type_);

  publish_link_ = publish_.ViewLink(variables);

  executor_->TaskFinalize(this, executor_data_);

  for(std::filesystem::path const& path: 
      { run_root_path_, functions_path_, files_path_ }) {
    std::error_code ec;
    if (std::filesystem::remove_all(path, ec) == -1) {
      LOGE << "Error while removing " << path << "\n" << 
          "\t" << ec.value() << ": " << ec.message() << Log::Flags::End;
    }
  }

  std::filesystem::path pathID = id;
  return ArchiveJob(publish_, variables, finalSavePath.string() + ".zip", 
      { taskJSONfile, finalSavePath / "artefacts", finalSavePath / "logs" }, 
      finalSavePath, finalSavePath);
}

void ns_Schedule::Task::ToJSON(rapidjson::Value& out, 
    rapidjson::Document::AllocatorType& alloc, 
    ns_Schedule::Step const* step) const {
  out.AddMember("id", id_, alloc);
  out.AddMember("name", rapidjson::Value(name_.c_str(), alloc), alloc);
  out.AddMember("files_path", rapidjson::Value(files_path_.c_str(), alloc), alloc);
  out.AddMember("functions_path", rapidjson::Value(functions_path_.c_str(), alloc), alloc);
  out.AddMember("tools_path", rapidjson::Value(tools_path_.c_str(), alloc), alloc);
  out.AddMember("run_root_path", rapidjson::Value(run_root_path_.c_str(), alloc), alloc);

  out.AddMember("logs_path", rapidjson::Value(logs_path_.c_str(), alloc), alloc);
  out.AddMember("env_path", rapidjson::Value(env_path_.c_str(), alloc), alloc);
  out.AddMember("outputs_path", rapidjson::Value(outputs_path_.c_str(), alloc), alloc);
  out.AddMember("artefacts_path", rapidjson::Value(artefacts_path_.c_str(), alloc), alloc);

  out.AddMember("monitors_path", rapidjson::Value(monitors_path_.c_str(), alloc), alloc);

  out.AddMember("user", rapidjson::Value(user_.c_str(), alloc), alloc);
  out.AddMember("job_type", rapidjson::Value(job_type_.c_str(), alloc), alloc);

  out.AddMember("request_cancel", request_cancel_, alloc);
  out.AddMember("cancel_source", rapidjson::Value(cancel_source_.c_str(), alloc), alloc);

  out.AddMember("executor_name", rapidjson::Value(executor_name_.c_str(), alloc), alloc);
  if (executor_data_ != nullptr) {
    rapidjson::Value executorDataJSON(rapidjson::kObjectType);
    executor_data_->ToJSON(executorDataJSON, alloc);
    out.AddMember("executor_data", executorDataJSON, alloc);
  }

  std::unordered_set<ns_Schedule::Step*> uniqueSteps;
  for (ns_Schedule::Step* const step : root_steps_) {
    uniqueSteps.insert(step);
  }
  rapidjson::Value rootStepsArray(rapidjson::kArrayType);
  for (ns_Schedule::Step* const step: uniqueSteps) {
    rootStepsArray.PushBack(step->uuid_, alloc);
  }
  out.AddMember("root_steps", rootStepsArray, alloc);

  if (step == nullptr) {
    rapidjson::Value stepsObject(rapidjson::kObjectType);
    while (uniqueSteps.size() > 0) {
      std::unordered_set<ns_Schedule::Step*> uniqueDependenciesSteps;
      for (ns_Schedule::Step* const step: uniqueSteps) {
        for(ns_Schedule::Step* dependency: step->dependencies_) {
          uniqueDependenciesSteps.insert(dependency);
        }
        rapidjson::Value stepObject(rapidjson::kObjectType);
        step->ToJSON(stepObject, alloc, false);
        stepsObject.AddMember(
            rapidjson::Value(std::to_string(step->uuid_).c_str(), alloc), stepObject, alloc);
      }
      uniqueSteps.swap(uniqueDependenciesSteps);
    }
    out.AddMember("steps", stepsObject, alloc);
  }

  rapidjson::Value argsArray(rapidjson::kArrayType);
  for (const auto& pair : args_) {
    rapidjson::Value argObject(rapidjson::kObjectType);
    argObject.AddMember("key", 
        rapidjson::Value(pair.first.c_str(), alloc), alloc);
    argObject.AddMember("value", 
        rapidjson::Value(pair.second.c_str(), alloc), alloc);
    argsArray.PushBack(argObject, alloc);
  }
  out.AddMember("args", argsArray, alloc);

  rapidjson::Value publishObject(rapidjson::kObjectType);
  publish_.ToJSON(publishObject, alloc);
  out.AddMember("publish", publishObject, alloc);

  rapidjson::Value md5Object(rapidjson::kObjectType);
  for (auto const& [file, md5]: md5_) {
    md5Object.AddMember(
        rapidjson::Value(file.c_str(), alloc), rapidjson::Value(md5.c_str(), alloc), alloc);
  }
  out.AddMember("md5", md5Object, alloc);

  out.AddMember("state", rapidjson::Value(StateEnumToString(state_).c_str(), alloc), alloc);
  out.AddMember("publish_link", rapidjson::Value(publish_link_.c_str(), alloc), alloc);
  out.AddMember("flag", rapidjson::Value(FlagJSON(), alloc), alloc);

  out.AddMember("api_url", rapidjson::Value(apiURL_.c_str(), alloc), alloc);

  out.AddMember("priority", priority_, alloc);
}

bool ns_Schedule::Task::CreateRunFolders() {
  std::error_code ec;
  for(std::filesystem::path path : { 
      run_root_path_, logs_path_, 
      outputs_path_, artefacts_path_
  }) {
    if (!std::filesystem::create_directories(path, ec)) {
      throw std::runtime_error(
          "create dir " + path.string() + std::string(" failed: errno=") + 
          std::to_string(ec.value()) + " (" + ec.message() + ")"
      );
    }
  }
  return true;
}

struct ns_Schedule::SRessourcesSummary ns_Schedule::Task::UpdateStats(std::vector<ns_Schedule::Step*> steps) {
  std::chrono::milliseconds running_time = std::chrono::milliseconds(1);
  std::chrono::time_point<std::chrono::system_clock> now = 
      std::chrono::time_point<std::chrono::system_clock>::clock::now();
  std::vector<ns_Executor::ExecutorData*> stepsExecutorData;
  stepsExecutorData.reserve(steps.size());
  for(ns_Schedule::Step const* step: steps) {
    if (step->IsRunning()) {
      stepsExecutorData.push_back(step->executor_data_);
      running_time += std::chrono::duration_cast<std::chrono::milliseconds>(now - step->StartTime());
    } else {
      running_time += step->RunTime();
    }
  }
  std::pair<int8_t, int8_t> ressourcesUsage = executor_->UpdateTaskStats(executor_data_, stepsExecutorData);
  return { ressourcesUsage.first, ressourcesUsage.second, this, running_time };
}

void ns_Schedule::Task::CreateStepsFromJson(
    rapidjson::Value const& configJSON) {
  std::list<ns_Schedule::Step*> parent_stack;
  std::list<ns_Schedule::Step*> current_stack;
  bool is_root_steps = true;

  if (!configJSON.HasMember("flow") || !configJSON["flow"].IsArray()) {
    throw std::runtime_error("Invalid or missing 'flow' in JSON");
  }

  std::vector<rapidjson::Value const*> configurationsList;
  if (configJSON.HasMember("configurations") && 
      (configJSON["configurations"].IsObject())) {
    rapidjson::Value const* configurations = &configJSON["configurations"];
    for(auto member = configurations->MemberBegin(); member != configurations->MemberEnd(); ++member) {
      configurationsList.push_back(&(member->name));
    }
  }

  rapidjson::Value runEmptyConfiguration(rapidjson::kObjectType);

  uint64_t step_id = 0;

  rapidjson::Value const& flow = configJSON["flow"];

  for (rapidjson::SizeType i = 0; i < flow.Size(); ++i) {
    uint64_t run_id = 0;
    rapidjson::Value const& flowElement = flow[i];

    std::vector<rapidjson::Value const*> runList;

    rapidjson::Value const* streamsConfigJSON[2] = {nullptr, nullptr};

    GroupStepConfigurations groupConfigurations;
    rapidjson::Value const* groupConfigurationJSON = nullptr;
    std::queue<rapidjson::Value const*> flowElements;
    if (flowElement.IsObject()) {
      flowElements.push(&flowElement);
    } else if (flowElement.IsArray()) {
      for(auto const& element: flowElement.GetArray()) {
        if (!element.IsObject()) {
          continue;
        }
        if (!element.HasMember("step")) {
          if (element.HasMember("configuration") && element["configuration"].IsObject()) {
            groupConfigurations.ReadFromTaskJSON(element["configuration"]);
            groupConfigurationJSON = &element["configuration"];
          }
          if (element.HasMember("streams") && element["streams"].IsArray()) {
            streamsConfigJSON[0] = &element["streams"];
          }
          if (element.HasMember("run") && element["run"].IsArray()) {
            rapidjson::Value const& run_array = element["run"];
            if (run_array.Size() != 0) {
              for (rapidjson::SizeType j = 0; j < run_array.Size(); ++j) {
                runList.push_back(&(run_array[j]));
              }
            } else {
              if (configurationsList.empty()) {
                throw std::runtime_error("empty run array requiere a global configuration object");
              }
              runList = configurationsList;
            }
          }
        } else if (element.HasMember("step")) {
          flowElements.push(&element);
        }
      }
    } else {
      continue;
    }

    uint64_t group_id = flowElements.size() == 1 ? 0 : (step_id + 1);
    bool stepsGroupStart = group_id != 0;
    do {
      rapidjson::Value const& stepJSON = *(flowElements.front());
      flowElements.pop();

      if (!stepJSON.HasMember("step") || !stepJSON["step"].IsString()) {
        continue;
      }

      uint16_t stepsGroupStatus = Step::stepsGroup_None_;
      if (group_id != 0) {
        if (stepsGroupStart) {
          stepsGroupStatus = Step::stepsGroup_Begin_;
        } else if (flowElements.empty()) {
          stepsGroupStatus = Step::stepsGroup_End_;
        } else {
          stepsGroupStatus = Step::stepsGroup_In_;
        }
      }

      current_stack.clear();

      std::string const& step_name = stepJSON["step"].GetString();

      rapidjson::Value const* monitorJSON = nullptr;
      if (stepJSON.HasMember("monitor") && (stepJSON["monitor"].IsObject())) {
        monitorJSON = &(stepJSON["monitor"]);
      }

      streamsConfigJSON[1] = nullptr;
      if (stepJSON.HasMember("streams") && stepJSON["streams"].IsArray()) {
        streamsConfigJSON[1] = &stepJSON["streams"];
      }

      std::vector<rapidjson::Value const*> configurationsStack;
      if (groupConfigurationJSON != nullptr) {
        configurationsStack.push_back(groupConfigurationJSON);
      }
      if (stepJSON.HasMember("configuration")) {
        configurationsStack.push_back(&stepJSON["configuration"]);
      }

      rapidjson::Value const* runConfiguration = &runEmptyConfiguration;
      ns_Schedule::Step* step = new ns_Schedule::Step(this, step_name, 
          run_id++, step_id, group_id, stepsGroupStatus, parent_stack, 
          groupConfigurations, configurationsStack, runConfiguration, 
          monitorJSON, streamsConfigJSON);
      configurationsStack.push_back(runConfiguration);

      ns_Schedule::Step* first_step = step;
      if (stepJSON.HasMember("run") && stepJSON["run"].IsArray()) {
        if (stepsGroupStatus != Step::stepsGroup_None_) {
          throw std::runtime_error("step inside a group can not have a run field");
        }
        rapidjson::Value const& run_array = stepJSON["run"];
        if (run_array.Size() != 0) {
          for (rapidjson::SizeType j = 0; j < run_array.Size(); ++j) {
            runList.push_back(&(run_array[j]));
          }
        } else {
          if (configurationsList.empty()) {
            throw std::runtime_error("empty run array requiere a global configuration object");
          }
          runList = configurationsList;
        }
      }
      if (!runList.empty()) {
        for(size_t j=0; j<runList.size(); ++j) {
          rapidjson::Value const& run = *(runList[j]);
          if (j != 0) {
            step->next_ = new ns_Schedule::Step(*step, run_id++, j, 0, group_id, 
                parent_stack, configurationsStack, groupConfigurations, &run);
            step = step->next_;
          } else {
            step->ReadFromTaskJSON(configurationsStack, groupConfigurations, &run);
          }

          current_stack.push_back(step);
          steps_.push_front(step);
          ns_Schedule::Step* attemptStep = step;
          for (uint64_t attempt=1; attempt<step->nb_retry_; ++attempt) {
            attemptStep->next_ = new ns_Schedule::Step(*attemptStep, run_id++, attempt, parent_stack);
            attemptStep = attemptStep->next_;
            current_stack.push_back(attemptStep);
            steps_.push_front(attemptStep);
          }
          step = attemptStep;
        }
      } else {
        current_stack.push_back(step);
        steps_.push_front(step);
        ns_Schedule::Step* attemptStep = step;
        for (uint64_t attempt=1; attempt<step->nb_retry_; ++attempt) {
          attemptStep->next_ = new ns_Schedule::Step(*attemptStep, run_id++, attempt, parent_stack);
          attemptStep = attemptStep->next_;
          current_stack.push_back(attemptStep);
          steps_.push_front(attemptStep);
        }
      }
      first_step->previous_ = current_stack.back();
      first_step->previous_->next_ = first_step;

      if (!parent_stack.empty()) {
        if ((parent_stack.front()->group_status_ == Step::stepsGroup_None_) || 
            (parent_stack.front()->group_status_ == Step::stepsGroup_End_)) {
          for(auto& parent : parent_stack) {
            parent->dependencies_.insert(
                parent->dependencies_.end(),
                current_stack.rbegin(), current_stack.rend()
            );
          }
        } else {
          for(auto& parent : parent_stack) {
            for(auto& step : current_stack) {
              if ((parent->rank_id_ == step->rank_id_) && (parent->attempt_id_ == step->attempt_id_)) {
                parent->dependencies_.push_back(step);
              }
            }
          }
        }
      }

      if (is_root_steps) {
        root_steps_ = current_stack;
        is_root_steps = false;
      }

      parent_stack = current_stack;

      step_id++;
      stepsGroupStart = false;
    } while (!flowElements.empty());
  }
}

std::unordered_map<std::string, std::string> 
ns_Schedule::Task::LoadGlobalParameters(std::filesystem::path const& file) {
  std::ifstream ifs(file);
  if (!ifs.is_open()) {
    throw std::runtime_error("[Task::LoadGlobalParameters] Unable to open parameters file: " + 
        file.string());
  }
  std::regex pairRegex(R"raw((\w+)="([^"]*)")raw");
  std::sregex_iterator end;
  std::unordered_map<std::string, std::string> parameters;
  std::string line;
  while (std::getline(ifs, line)) {
    std::sregex_iterator it(line.begin(), line.end(), pairRegex);
    while (it != end) {
        parameters.emplace((*it)[1], (*it)[2]);
        ++it;
    }
  }
  return parameters;
}

void ns_Schedule::Task::SaveGlobalParameters(
    std::unordered_map<std::string, std::string> const& parameters, 
    std::filesystem::path const& file) {
  std::ofstream ofs = std::ofstream(file, std::ios::trunc);
  if (!ofs.is_open()) {
    throw std::runtime_error("[Task::SaveGlobalParameters] Unable to open for write paramerters file: " + 
        file.string());
  }
  for(auto const& parameter: parameters) {
    ofs << parameter.first << "=\"" << parameter.second << "\" ";
  }
  ofs.close();
}

std::string ns_Schedule::Task::StateEnumToString(ns_Schedule::Task::State state) {
  static std::unordered_map<ns_Schedule::Task::State, std::string> map {
      { Task::State::Pending, "Pending" }, 
      { Task::State::Running, "Running" }, 
      { Task::State::Done, "Done" }, 
      { Task::State::Cancelled, "Cancelled" },
  };
  return map.at(state);
}

ns_Schedule::Task::State ns_Schedule::Task::StateStringToEnum(std::string const& state) {
  static std::unordered_map<std::string, ns_Schedule::Task::State> map {
      { "Pending", Task::State::Pending }, 
      { "Running", Task::State::Running }, 
      { "Done", Task::State::Done }, 
      { "Cancelled", Task::State::Cancelled },
  };
  return map.at(state);
}
