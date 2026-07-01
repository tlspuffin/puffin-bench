#include "publish.hxx"
#include "../../utils/logs.hxx"

ns_Publish::Publish::Publish(Config const& config)
    : config_(config), running_(false)
{
  ScanProjects();
  running_ = true;
  thread_ = std::thread(&ns_Publish::Publish::Main, this);
}

ns_Publish::Publish::~Publish() {
  running_ = false;
  threadWait_.notify_one();
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

  std::lock_guard<std::mutex> lock(lockPendingNotifyFiles_);
  pendingNotifyFiles_.push({*(dstPath.begin()), std::move(srcFiles)});
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

bool ns_Publish::Publish::RegenerateDataCache(std::string const& projectName, std::string const& directory) {
  std::lock_guard lock(lockProjects_);
  for(auto& project: projects_) {
    if (project.name == projectName) {
      return project.ScanStorage(true, directory);
    }
  }
  return false;
}

bool ns_Publish::Publish::DeleteData(std::string const& projectName, std::string const& cacheFile) {
  std::lock_guard lock(lockProjects_);
  for(auto& project: projects_) {
    if (project.name == projectName) {
      return project.DeleteData(cacheFile);
    }
  }
  return false;
}


void ns_Publish::Publish::ScanProjects() {
  LOGI << "Publish folder:" << Log::Flags::End;
  std::unordered_set<std::string> filteredProjects { };
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
  {
    std::vector<Project> goodProjects;
    for (Project& project: projects_) {
      if (project.ScanStorage(false, "")) {
        goodProjects.push_back(std::move(project));
      }
    }
    std::lock_guard lock(lockProjects_);
    projects_.swap(goodProjects);
  }
  LOGI << "Initial scan done" << Log::Flags::End;

  std::chrono::steady_clock::time_point lastCheck = std::chrono::steady_clock::now();
  std::unique_lock<std::mutex> lock(lockPendingNotifyFiles_);
  while(running_) {
    threadWait_.wait_for(lock, std::chrono::seconds(1), [&](){ 
        return !running_ || !pendingNotifyFiles_.empty(); 
    });
    std::queue<SNotifyFiles> pendingNotifyFiles;
    pendingNotifyFiles.swap(pendingNotifyFiles_);

    lock.unlock();

    while(!pendingNotifyFiles.empty()) {
      ProcessANotifyFilesRequest(pendingNotifyFiles);
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

    lock.lock();
  }
}

void ns_Publish::Publish::ProcessANotifyFilesRequest(std::queue<ns_Publish::Publish::SNotifyFiles>& requests) {
  SNotifyFiles request = std::move(requests.front());
  requests.pop();

  struct Project* targetProject = nullptr;
  for(struct Project& project: projects_) {
    if (request.projectName == project.name) {
      targetProject = &project;
    }
  }
  if (targetProject == nullptr) {
    return;
  }

  targetProject->ScanFiles(request.files);
}
