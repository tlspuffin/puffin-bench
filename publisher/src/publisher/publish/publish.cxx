#include "publish.hxx"
#include "../../utils/logs.hxx"
#include "../../utils/rapidjson.hxx"
#include "../../utils/dir.hxx"
#include <fstream>

ns_Publish::Publish::Project::Project(std::string const& name, 
    std::filesystem::path const& path, std::filesystem::path const& outputPath)
    : name_(name), path_(path), outputPath_(outputPath), indexed_(), rules_()
{
  indexed_.Load(path_ / ".index.json");
}

bool ns_Publish::Publish::Project::Save() {
  return indexed_.Save(path_ / ".index.json");
}

ns_Publish::Publish::Publish(Config const& config)
    : config_(config), running_(false)
{
  running_ = true;
  thread_ = std::thread(&ns_Publish::Publish::Main, this);
}

ns_Publish::Publish::~Publish() {
  running_ = false;
  threadWait_.notify_one();
  thread_.join();
}

bool ns_Publish::Publish::NotifyFiles(std::vector<std::filesystem::path>&& srcFiles, std::filesystem::path const& dstPath, 
    std::string& error) {
  if (dstPath.empty()) {
    error = "No destination path";
    return false;
  }
 if (dstPath.is_absolute()) {
  error = "Destination should not be absolute";
  return false;
 }
  if (srcFiles.empty()) {
    error = "No source file";
    return false;
  }
  for(std::string const& file: srcFiles) {
    if (!std::filesystem::exists(file)) {
      error = "File " + file + " does not exist";
      return false;
    }
  }

  std::lock_guard<std::mutex> lock(lock_);

  struct Project* targetProject = nullptr;
  for(auto& project: projects_) {
    if (*(dstPath.begin()) == project.name_) {
      targetProject = &project;
      break;
    }
  }
  std::filesystem::path absoluteDstPath = *(dstPath.begin());
  if (targetProject == nullptr) {
      error = "No project name " + absoluteDstPath.string() + " found";
      return false;
  }
  absoluteDstPath = config_.storage_ / dstPath;

  pendingNotifyFiles_.push({std::move(srcFiles), std::move(absoluteDstPath)});
  threadWait_.notify_one();
  return true;
}

std::string ns_Publish::Publish::GetFilePath(std::string const& projectName, std::filesystem::path const& file) {
  std::lock_guard<std::mutex> lock(lock_);
  struct Publish::Project const *projectInfo = nullptr;
  for(auto const& project: projects_) {
    if (project.name_ == projectName) {
      projectInfo = &project;
      break;
    }
  }
  if (projectInfo == nullptr) {
    return "";
  }
  std::string filename = file;
  if (file.is_relative()) {
    filename = projectInfo->path_ / file;
  }
  return (projectInfo->indexed_.HaveIndexed(projectInfo->path_, file)) ? filename : "";
}

std::vector<ns_Publish::Publish::Project> ns_Publish::Publish::ScanProjects() {
  std::vector<ns_Publish::Publish::Project> projects;

  LOGI("Publish folder:");
  std::unordered_set<std::string> filteredProjects { ".html", "Z", "tlspuffin", "tests" };
  try {
    for (auto iterator = std::filesystem::recursive_directory_iterator(config_.storage_);
        iterator != std::filesystem::recursive_directory_iterator();
        ++iterator) {
      if (!iterator->is_directory()) continue;
      iterator.disable_recursion_pending();
      std::string folderName = std::filesystem::relative(*iterator, config_.storage_);
      if (filteredProjects.find(folderName) != filteredProjects.end()) {
        continue;
      }
      LOGI(" * " << folderName);
      projects.push_back(Project{ folderName, *iterator, iterator->path() / ".JSON" });
    }
  } catch (std::filesystem::filesystem_error const& e) {
    LOGE("Filesystem error during projects scan: " << e.what());
  } catch (std::exception const& e) {
    LOGE("Error during projects scan: " << e.what());
  }
  LOGI("");

  for(auto& project : projects) {
    LOGI("Rules scan " << project.path_);
    ScanRules(project, project.path_);
    for (auto iterator = std::filesystem::recursive_directory_iterator(project.path_);
        iterator != std::filesystem::recursive_directory_iterator();
        ++iterator) {
      if (ScanRules(project, *iterator)) {
        iterator.disable_recursion_pending();
      }
    }
  }

  return projects;
}

