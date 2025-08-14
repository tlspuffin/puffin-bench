#include "task.hxx"
#include "step.hxx"
#include "executor/executor.hxx"
#include <unordered_set>
#include <fstream>
#include <regex>

ns_Schedule::Task::Task(uint64_t id, 
    std::filesystem::path const& inDataPath, 
    std::filesystem::path const& functionsFile, 
    std::filesystem::path const& runRootPath, 
    std::unordered_map<std::string, std::string>& args, 
    rapidjson::Value const* publishConfiguration, 
    rapidjson::Value const* configurations)
    : id_(id), files_path_(inDataPath), 
    functions_path_(functionsFile),
    run_root_path_(runRootPath), args_(args), 
    publish_(*publishConfiguration), 
    logs_path_(run_root_path_ / ".output"), 
    env_path_(run_root_path_ / ".taskenv"), 
    outputs_path_(run_root_path_ / "output")
{
  if (configurations != nullptr) {
    configurations_.ReadFromTaskJSON(*configurations);
  }
}

ns_Schedule::Task::~Task() {
  if (steps_file_.is_open()) {
    steps_file_.close();
  }
  for(auto& it : executors_) {
    delete it.second;
  }
}

bool ns_Schedule::Task::PrepareToRun() {
  CreateRunFolders();

  std::ofstream taskenv = std::ofstream(env_path_, 
      std::ios::trunc);
  for(auto const& arg: args_) {
    taskenv << arg.first << "=\"" << arg.second << "\" ";
  }
  taskenv.close();

  std::filesystem::path stepsFile = logs_path_ / ".steps.json";
  steps_file_.open(stepsFile);
  if (!steps_file_.is_open()) {
    throw std::runtime_error("Unable to create file " + 
        stepsFile.string());
  }

  return true;
}

void ns_Schedule::Task::FinalizeAndArchive(std::filesystem::path const& savePath) {
  if (steps_file_.is_open()) {
    steps_file_.close();
  }

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
    std::unordered_map<std::string, std::string> variables = 
        ReadGlobalParameters(run_root_path_ / "global_params.txt");
    for (const auto& [key, value] : args_) {
      variables.emplace(key, value);
    }
    variables.emplace("task_id", std::to_string(id_));
    publish_.PublishResults(finalSavePath / "logs", finalSavePath / "output" / "artefacts", variables);
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

  out.AddMember("logs_path", rapidjson::Value(logs_path_.c_str(), alloc), alloc);
  out.AddMember("env_path", rapidjson::Value(env_path_.c_str(), alloc), alloc);
  out.AddMember("outputs_path", rapidjson::Value(outputs_path_.c_str(), alloc), alloc);

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

bool ns_Schedule::Task::CreateRunFolders() {
  std::error_code ec;
  for(std::filesystem::path path : { 
      run_root_path_, logs_path_, 
      outputs_path_, outputs_path_ / "artefacts"
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

std::unordered_map<std::string, std::string> 
ns_Schedule::Task::ReadGlobalParameters(std::filesystem::path const& envFile) {
  std::regex pairRegex(R"raw((\w+)="([^"]*)")raw");
  std::sregex_iterator end;
  std::unordered_map<std::string, std::string> parameters;
  std::ifstream file(envFile);
  std::string line;
  while (std::getline(file, line)) {
    std::sregex_iterator it(line.begin(), line.end(), pairRegex);
    while (it != end) {
        parameters.emplace((*it)[1], (*it)[2]);
        ++it;
    }
  }
  return parameters;
}

std::string ns_Schedule::Task::ResolveVariables(std::string const& pattern, 
    std::unordered_map<std::string, std::string> const& taskVariables) {
  std::unordered_map<std::string, std::string> variables = taskVariables;

  for (const auto& [key, value] : args_) {
    variables.emplace(key, value);
  }

  variables.emplace("task_id", std::to_string(id_));
  std::string result = pattern;

  size_t pos = 0;
  while ((pos = result.find("${", pos)) != std::string::npos) {
    size_t end = result.find('}', pos);
    if (end == std::string::npos) {
      break;
    }
    std::string variableName = result.substr(pos + 2, end - pos - 2);
    auto const& it = variables.find(variableName);
    if (it != variables.end()) {
      result.replace(pos, end - pos + 1, it->second);
      pos += it->second.length();
    } else {
      pos = end + 1;
    }
  }

  return result;
}
