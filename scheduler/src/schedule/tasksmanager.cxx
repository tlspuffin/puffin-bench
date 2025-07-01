#include "tasksmanager.hxx"
#include <unordered_set>
#include <stack>
#include <fstream>

ns_Schedule::TasksManager::TasksManager(ns_Schedule::Config const& config)
    : config_(config), next_task_id_(0)
{
}

std::pair<uint64_t, std::list<ns_Schedule::Step*>> ns_Schedule::TasksManager::CreateTask(
      rapidjson::Value const& rootJSON, std::string const& functions, 
      std::string const& defaultExecutor, 
      std::unordered_map<std::string, ns_Executor::Executor*>& executors) {

  uint64_t task_id = ++next_task_id_;

  std::filesystem::path functionsFile = config_.userPath_ / (std::to_string(task_id) + ".sh");
  std::ofstream ofs(functionsFile, std::ios::trunc | std::ios::binary);
  if (!ofs.is_open()) {
    throw std::runtime_error("Unable to create functions file: " + functionsFile.string() + 
        " : " + strerror(errno));
  }
  ofs << functions;
  ofs.close();

  std::pair<uint64_t, std::list<ns_Schedule::Step*>> results;
  results.first = task_id;
  results.second = CreateStepsFromJson(rootJSON, task_id, functionsFile, 
      defaultExecutor, executors);
  return results;
}

void ns_Schedule::TasksManager::DeleteTask(ns_Schedule::Step* rootStep) {
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

std::list<ns_Schedule::Step*> ns_Schedule::TasksManager::CreateStepsFromJson(
    rapidjson::Value const& root, uint64_t task_id, std::string const& functionsPath, 
    std::string const& defaultExecutor, 
    std::unordered_map<std::string, ns_Executor::Executor*>& executors) {
  std::list<ns_Schedule::Step*> parent_stack;
  std::list<ns_Schedule::Step*> current_stack;
  std::list<ns_Schedule::Step*> root_steps;
  bool is_first_task = true;

  if (!root.HasMember("flow") || !root["flow"].IsArray()) {
    throw std::runtime_error("Invalid or missing 'flow' in JSON");
    return {};
  }

  uint64_t step_id = 0;

  const rapidjson::Value& flow = root["flow"];

  for (rapidjson::SizeType i = 0; i < flow.Size(); ++i) {
    const rapidjson::Value& task = flow[i];

    if (!task.HasMember("task") || !task["task"].IsString()) {
      continue;
    }

    const std::string& task_name = task["task"].GetString();
    current_stack.clear();

    ns_Schedule::Step* step = new ns_Schedule::Step(task_name);
    step->ReadFromJSON(task);

    if (task.HasMember("run") && task["run"].IsArray()) {
      const rapidjson::Value& run_array = task["run"];

      ns_Schedule::Step* first_step = step;
      ns_Schedule::Step* last_step = step;
      for (rapidjson::SizeType j = 0; j < run_array.Size(); ++j) {
        const rapidjson::Value& run = run_array[j];
        if (j != 0) {
          step->next_ = new ns_Schedule::Step(task_name);
          step->next_->previous_ = step;
          step = step->next_;
          step->CopyParameters(*(step->previous_));
        }
        step->ReadFromJSON(run);
        std::list<ns_Schedule::Step*> attempts = ConfigureStep(
            step, task_id, step_id, j, functionsPath, parent_stack, 
            defaultExecutor, executors);
        current_stack.insert(current_stack.end(), attempts.begin(), attempts.end());

        last_step = attempts.back();
        attempts.back()->next_ = first_step;
      }
      first_step->previous_ = last_step;
    } else {
      std::list<ns_Schedule::Step*> attempts = ConfigureStep(
          step, task_id, step_id, 0, functionsPath, parent_stack, 
          defaultExecutor, executors);
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

std::list<ns_Schedule::Step*> ns_Schedule::TasksManager::ConfigureStep(ns_Schedule::Step* step, 
    uint64_t task_id, uint64_t step_id, uint64_t rank_id, std::string const& functionsPath, 
    std::list<ns_Schedule::Step*>& parent_stack, std::string const& defaultExecutor, 
      std::unordered_map<std::string, ns_Executor::Executor*>& executors) {
  auto executor = executors.find(step->executor_name_);
  if (executor == executors.end()) {
    executor = executors.find(defaultExecutor);
  }
  step->executor_ = executor->second;

  step->task_id_ = task_id;
  step->step_id_ = step_id;
  step->rank_id_ = rank_id;
  step->run_root_path_ = std::to_string(step->task_id_);

  std::string run_path = std::to_string(step->step_id_) + "-" + 
      std::to_string(step->rank_id_) + "-" + 
      std::to_string(step->attempt_id_);
  step->run_path_ = step->run_root_path_ / run_path;

  step->functions_path_ = functionsPath;
  step->stdout_ = step->run_root_path_ / (".output/stdout." + run_path + ".txt");
  step->stderr_ = step->run_root_path_ / (".output/stderr." + run_path + ".txt");
  step->depend_from_ = parent_stack;
  return CreateRetrySteps(step);
}

std::list<ns_Schedule::Step*> ns_Schedule::TasksManager::CreateRetrySteps(
    ns_Schedule::Step* base_step) {
  uint64_t nb_retry = base_step->nb_retry_;      
  std::list<ns_Schedule::Step*> attempts;
  attempts.push_back(base_step);
  ns_Schedule::Step* prev_attempt = base_step;

  for (uint64_t attempt=1; attempt<nb_retry; ++attempt) {
    ns_Schedule::Step* step = new ns_Schedule::Step(base_step->name_);
    step->CopyParameters(*base_step);
    step->step_id_ = base_step->step_id_;
    step->rank_id_ = base_step->rank_id_;
    step->attempt_id_ = attempt;

    std::string run_path = std::to_string(step->step_id_) + "-" + 
      std::to_string(step->rank_id_) + "-" + 
      std::to_string(step->attempt_id_);
    step->run_path_ = step->run_root_path_ / run_path;

    step->stdout_ = step->run_root_path_ / (".output/stdout." + run_path + ".txt");
    step->stderr_ = step->run_root_path_ / (".output/stderr." + run_path + ".txt");

    if (prev_attempt) {
      prev_attempt->next_ = step;
      step->previous_ = prev_attempt;
    }

    prev_attempt = step;
    attempts.push_back(step);
  }

  return attempts;
}