bool ns_Publish::Publish::ScanRules(ns_Publish::Publish::Project& project, std::filesystem::path const& directory) {
  if (!std::filesystem::is_directory(directory)) {
    return false; // go on with subdir
  }
  if (!std::filesystem::exists(directory / ".rules")) {
    return false; // go on with subdir
  }

  LOGI("Looking rules in " << directory);
  rapidjson::Document doc;
  ReadJSONFile(directory / ".rules", doc);
  for (auto it = doc.MemberBegin(); it != doc.MemberEnd(); ++it) {
    const auto& value = it->value;
    if (!value.IsObject()) {
      return true; // stop search in subdir
    }

    const std::string name = it->name.GetString();
    const std::string action = value["action"].GetString();
    const std::string onFiles = value["onFiles"].GetString();
    const std::string relativePath = std::filesystem::relative(directory, project.path_);
    std::shared_ptr<PublishAction> actionPtr = 
        std::shared_ptr<PublishAction>(PublishAction::Build(directory, relativePath, action, name, onFiles));
    if (actionPtr) {
      project.rules_.push_back(actionPtr);
      std::cout << "Add rules: " << name << " → " << action << " (" << onFiles << ") for: " << relativePath << '\n';
    } else {
      LOGE("Unknown action: " << action);
    }
  }
  return true; // stop search in subdir
}

std::unordered_set<std::string> ns_Publish::Publish::LoadIndex(std::string const& indexFilename) {
  std::unordered_set<std::string> result;
  std::ifstream indexFile(indexFilename);
  if (!indexFile.is_open()) {
    LOGW("No index file " << indexFilename << ", empty DB");
    return result;
  }
  std::string line;
  while (std::getline(indexFile, line)) {
    line.erase(0, line.find_first_not_of(" \t\r\n"));
    line.erase(line.find_last_not_of(" \t\r\n") + 1);
    if (!line.empty()) {
      result.insert(line);
    }
  }
  if (indexFile.bad()) {
    LOGE("Error reading index file " << indexFilename);
    throw std::runtime_error("Fatal error reading index file");
  }
  return result;
}

void ns_Publish::Publish::SaveIndex(std::unordered_set<std::string> indexed, std::string const& indexFilename) {
  std::string tmpName = indexFilename + ".tmp";
  std::ofstream ofs(tmpName);
  if (!ofs.is_open()) {
    LOGE("Failed to open temporary index file: " << tmpName);
    throw std::runtime_error("Fatal error cannot create temporary index file");
  }
  for(std::string const& entry: indexed) {
    ofs << entry << "\n";
  }
  ofs.close();
  if (ofs.fail()) {
    LOGE("Failed to write to temporary file: " << tmpName);
    std::filesystem::remove(tmpName);
    throw std::runtime_error("Fatal error writing index");
  }
  std::filesystem::rename(tmpName, indexFilename);
}

void ns_Publish::Publish::ProjectStorageScan(ns_Publish::Publish::Project& project) {
  try {
    int processedCount = 0;
    LOGI("Scan " << project.path_);

    for (auto const& entry : std::filesystem::recursive_directory_iterator(project.path_)) {
      if (!entry.is_regular_file()) continue;
      std::filesystem::path relativePath = std::filesystem::relative(entry.path(), project.path_);
      std::string relativeStr = relativePath.string();
      if (relativeStr[0] == '.') continue;

      for(auto& rule: project.rules_) {
        if ((rule->RegisterPath(relativeStr, entry.path())) && (!project.indexed_.HaveCachedJSON(project.outputPath_, relativeStr))) {
          LOGI("Process " << entry << " with " << rule->Name());
          std::string outFile;
          std::unordered_set<std::string> libsManaged;
          std::vector<std::filesystem::path> inData { entry };
          if (rule->Run(inData, project.outputPath_, outFile, libsManaged)) {
            std::vector<std::string> relativeInData;
            for(std::filesystem::path const& file: inData) {
              relativeInData.push_back(std::filesystem::relative(file, project.path_));
            }
            project.indexed_.Add(outFile, relativeInData, libsManaged);
            ++processedCount;
            break;
          }
        }

      }
    }
    if (processedCount > 0) {
      project.Save();
      LOGI("Processed and indexed " << processedCount << " files");
    }
  } catch (std::filesystem::filesystem_error const& e) {
    LOGE("Filesystem error during scan: " << e.what());
  } catch (std::exception const& e) {
    LOGE("Error during scan: " << e.what());
  }
}

