#include "tasksmanager.hxx"
#include "schedule.hxx"
#include "../utils/rapidjson.hxx"
#include <unordered_set>
#include <stack>
#include <fstream>
#include <iostream>
#include <chrono>
#include <thread>
#include <rapidjson/document.h>
#include <rapidjson/error/error.h>
#include <rapidjson/error/en.h>
#include <rapidjson/prettywriter.h>
#include <rapidjson/filewritestream.h>

ns_Schedule::TasksManager::TasksManager(
    ns_Schedule::Config const& config)
    : config_(config), next_task_id_(0) {
}

ns_Schedule::Task* ns_Schedule::TasksManager::CreateTask(
    std::string const& name, 
    rapidjson::Value const& rootJSON, std::string const& functions, 
    std::unordered_map<std::string, std::vector<uint8_t>>& files, 
    std::unordered_map<std::string, std::string>& args, 
    ns_Schedule::Schedule const& schedule) {

  uint64_t task_id = 0;
  {
    std::lock_guard<std::mutex> lock(lock_);
    //task_id = ++next_task_id_;
    task_id = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count();
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
  }

  std::filesystem::path inDataPath = config_.userPath_ / (std::to_string(task_id));
  std::filesystem::create_directory(inDataPath);
  std::filesystem::path functionsFile = inDataPath / (std::to_string(task_id) + ".sh");
  std::ofstream ofs(functionsFile, std::ios::trunc | std::ios::binary);
  if (!ofs.is_open()) {
    throw std::runtime_error("Unable to create functions file: " + functionsFile.string() + 
        " : " + strerror(errno));
  }
  ofs << functions;
  ofs.close();

  for(auto const& file: files) {
    std::filesystem::path filename = inDataPath / file.first;
    std::ofstream ofs(filename, std::ios::trunc | std::ios::binary);
    if (!ofs.is_open()) {
      throw std::runtime_error("Unable to create functions file: " + filename.string() + 
          " : " + strerror(errno));
    }
    ofs.write(reinterpret_cast<const char*>(file.second.data()), file.second.size());
    ofs.close();
  }

  std::string taskName = name;
  if (taskName.empty()) {
    taskName = GetOrDefault<std::string>(rootJSON, "name", "Unamed Task");
  }

  rapidjson::Value const* publisherConfiguration = nullptr;
  if (rootJSON.HasMember("publish")) {
    if (!rootJSON["publish"].IsObject()) {
      throw std::runtime_error("Invalid 'publish' in JSON");
    }
    publisherConfiguration = &rootJSON["publish"];
  }
  rapidjson::Value const* configurations = nullptr;
  if (rootJSON.HasMember("configurations") && 
      (rootJSON["configurations"].IsObject())) {
    configurations = &rootJSON["configurations"];
  }
  ns_Schedule::Task* task = new ns_Schedule::Task(task_id, taskName, 
      inDataPath, functionsFile, config_.toolsPath_,
      config_.runPath_ / std::to_string(task_id), args, 
      publisherConfiguration, configurations);
  task->root_steps_ = CreateStepsFromJson(rootJSON, task, schedule);

  {
    std::lock_guard<std::mutex> lock(lock_);
    tasks_.push_back(task);
    SaveStatusInternal();
  }

  return task;
}

void ns_Schedule::TasksManager::DeleteTask(ns_Schedule::Task* task) {
  DeleteTaskInternal(task);
  {
    std::lock_guard<std::mutex> lock(lock_);
    tasks_.remove(task);
    SaveStatusInternal();
  }
}

void ns_Schedule::TasksManager::DeleteTasks() {
  std::list<ns_Schedule::Task*> tasks;
  {
    std::lock_guard<std::mutex> lock(lock_);
    tasks.swap(tasks_);
  }
  for(auto const& task: tasks) {
    try {
      DeleteTaskInternal(task);
    } catch(std::runtime_error const& e) {
      std::cerr << "DeleteTask exception on id: " << task->id_ << 
          " : " << e.what() << std::endl;
    } catch(...) {
      std::cerr << "DeleteTask exception on id: " << task->id_ << std::endl;
    }
  }
}

void ns_Schedule::TasksManager::TaskEnded(ns_Schedule::Task* task) {
  DeleteTaskInternal(task);
  {
    std::lock_guard<std::mutex> lock(lock_);
    tasks_.remove(task);
    SaveStatusInternal();
  }
}

std::string ns_Schedule::TasksManager::GetRunningOutput(
    std::string const& type, uint64_t taskID, uint64_t stepUUID, 
    size_t readSize, ssize_t readOffset, 
    enum ns_Schedule::OutputState& state) {
  std::cerr << "Look for task: " << taskID << std::endl;
  state = OutputState::UNKNOWN;
  std::lock_guard<std::mutex> lock(lock_);
  for(auto const& task: tasks_) {
    if (task->id_ != taskID) {
      continue;
    }

    ns_Schedule::Step const* firstStep = task->root_steps_.front();
    ns_Schedule::Step const* step = nullptr;
    do {
      if (step != nullptr) {
        firstStep = step->dependencies_.front();
      }
      step = firstStep;
      do {
        std::cerr << "Check step: " << step->ID()  <<
            " uuid: " << step->uuid_ << std::endl;

        if (step->uuid_ == stepUUID) {
          std::cerr << "\tFound " << std::endl;
          return step->executor_->GetRunningOutput(
              *step, type, readSize, readOffset, state);
        }
        step = step->next_;
      } while(step != firstStep);
    } while(!step->dependencies_.empty());

    break;
  }
  return "";
}

