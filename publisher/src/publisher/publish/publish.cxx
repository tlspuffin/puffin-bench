#include "publish.hxx"
#include "../../utils/logs.hxx"
#include "../../utils/dir.hxx"
#include <stdexcept>
#include <unordered_map>
#include <unordered_set>
#include <typeindex>
#include <functional>

ns_Publish::Publish::Publish(Config const& config)
    : config_(config), running_(false)
{
  ScanProjects();
  for (Project& project : projects_) {
    if (!project.ScanStorage(false, "")) {
      throw std::runtime_error("Initial scan failed for project " + project.name);
    }
  }
  LOGI << "Initial scan done" << Log::Flags::End;

  running_ = true;
  thread_ = std::thread(&ns_Publish::Publish::Main, this);
}

ns_Publish::Publish::~Publish() {
  {
    std::lock_guard<std::mutex> lock(lockPendingCommands_);
    running_ = false;
    threadWait_.notify_one();
  }
  if (thread_.joinable()) {
    thread_.join();
  }
}

bool ns_Publish::Publish::NotifyFiles(std::vector<std::filesystem::path>& srcFiles, 
    std::filesystem::path dstPath, std::string& error) {
  if (dstPath.empty()) {
    error = "No destination path";
    return false;
  }
  std::filesystem::path dstFullPath = (config_.storage_ / dstPath).lexically_normal();
  std::filesystem::path dstRelativePath = dstFullPath.lexically_relative(config_.storage_);
  if (dstRelativePath.empty() || (*dstRelativePath.begin() == "..")) {
    error = "Destination can not be " + dstPath.string();
    return false;
  }
  dstPath = dstRelativePath;
  if (srcFiles.empty()) {
    error = "No source file";
    return false;
  }

  for(std::filesystem::path& file: srcFiles) {
    file = config_.storage_ / dstPath / file.filename();
    if (!std::filesystem::exists(file)) {
      error = "File " + file.string() + " does not exist";
      return false;
    }
  }

  std::lock_guard<std::mutex> lock(lockPendingCommands_);
  pendingCommands_.emplace(*(dstPath.begin()), SCommandNotify{std::move(srcFiles)});
  threadWait_.notify_one();
  return true;
}

bool ns_Publish::Publish::ProjectListData(std::string const& projectName, std::vector<std::string>& list) {
  std::shared_lock lock(lockProjects_);
  for(auto& project: projects_) {
    if (project.name == projectName) {
      list = project.ListData();
      return true;
    }
  }
  return false;
}

std::string ns_Publish::Publish::RulesIndex(std::filesystem::path path) {
  if (path.empty()) {
    return path;
  }
  std::string result = path;
  {
    std::shared_lock lock(lockProjects_);
    for(auto const& project: projects_) {
      if (*(path.begin()) == project.name) {
        std::filesystem::path relativePath = path.lexically_relative(*path.begin());
        auto const& it = project.indexes.find(relativePath);
        if (it != project.indexes.end()) {
          result = std::filesystem::path("publisher") / it->second;
          break;
        }
      }
    }
  }
  return result;
}

std::unordered_map<std::string, std::unordered_map<std::string, std::vector<std::pair<std::string,std::string>>>> 
    ns_Publish::Publish::ProjectListCampaigns(std::string const& projectName) {
  std::shared_lock lock(lockProjects_);
  for(auto& project: projects_) {
    if (project.name == projectName) {
      return project.ListCampaigns();
    }
  }
  return {};
}

bool ns_Publish::Publish::RegenerateDataCache(std::string const& projectName, std::filesystem::path directory) {
  if (!NormalizeSubPath(directory)) {
    LOGW << "Invalid regenerate directory \"" << directory << "\" for project " << projectName << Log::Flags::End;
    return false;
  }

  try {
    std::lock_guard<std::mutex> lock(lockPendingCommands_);
    pendingCommands_.emplace(projectName, SCommandRegenerateCache{directory});
    threadWait_.notify_one();
    return true;
  } catch(std::exception const& e) {
    LOGW << "Exception RegenerateDataCache: " << e.what() << Log::Flags::End;
  }
  return false;
}

bool ns_Publish::Publish::DeleteData(std::string const& projectName, std::string const& cacheFile) {
  try {
    std::lock_guard<std::mutex> lock(lockPendingCommands_);
    pendingCommands_.emplace(projectName, SCommandDeleteEntry{cacheFile});
    threadWait_.notify_one();
    return true;
  } catch(std::exception const& e) {
    LOGW << "Exception DeleteData: " << e.what() << Log::Flags::End;
  }
  return false;
}