void ns_Publish::Publish::Main() {
  std::unique_lock<std::mutex> lock(lock_);
  projects_ = ScanProjects();
  for (Project& project: projects_) {
    std::filesystem::create_directory(project.outputPath_);
    ProjectStorageScan(project);
  }
  LOGI("Initial scan done");

  while(running_) {
    threadWait_.wait_for(lock, std::chrono::seconds(1), [&](){ 
        return !running_ || !pendingNotifyFiles_.empty(); 
    });
    while(!pendingNotifyFiles_.empty()) {
      ProcessANotifyFilesRequest(lock);
    }
  }
}

void ns_Publish::Publish::ProcessANotifyFilesRequest(std::unique_lock<std::mutex>& lock) {
  struct NotifyFilesRequest request = std::move(pendingNotifyFiles_.front());
  pendingNotifyFiles_.pop();
  lock.unlock();
  std::filesystem::path const& dstPath = request.dstPath;

  std::vector<std::filesystem::path> dstFiles;
  for(auto& file: request.srcFiles) {
    dstFiles.push_back(dstPath / file.filename());
  }
  int filesStatus = 0;
  for(auto& file: dstFiles) {
    filesStatus |= std::filesystem::exists(file) ? 1 : 2;
    if (filesStatus == 3) {
      break;
    }
  }
  if (filesStatus == 3) {
    LOGE("Some files already exist in " << dstPath);
    lock.lock();
    return;
  }
  if (filesStatus == 2) {
    for(size_t i=0; i<request.srcFiles.size(); ++i) {
      std::error_code ec;
      create_directories(dstFiles[i].parent_path(), ec);
      if (!ec) {
        if ((std::filesystem::copy_file(request.srcFiles[i], dstFiles[i], ec)) && (!ec)) {
          continue;
        }
      }
      for(size_t j=0; j<i; ++j) {
        if ((!std::filesystem::remove(dstFiles[j], ec)) || ec ) {
          LOGE("Was unable to delete " << dstFiles[j]);
        }
      }
      lock.lock();
      return;
    }
  }

  struct Project* targetProject = nullptr;
  for(struct Project& project: projects_) {
    if (IsSubDir(project.path_, dstPath)) {
      targetProject = &project;
      break;
    }
  }
  if (targetProject == nullptr) {
    lock.lock();
    return;
  }
  for(auto const& entry : dstFiles)  {
    for (auto const& rule: targetProject->rules_) {
      std::filesystem::path relativePath = std::filesystem::relative(entry, targetProject->path_);
      std::string relativeStr = relativePath.string();
      if (rule->RegisterPath(relativeStr, entry)) {
        LOGI("Process " << entry << " with " << rule->Name());
        std::string outFile;
        std::unordered_set<std::string> libsManaged;
        if (rule->Process(dstFiles, targetProject->outputPath_, outFile, libsManaged)) {
          std::vector<std::string> relativeInData;
          for(std::filesystem::path const& file: dstFiles) {
            relativeInData.push_back(std::filesystem::relative(file, targetProject->path_));
          }
          lock.lock();
          targetProject->indexed_.Add(outFile, relativeInData, libsManaged);
          targetProject->Save();
          return;
        }
      }
    }
  }
  lock.lock();
}
