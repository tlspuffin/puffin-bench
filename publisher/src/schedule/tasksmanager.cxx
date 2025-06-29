#include "tasksmanager.hxx"
#include <unordered_set>
#include <stack>
#include <sys/types.h>
#include <sys/stat.h>
#include <fcntl.h>

ns_Schedule::TasksManager::TasksManager(ns_Schedule::Config const& config)
    : config_(config), next_task_id_(0)
{
}

std::pair<uint64_t, std::list<ns_Schedule::Step*>> ns_Schedule::TasksManager::CreateTask(
      rapidjson::Value const& rootJSON, std::string const& functions) {

  uint64_t task_id = next_task_id_++;

  auto functionsFile = config_.userPath_ + "/" + std::to_string(task_id) + ".sh";
  int handle = open(functionsFile.c_str(), O_CREAT | O_TRUNC | O_WRONLY, 0770);
  if (handle == -1) {
    throw std::runtime_error("Unable to create functions file: " + functionsFile + 
        " : " + strerror(errno));
  }
  write(handle, functions.c_str(), functions.length());
  close(handle);

  std::pair<uint64_t, std::list<ns_Schedule::Step*>> results;
  results.first = task_id;
  results.second = CreateStepsFromJson(rootJSON, task_id, functionsFile);
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
    rapidjson::Value const& root, uint64_t task_id, std::string const& functionsPath) {
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
        step->task_id_ = task_id;
        step->step_id_ = step_id;
        step->rank_id_ = j;
        step->run_path_ = config_.runPath_ + "/" + std::to_string(step->task_id_);
        step->functions_path_ = functionsPath;
        step->stdout_ = step->run_path_ + "/.output/stdout." + 
            std::to_string(step->step_id_) + "-" + 
            std::to_string(step->rank_id_) + "-" + 
            std::to_string(step->attempt_id_) + ".txt";
        step->stderr_ = step->run_path_ + "/.output/stderr." + 
            std::to_string(step->step_id_) + "-" + 
            std::to_string(step->rank_id_) + "-" + 
            std::to_string(step->attempt_id_) + ".txt";
        
        step->ReadFromJSON(run);
        step->depend_from_ = parent_stack;

        std::list<ns_Schedule::Step*> attempts = CreateRetrySteps(step);
        current_stack.insert(current_stack.end(), attempts.begin(), attempts.end());

        last_step = attempts.back();
        attempts.back()->next_ = first_step;
      }
      first_step->previous_ = last_step;
    } else {
      step->task_id_ = task_id;
      step->step_id_ = step_id;
      step->run_path_ = config_.runPath_ + "/" + std::to_string(step->task_id_);
      step->functions_path_ = functionsPath;
      step->stdout_ = step->run_path_ + "/.output/stdout." + 
          std::to_string(step->step_id_) + "-0-" +
          std::to_string(step->attempt_id_) + ".txt";
      step->stderr_ = step->run_path_ + "/.output/stderr." + 
          std::to_string(step->step_id_) + "-0-" +
          std::to_string(step->attempt_id_) + ".txt";
      step->depend_from_ = parent_stack;

      std::list<ns_Schedule::Step*> attempts = CreateRetrySteps(step);
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

    step->stdout_ = step->run_path_ + "/.output/stdout." +
        std::to_string(step->step_id_) + "-" +
        std::to_string(step->rank_id_) + "-" +
        std::to_string(step->attempt_id_) + ".txt";

    step->stderr_ = step->run_path_ + "/.output/stderr." +
        std::to_string(step->step_id_) + "-" +
        std::to_string(step->rank_id_) + "-" +
        std::to_string(step->attempt_id_) + ".txt";

    if (prev_attempt) {
      prev_attempt->next_ = step;
      step->previous_ = prev_attempt;
    }

    prev_attempt = step;
    attempts.push_back(step);
  }

  return attempts;
}