int ns_Publish::Publish::DeleteResults(uint64_t taskID) {
  std::string projectName;
  { 
    std::shared_lock lock(lockProjects_);
    for(auto& project: projects_) {
      if (project.HasTask(taskID)) {
        projectName = project.name;
        break;
      }
    }
  }
  if (projectName.empty()) {
    return 0;
  }
  try {
    std::lock_guard<std::mutex> lock(lockPendingCommands_);
    pendingCommands_.emplace(projectName, SCommandDeleteFiles{taskID});
    threadWait_.notify_one();
    return 1;
  } catch(std::exception const& e) {
    LOGW << "Exception DeleteResults: " << e.what() << Log::Flags::End;
  }
  return 2;
}

void ns_Publish::Publish::ScanProjects() {
  LOGI << "Publish folder:" << Log::Flags::End;
  std::unordered_set<std::string> filteredProjects {};
  for (auto iterator = std::filesystem::recursive_directory_iterator(config_.storage_);
      iterator != std::filesystem::recursive_directory_iterator();
      ++iterator) {
    if (!iterator->is_directory()) continue;
    iterator.disable_recursion_pending();
    std::string folderName = std::filesystem::relative(*iterator, config_.storage_);
    if (folderName.find(".") == 0) {
      continue;
    }
    if (filteredProjects.find(folderName) != filteredProjects.end()) {
      continue;
    }
    LOGI << "* " << folderName << Log::Flags::End;
    projects_.push_back(ns_Publish::Project{ folderName, iterator->path() });
  }
  LOGI << Log::Flags::End;
}

void ns_Publish::Publish::Main() {
  static std::unordered_map<std::type_index, std::function<bool(struct Project* project, std::any const& parameters)>> const commands {
    { std::type_index(typeid(struct SCommandNotify)), [](struct Project* project, std::any const& parameters) -> bool {
        struct SCommandNotify const* command = std::any_cast<SCommandNotify>(&parameters);
        return project->ScanFiles(command->files);
    }},
    { std::type_index(typeid(struct SCommandRegenerateCache)), [](struct Project* project, std::any const& parameters) -> bool {
        struct SCommandRegenerateCache const* command = std::any_cast<SCommandRegenerateCache>(&parameters);
        return project->ScanStorage(true, command->directory);
    }},
    { std::type_index(typeid(struct SCommandDeleteEntry)), [](struct Project* project, std::any const& parameters) -> bool {
        struct SCommandDeleteEntry const* command = std::any_cast<SCommandDeleteEntry>(&parameters);
        return project->DeleteData(command->cacheFile);
    }},
    { std::type_index(typeid(struct SCommandDeleteFiles)), [](struct Project* project, std::any const& parameters) -> bool {
        struct SCommandDeleteFiles const* command = std::any_cast<SCommandDeleteFiles>(&parameters);
        return project->DeleteTask(command->taskID);
    }},
  };

  std::chrono::steady_clock::time_point lastCheck = std::chrono::steady_clock::now();
  std::unique_lock<std::mutex> lock(lockPendingCommands_);
  while(running_) {
    threadWait_.wait_for(lock, std::chrono::seconds(1), [&](){ 
        return !running_ || !pendingCommands_.empty(); 
    });
    std::queue<std::pair<std::string,std::any>> pendingCommands;
    pendingCommands.swap(pendingCommands_);

    lock.unlock();
    {
      std::lock_guard lock(lockProjects_);

      while(!pendingCommands.empty()) {
        auto const& [projectName, request] = pendingCommands.front();

        struct Project* targetProject = nullptr;
        for(struct Project& project: projects_) {
          if (projectName == project.name) {
            targetProject = &project;
            break;
          }
        }
        if (targetProject == nullptr) {
          LOGE << "Unknow project " << projectName << " for command " << request.type().name() << Log::Flags::End;
          pendingCommands.pop();
          continue;
        }

        auto it = commands.find(std::type_index(request.type()));
        if (it != commands.end()) {
          if (!it->second(targetProject, request)) {
            LOGE << "Fail to run command " << request.type().name() << " on project " << projectName << Log::Flags::End;
          }
        } else {
          LOGE << "Unknow command " << request.type().name() << " on project " << projectName << Log::Flags::End;
        }

        pendingCommands.pop();
      }

      std::chrono::steady_clock::time_point now = std::chrono::steady_clock::now();
      int64_t elapsedSeconds = (std::chrono::duration_cast<std::chrono::seconds>(
        now - lastCheck)).count();
      if (elapsedSeconds > config_.orphanScanInterval_) {
        for(auto& project: projects_) {
          project.ScanStorage(false, "");
        }
        lastCheck = now;
      }
    }

    lock.lock();
  }
}