std::tuple<std::list<ns_Schedule::Step*>, std::list<ns_Schedule::Step*>, std::list<ns_Schedule::Step*>> 
ns_Schedule::TasksManager::LoadStatus(
    ns_Schedule::Schedule const* schedule) {
  std::string filename = (config_.exportPath_ / "tasksmanager.json").string();
  std::ifstream statusFile(filename);
  if (!statusFile.is_open()) {
    std::cerr << "Warning: Unable to open tasksmanager status file " << 
        filename << ". Tasksmanager start stateless." << std::endl;
    return std::make_tuple<>(
        std::list<ns_Schedule::Step*>(), std::list<ns_Schedule::Step*>(), std::list<ns_Schedule::Step*>());
  }
  std::stringstream buffer;
  buffer << statusFile.rdbuf();
  rapidjson::Document doc;
  doc.Parse(buffer.str().c_str());
  if (doc.HasParseError()) {
    throw std::runtime_error(std::string("Error while parsing JSON file '") +
        (config_.exportPath_ / "status.json").string() + "' : " +
        rapidjson::GetParseError_En(doc.GetParseError()) +
        " (offset: " + std::to_string(doc.GetErrorOffset()) + ")");
  }

  if (!doc.HasMember("tasks") || !doc["tasks"].IsArray()) {
    throw std::runtime_error("Missing or invalid 'tasks' array");
  }

  std::list<ns_Schedule::Step*> stepsPending;
  std::list<ns_Schedule::Step*> stepsRunning;
  std::list<ns_Schedule::Step*> stepsDone;
  rapidjson::Value const& tasksArray = doc["tasks"];
  for (rapidjson::SizeType i = 0; i < tasksArray.Size(); i++) {
    rapidjson::Value const& taskJson = tasksArray[i];
    ns_Schedule::Task* task = 
        new ns_Schedule::Task(taskJson, schedule, stepsPending, stepsRunning, stepsDone);
    {
      std::lock_guard<std::mutex> lock(lock_);
      tasks_.push_back(task);
    }
  }
  return std::make_tuple<>(stepsPending, stepsRunning, stepsDone);
}

void ns_Schedule::TasksManager::DeleteTaskInternal(ns_Schedule::Task* task) {
  for(auto rootStep: task->root_steps_) {
    if (!rootStep->depend_from_.empty()) {
      throw std::runtime_error("Trying to delete a non-root task: name=" +
          rootStep->name_ + ", uuid=" + std::to_string(rootStep->uuid_));
    }
    std::unordered_set<ns_Schedule::Step*> stepCleared;
    std::stack<ns_Schedule::Step*> stepToClear;
    stepToClear.push(rootStep);
    while (!stepToClear.empty()) {
      ns_Schedule::Step* step = stepToClear.top();
      stepToClear.pop();
      if (!stepCleared.insert(step).second) {
        continue;
      }
      for(ns_Schedule::Step* childStep : step->dependencies_) {
        stepToClear.push(childStep);
      }
      delete step;
    }
  }
  delete task;
}

