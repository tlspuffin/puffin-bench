#include "task.hxx"
#include "step.hxx"
#include "executor/executor.hxx"
#include <unordered_set>
#include <fstream>
#include <regex>

ns_Schedule::Task::~Task() {
  for(auto& it : executors_) {
    delete it.second;
  }
}

void ns_Schedule::Task::FinalizeAndArchive(std::filesystem::path const& savePath) {
  std::filesystem::path finalSavePath = savePath / std::to_string(id_);
  try {
    if (!std::filesystem::create_directory(finalSavePath)) {
      throw std::runtime_error("Unable to create save directory (" + finalSavePath.string() + ")");
    }
    std::filesystem::rename(run_root_path_ / "output", finalSavePath / "output");
    std::filesystem::rename(run_root_path_ / ".output", finalSavePath / "logs");
  } catch(std::runtime_error const& e) {
    std::cerr << "Error while moving resultats from running to save storage\n" <<
        "All keep in " << run_root_path_ << "\n\t" << e.what() << std::endl;
    return;
  } catch(...) {
    std::cerr << "Unknown Error while moving resultats from running to save storage\n" <<
        "All keep in " << run_root_path_ << std::endl;
    return;
  }

  try {
    if (!symbolic_final_storage_path_.empty()) {
      std::unordered_map<std::string, std::string>  variables = 
          ReadGlobalParameters(run_root_path_ / "global_params.txt");

      std::filesystem::path finalStoragePath = ResolveVariables(symbolic_final_storage_path_, variables);
      if (!finalStoragePath.empty()) {
        if (!std::filesystem::create_directories(finalStoragePath)) {
          throw std::runtime_error(
              "Unable to create user save directory (" + finalStoragePath.string() + ")");
        }
        std::filesystem::copy(finalSavePath / "logs", finalStoragePath / "process_logs");
        std::filesystem::copy(finalSavePath / "output", finalStoragePath);
      }
    }
  } catch(std::runtime_error const& e) {
    std::cerr << "Error while moving resultats from save to user save storage\n" <<
        "All keep in " << run_root_path_ << "\n\t" << e.what() << std::endl;
  } catch(...) {
    std::cerr << "Unknown Error while moving resultats from save to user save storage\n" <<
        "All keep in " << run_root_path_ << std::endl;
  }

  for(std::filesystem::path const& path: 
      { run_root_path_, functions_path_, files_path_ }) {
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