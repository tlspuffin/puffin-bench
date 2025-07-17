#include "task.hxx"
#include "step.hxx"
#include "executor/executor.hxx"
#include <unordered_set>

ns_Schedule::Task::~Task() {
  for(auto& it : executors_) {
    delete it.second;
  }
}

void ns_Schedule::Task::FinalClean(std::filesystem::path const& savePath) {
  for(auto executorIT : executors_) {
    executorIT.first->FinalClean(savePath, this);
  }
  for(std::filesystem::path const& path: { functions_path_, files_path_ }) {
  std::error_code ec;
    if (std::filesystem::remove_all(path, ec) == -1) {
      std::cerr << "Error while removing " << path << "\n" << 
          "\t" << ec.value() << ": " << ec.message() << std::endl;
    }
  }
}

void ns_Schedule::Task::ToJSON(rapidjson::Value& out, 
    rapidjson::Document::AllocatorType& alloc, 
    ns_Schedule::Step const* step) const {
  out.AddMember("id", id_, alloc);
  out.AddMember("files_path", rapidjson::Value(files_path_.c_str(), alloc), alloc);
  out.AddMember("functions_path", rapidjson::Value(functions_path_.c_str(), alloc), alloc);
  out.AddMember("run_root_path", rapidjson::Value(run_root_path_.c_str(), alloc), alloc);

  std::unordered_set<uint64_t> uniqueStepIds;
  for (const auto& step : root_steps_) {
    uniqueStepIds.insert(step->step_id_);
  }
  rapidjson::Value rootStepsArray(rapidjson::kArrayType);
  for (int id : uniqueStepIds) {
    rootStepsArray.PushBack(id, alloc);
  }
  out.AddMember("root_steps", rootStepsArray, alloc);

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
  if (step != nullptr) {
    auto executorTaskData = executors_.find(step->executor_);
    if (executorTaskData != executors_.end()) {
      rapidjson::Value executorTaskDataJSON(rapidjson::kObjectType);
      executorTaskData->second->ToJSON(executorTaskDataJSON, alloc);
      out.AddMember("task_executor_data", executorTaskDataJSON, alloc);
    }
  }
}