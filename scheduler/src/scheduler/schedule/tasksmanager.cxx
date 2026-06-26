#include "tasksmanager.hxx"
#include "schedule.hxx"
#include "../../utils/logs.hxx"
#include "../../utils/rapidjson.hxx"
#include "../../utils/md5_poco.hxx"
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
{}

ns_Schedule::TasksManager::~TasksManager() {
}

ns_Schedule::Task* ns_Schedule::TasksManager::CreateTask(
    std::string const& name, 
    rapidjson::Value const& rootJSON, std::string const& functions, 
    std::unordered_map<std::string, std::vector<uint8_t>>& files, 
    std::unordered_map<std::string, std::string>& args, 
    std::string const& user, std::string const& jobType, 
    ns_Schedule::Schedule const& schedule) {

  uint64_t task_id = 0;
  {
    std::lock_guard<std::mutex> lock(lock_);
    task_id = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count();
    if (task_id < next_task_id_) {
      task_id = next_task_id_;
    }
    next_task_id_ = task_id + 1;
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
  std::map<std::string, std::string> md5;
  md5["."] = MD5(functions);

  for(auto const& file: files) {
    std::filesystem::path filename = inDataPath / file.first;
    std::ofstream ofs(filename, std::ios::trunc | std::ios::binary);
    if (!ofs.is_open()) {
      throw std::runtime_error("Unable to create functions file: " + filename.string() + 
          " : " + strerror(errno));
    }
    ofs.write(reinterpret_cast<const char*>(file.second.data()), file.second.size());
    ofs.close();
    md5["." + file.first] = MD5(reinterpret_cast<const char*>(file.second.data()), file.second.size());
  }

  std::string idMD5;
  for(auto const& [key, value]: md5) {
    idMD5 += key + ":" + value + "\n";
  }
  md5["#"] = MD5(idMD5);

  ns_Schedule::Task* task = new ns_Schedule::Task(
    task_id, name, rootJSON, inDataPath, functionsFile, config_.toolsPath_, 
    config_.runPath_, config_.monitorsPath_ , config_.publishers_, args, 
    user, jobType, md5, schedule);

  {
    std::lock_guard<std::mutex> lock(lock_);
    tasks_.push_back(task);
  }

  return task;
}

void ns_Schedule::TasksManager::DeleteTask(ns_Schedule::Task* task) {
  DeleteTaskInternal(task);
  {
    std::lock_guard<std::mutex> lock(lock_);
    tasks_.remove(task);
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
      LOGE << "DeleteTask exception on id: " << task->id_ << 
          " : " << e.what() << Log::Flags::End;
    } catch(...) {
      LOGE << "DeleteTask exception on id: " << task->id_ << Log::Flags::End;
    }
  }
}

void ns_Schedule::TasksManager::TaskEnded(ns_Schedule::Task* task) {
  DeleteTaskInternal(task);
  {
    std::lock_guard<std::mutex> lock(lock_);
    tasks_.remove(task);
  }
}
void ns_Schedule::TasksManager::GetRunningOutput(
    std::string const& type, uint64_t taskID, uint64_t stepUUID, 
    struct FileExtractedText& data) {
  //LOGD << "Look for task: " << taskID << Log::Flags::End;
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
        /*LOGD << "Check step: " << step->ID()  <<
            " uuid: " << step->uuid_ << Log::Flags::End;*/

        if (step->uuid_ == stepUUID) {
          //LOGD << "\tFound " << Log::Flags::End;
          data.partialFile = true;
          return step->task_->executor_->GetRunningOutput(
              *step, type, data);
        }
        step = step->next_;
      } while(step != firstStep);
    } while(!step->dependencies_.empty());

    break;
  }
}

std::tuple<std::list<ns_Schedule::Step*>, std::list<ns_Schedule::Step*>, std::list<ns_Schedule::Step*>> 
ns_Schedule::TasksManager::LoadStatus(rapidjson::Value const& tasksmanager, 
    ns_Schedule::Schedule const* schedule) {
  /*std::string filename = (config_.exportPath_ / "tasksmanager.json").string();
  std::ifstream statusFile(filename);
  if (!statusFile.is_open()) {
    LOGW << "Warning: Unable to open tasksmanager status file " << 
        filename << ". Tasksmanager start stateless." << Log::Flags::End;
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
  }*/

  if (!tasksmanager.HasMember("tasks") || !tasksmanager["tasks"].IsArray()) {
    throw std::runtime_error("Missing or invalid 'tasks' array");
  }

  std::list<ns_Schedule::Step*> stepsPending;
  std::list<ns_Schedule::Step*> stepsRunning;
  std::list<ns_Schedule::Step*> stepsDone;
  rapidjson::Value const& tasksArray = tasksmanager["tasks"];
  for (rapidjson::SizeType i = 0; i < tasksArray.Size(); i++) {
    rapidjson::Value const& taskJson = tasksArray[i];
    ns_Schedule::Task* task = 
        new ns_Schedule::Task(taskJson, config_.publishers_, *schedule, stepsPending, stepsRunning, stepsDone);
    {
      std::lock_guard<std::mutex> lock(lock_);
      tasks_.push_back(task);
    }
  }
  return std::make_tuple<>(stepsPending, stepsRunning, stepsDone);
}

std::string ns_Schedule::TasksManager::GetTaskState(uint64_t taskID) {
  std::lock_guard<std::mutex> lock(lock_);
  for(Task const* task: tasks_) {
    if (task->id_ == taskID) {
      rapidjson::Document doc;
      doc.SetObject();
      rapidjson::Value taskJSON(rapidjson::kObjectType);
      task->ToJSON(taskJSON, doc.GetAllocator(), nullptr);
      rapidjson::StringBuffer buffer;
      rapidjson::Writer<rapidjson::StringBuffer> writer(buffer);
      taskJSON.Accept(writer);
      return buffer.GetString();
    }
  }
  return "";
}

void ns_Schedule::TasksManager::DeleteTaskInternal(ns_Schedule::Task* task) {
  std::unordered_set<ns_Schedule::Step*> uniqueSteps;
  for(auto rootStep: task->root_steps_) {
    if (!rootStep->depend_from_.empty()) {
      throw std::runtime_error("Trying to delete a non-root task: name=" +
          rootStep->name_ + ", uuid=" + std::to_string(rootStep->uuid_));
    }

    uniqueSteps.insert(rootStep);
    std::stack<ns_Schedule::Step*> stepToClear;
    stepToClear.push(rootStep);
    do {
      std::unordered_set<ns_Schedule::Step*> localSteps;
      while (!stepToClear.empty()) {
        ns_Schedule::Step* step = stepToClear.top();
        stepToClear.pop();
        for(ns_Schedule::Step* childStep : step->dependencies_) {
          uniqueSteps.insert(childStep);
          localSteps.insert(childStep);
        }
      }
      for(ns_Schedule::Step* step : localSteps) {
        stepToClear.push(step);
      }
    } while(!stepToClear.empty());
  }

  for(ns_Schedule::Step* step : uniqueSteps) {
    delete step;
  }
  uniqueSteps.clear();

  delete task;
}

void ns_Schedule::TasksManager::ToJSONInternal(rapidjson::Value& root, 
    rapidjson::MemoryPoolAllocator<>& alloc) const {
  rapidjson::Value tasksArray(rapidjson::kArrayType);
  for (auto const& task : tasks_) {
    rapidjson::Value taskJSON(rapidjson::kObjectType);
    task->ToJSON(taskJSON, alloc, nullptr);
    tasksArray.PushBack(taskJSON, alloc);
  }
  root.AddMember("tasks", tasksArray, alloc);
}