std::list<ns_Schedule::Step*> ns_Schedule::TasksManager::CreateStepsFromJson(
    rapidjson::Value const& root, ns_Schedule::Task* task, 
    ns_Schedule::Schedule const& schedule) {
  std::list<ns_Schedule::Step*> parent_stack;
  std::list<ns_Schedule::Step*> current_stack;
  std::list<ns_Schedule::Step*> root_steps;
  bool is_first_task = true;

  if (!root.HasMember("flow") || !root["flow"].IsArray()) {
    throw std::runtime_error("Invalid or missing 'flow' in JSON");
  }

  rapidjson::Value runEmptyConfiguration(rapidjson::kObjectType);

  uint64_t step_id = 0;

  rapidjson::Value const& flow = root["flow"];

  for (rapidjson::SizeType i = 0; i < flow.Size(); ++i) {
    rapidjson::Value const& stepJSON = flow[i];
    uint64_t run_id = 0;

    if (!stepJSON.HasMember("step") || !stepJSON["step"].IsString()) {
      continue;
    }

    current_stack.clear();

    std::string const& step_name = stepJSON["step"].GetString();

    rapidjson::Value const* monitorJSON = nullptr;
    if (stepJSON.HasMember("monitor") && (stepJSON["monitor"].IsObject())) {
      monitorJSON = &(stepJSON["monitor"]);
    }

    std::vector<rapidjson::Value const*> configurationsStack;
    if (stepJSON.HasMember("configuration")) {
      configurationsStack.push_back(&stepJSON["configuration"]);
    }

    ns_Schedule::Step* step = new ns_Schedule::Step(task, step_name, monitorJSON);
    rapidjson::Value const* runConfiguration = &runEmptyConfiguration;
    step->ReadFromTaskJSON(task->configurations_, configurationsStack, runConfiguration);
    configurationsStack.push_back(runConfiguration);

    if (stepJSON.HasMember("run") && stepJSON["run"].IsArray()) {
      rapidjson::Value const& run_array = stepJSON["run"];

      ns_Schedule::Step* first_step = step;
      ns_Schedule::Step* last_step = step;
      for (rapidjson::SizeType j = 0; j < run_array.Size(); ++j) {
        rapidjson::Value const& run = run_array[j];
        if (j != 0) {
          step->next_ = new ns_Schedule::Step(*step);
          step = step->next_;
        }

        step->ReadFromTaskJSON(task->configurations_, configurationsStack, &run);

        std::list<ns_Schedule::Step*> attempts = ConfigureStep(
            step, step_id, j, run_id, parent_stack, schedule);
        current_stack.insert(current_stack.end(), attempts.begin(), attempts.end());

        last_step = attempts.back();
        attempts.back()->next_ = first_step;
      }
      first_step->previous_ = last_step;
    } else {
      std::list<ns_Schedule::Step*> attempts = ConfigureStep(
          step, step_id, 0, run_id, parent_stack, schedule);
      current_stack.insert(current_stack.end(), attempts.begin(), attempts.end());

      attempts.front()->previous_ = attempts.back();
      attempts.back()->next_ = attempts.front();
    }

    for(auto& parent : parent_stack) {
      parent->dependencies_.insert(
          parent->dependencies_.end(),
          current_stack.rbegin(), current_stack.rend()
      );
    }

    if (is_first_task) {
      root_steps = current_stack;
      is_first_task = false;
    }

    parent_stack = current_stack;

    step_id++;
  }

  return root_steps;
}

std::list<ns_Schedule::Step*> ns_Schedule::TasksManager::ConfigureStep(
    ns_Schedule::Step* step, uint64_t step_id, 
    uint64_t rank_id, uint64_t& run_id, 
    std::list<ns_Schedule::Step*>& parent_stack, 
    ns_Schedule::Schedule const& schedule) {
  ns_Executor::Executor* executor = schedule.GetExecutor(step->executor_name_);
  step->executor_name_ = executor->Name();
  step->executor_ = executor;

  step->step_id_ = step_id;
  step->rank_id_ = rank_id;
  step->run_id_ = run_id++;

  std::string step_name = std::to_string(step->step_id_) + "-" + 
      std::to_string(step->rank_id_) + "-" + 
      std::to_string(step->attempt_id_);

  step->stdout_ = step->task_->logs_path_ / ("stdout." + step_name + ".txt");
  step->stderr_ = step->task_->logs_path_ / ("stderr." + step_name + ".txt");
  step->depend_from_ = parent_stack;
  return CreateRetrySteps(step, run_id);
}

std::list<ns_Schedule::Step*> ns_Schedule::TasksManager::CreateRetrySteps(
    ns_Schedule::Step* base_step, uint64_t& run_id) {
  uint64_t nb_retry = base_step->nb_retry_;      
  std::list<ns_Schedule::Step*> attempts;
  attempts.push_back(base_step);
  ns_Schedule::Step* step = base_step;

  for (uint64_t attempt=1; attempt<nb_retry; ++attempt) {
    step->next_ = new ns_Schedule::Step(*step);
    step = step->next_;
    step->run_id_ = run_id++;

    std::string step_name = std::to_string(step->step_id_) + "-" + 
      std::to_string(step->rank_id_) + "-" + 
      std::to_string(step->attempt_id_);

    step->stdout_ = step->task_->logs_path_ / ("stdout." + step_name + ".txt");
    step->stderr_ = step->task_->logs_path_ / ("stderr." + step_name + ".txt");

    attempts.push_back(step);
  }
  base_step->previous_ = attempts.front();

  return attempts;
}

void ns_Schedule::TasksManager::SaveStatusInternal() const {
  rapidjson::Document doc;
  doc.SetObject();
  rapidjson::MemoryPoolAllocator<>& alloc = doc.GetAllocator();

  rapidjson::Value tasksArray(rapidjson::kArrayType);
  for (auto const& task : tasks_) {
    rapidjson::Value taskJSON(rapidjson::kObjectType);
    task->ToJSON(taskJSON, alloc, nullptr);
    tasksArray.PushBack(taskJSON, alloc);
  }
  doc.AddMember("tasks", tasksArray, alloc);

  std::string filename = (config_.exportPath_ / "tasksmanager.json").string();
  FILE* fp = std::fopen((filename + "tmp").c_str(), "w");
  if (!fp) {
    throw std::system_error(errno, std::generic_category(), "Unable to open " + filename);
  }
  char buffer[65536];
  rapidjson::FileWriteStream os(fp, buffer, sizeof(buffer));
  rapidjson::PrettyWriter<rapidjson::FileWriteStream> writer(os);
  doc.Accept(writer);
  std::fclose(fp);

  std::filesystem::rename((filename + "tmp"), filename);
}
