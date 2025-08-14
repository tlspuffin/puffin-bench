#include "tasksmanager.hxx"
#include "schedule.hxx"
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

ns_Schedule::TasksManager::TasksManager(ns_Schedule::Config const& config)
    : config_(config), next_task_id_(0)
{
  ReadSavedStatus();
}

ns_Schedule::Task* ns_Schedule::TasksManager::CreateTask(
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

  std::string symbolicFinalStoragePath;
  if (rootJSON.HasMember("final_storage_path")) {
    if (!rootJSON["final_storage_path"].IsString()) {
      throw std::runtime_error("Invalid 'final_storage_path' in JSON");
    }
    symbolicFinalStoragePath = rootJSON["final_storage_path"].GetString();
  }

  ns_Schedule::Task* task = new ns_Schedule::Task();
  task->id_ = task_id;
  task->args_ = args;
  task->symbolic_final_storage_path_ = symbolicFinalStoragePath;
  task->run_root_path_ = config_.runPath_ / std::to_string(task->id_);
  task->files_path_ = inDataPath;
  task->functions_path_ = functionsFile;

  task->logs_path_ = task->run_root_path_ / ".output";
  task->env_path_ = task->run_root_path_ / ".taskenv";
  task->outputs_path_ = task->run_root_path_ / "output";

  task->root_steps_ = CreateStepsFromJson(rootJSON, task, schedule);

  {
    std::lock_guard<std::mutex> lock(lock_);
    tasks_.push_back(task);
    SaveStatus();
  }

  return task;
}

void ns_Schedule::TasksManager::DeleteTask(ns_Schedule::Task* task) {
  DeleteTaskInternal(task);
  {
    std::lock_guard<std::mutex> lock(lock_);
    tasks_.remove(task);
    SaveStatus();
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
    SaveStatus();
  }
}

void ns_Schedule::TasksManager::SaveStatus() const {
  rapidjson::Document doc;
  doc.SetObject();
  rapidjson::MemoryPoolAllocator<>& alloc = doc.GetAllocator();
  doc.AddMember("next_task_id", next_task_id_, alloc);

  rapidjson::Value tasksArray(rapidjson::kArrayType);
  for (auto const& task : tasks_) {
    tasksArray.PushBack(task->id_, alloc);
  }
  doc.AddMember("tasks", tasksArray, alloc);

  std::string filename = (config_.exportPath_ / "tasksmanager.json").string();
  FILE* fp = std::fopen((filename + "tmp").c_str(), "w");
  if (!fp) {
    throw std::system_error(errno, std::generic_category(), "Impossible d'ouvrir " + filename);
  }
  char buffer[65536];
  rapidjson::FileWriteStream os(fp, buffer, sizeof(buffer));
  rapidjson::PrettyWriter<rapidjson::FileWriteStream> writer(os);
  doc.Accept(writer);
  std::fclose(fp);

  std::filesystem::rename((filename + "tmp"), filename);
}

void ns_Schedule::TasksManager::ReadSavedStatus() {
  std::string filename = (config_.exportPath_ / "tasksmanager.json").string();
  std::ifstream statusFile(filename);
  if (!statusFile.is_open()) {
    std::cerr << "Warning: Unable to open tasksmanager status file " << 
        filename << ". Tasksmanager start stateless." << std::endl;
    return;
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
  if (!doc.HasMember("next_task_id")) {
    return;
  }
  if (!doc["next_task_id"].IsUint64()) {
    throw std::runtime_error("Invalid 'next_task_id' in JSON");
  }
  next_task_id_ = doc["next_task_id"].GetUint64();
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

  uint64_t step_id = 0;

  const rapidjson::Value& flow = root["flow"];

  for (rapidjson::SizeType i = 0; i < flow.Size(); ++i) {
    const rapidjson::Value& stepJSON = flow[i];
    uint64_t run_id = 0;

    if (!stepJSON.HasMember("step") || !stepJSON["step"].IsString()) {
      continue;
    }

    const std::string& step_name = stepJSON["step"].GetString();
    current_stack.clear();

    ns_Schedule::Step* step = new ns_Schedule::Step(task, step_name);
    step->ReadFromTaskJSON(stepJSON);

    if (stepJSON.HasMember("run") && stepJSON["run"].IsArray()) {
      const rapidjson::Value& run_array = stepJSON["run"];

      ns_Schedule::Step* first_step = step;
      ns_Schedule::Step* last_step = step;
      for (rapidjson::SizeType j = 0; j < run_array.Size(); ++j) {
        const rapidjson::Value& run = run_array[j];
        if (j != 0) {
          step->next_ = new ns_Schedule::Step(task, step_name);
          step->next_->previous_ = step;
          step = step->next_;
          step->CopyParameters(*(step->previous_));
        }
        step->ReadFromTaskJSON(run);
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
    ns_Schedule::Step* step, 
    uint64_t step_id, uint64_t rank_id, uint64_t& run_id, 
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

  step->stdout_ = "stdout." + step_name + ".txt";
  step->stderr_ = "stderr." + step_name + ".txt";
  step->depend_from_ = parent_stack;
  return CreateRetrySteps(step, run_id);
}

std::list<ns_Schedule::Step*> ns_Schedule::TasksManager::CreateRetrySteps(
    ns_Schedule::Step* base_step, uint64_t& run_id) {
  uint64_t nb_retry = base_step->nb_retry_;      
  std::list<ns_Schedule::Step*> attempts;
  attempts.push_back(base_step);
  ns_Schedule::Step* prev_attempt = base_step;

  for (uint64_t attempt=1; attempt<nb_retry; ++attempt) {
    ns_Schedule::Step* step = new ns_Schedule::Step(base_step->task_, base_step->name_);
    step->CopyParameters(*base_step);
    step->step_id_ = base_step->step_id_;
    step->rank_id_ = base_step->rank_id_;
    step->attempt_id_ = attempt;
    step->run_id_ = run_id++;

    std::string step_name = std::to_string(step->step_id_) + "-" + 
      std::to_string(step->rank_id_) + "-" + 
      std::to_string(step->attempt_id_);

    step->stdout_ = "stdout." + step_name + ".txt";
    step->stderr_ = "stderr." + step_name + ".txt";

    if (prev_attempt) {
      prev_attempt->next_ = step;
      step->previous_ = prev_attempt;
    }

    prev_attempt = step;
    attempts.push_back(step);
  }

  return attempts;
}