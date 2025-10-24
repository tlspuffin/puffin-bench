#include "publish.hxx"
#include "../../utils/logs.hxx"
#include "../../utils/rapidjson.hxx"
#include <fstream>

ns_Publish::Publish::Publish(Config const& config)
    : config_(config) {
  std::vector<Project> projects = ScanProjects();
  for (Project& project: projects) {
    project.outputPath_ = project.path_ / "JSON";
    std::filesystem::create_directory(project.outputPath_);
    ProjectStorageScan(project);
  }
}

std::vector<ns_Publish::Publish::Project> ns_Publish::Publish::ScanProjects() {
  std::vector<ns_Publish::Publish::Project> projects;

  std::unordered_set<std::string> filtredProjects { ".html", "Z" };
  try {
    for (auto iterator = std::filesystem::recursive_directory_iterator(config_.storage_);
        iterator != std::filesystem::recursive_directory_iterator();
        ++iterator) {
      if (!iterator->is_directory()) continue;
      iterator.disable_recursion_pending();
      std::string folderName = std::filesystem::relative(*iterator, config_.storage_);
      if (filtredProjects.find(folderName) != filtredProjects.end()) {
        continue;
      }
      Project project;
      project.path_ = *iterator;
      projects.push_back(project);
    }
  } catch (std::filesystem::filesystem_error const& e) {
    LOGE("Filesystem error during projects scan: " << e.what());
  } catch (std::exception const& e) {
    LOGE("Error during projects scan: " << e.what());
  }

  for(auto& project : projects) {
    for (auto iterator = std::filesystem::recursive_directory_iterator(project.path_);
        iterator != std::filesystem::recursive_directory_iterator();
        ++iterator) {
      if (!iterator->is_directory()) continue;
      if (std::filesystem::exists(iterator->path() / ".rules")) {
        LOGW("Rules in " << *iterator);
        iterator.disable_recursion_pending();

        rapidjson::Document doc;
        ReadJSONFile(iterator->path() / ".rules", doc);
        for (auto it = doc.MemberBegin(); it != doc.MemberEnd(); ++it) {
          const auto& value = it->value;
          if (!value.IsObject()) continue;

          const std::string name = it->name.GetString();
          const std::string action = value["action"].GetString();
          const std::string onFiles = value["onFiles"].GetString();

          std::shared_ptr<PublishAction> actionPtr = std::shared_ptr<PublishAction>(PublishAction::Build(action, name, onFiles));
          if (!actionPtr) {
            LOGE("Unknown action: " << action);
            continue;
          }
          project.rules_.push_back(actionPtr);
          std::cout << "Add rules de la règle: " << name << " → " << action << " (" << onFiles << ")\n";
        }
      }
    }
  }

  return projects;
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
  std::filesystem::path indexPath = project.path_ / ".index";
  project.indexed_ = LoadIndex(indexPath);

  int processedCount = 0;
  try {
    for (auto const& entry : std::filesystem::recursive_directory_iterator(project.path_)) {
      if (!entry.is_regular_file()) continue;
      std::filesystem::path relativePath = std::filesystem::relative(entry.path(), project.path_);
      std::string relativeStr = relativePath.string();

      for(auto& rule: project.rules_) {
        if (rule->RegisterPath(relativeStr, entry.path())) {
          if (project.indexed_.find(relativeStr) == project.indexed_.end()) {
            LOGI("Process " << entry);
            if (rule->Run(entry.path(), project.outputPath_)) {
              project.indexed_.insert(relativeStr);
              ++processedCount;
            }
          }
          break;
        }
      }
    }
    if (processedCount > 0) {
      SaveIndex(project.indexed_, indexPath);
      LOGI("Processed and indexed " << processedCount << " files");
    }
  } catch (std::filesystem::filesystem_error const& e) {
    LOGE("Filesystem error during scan: " << e.what());
  } catch (std::exception const& e) {
    LOGE("Error during scan: " << e.what());
  }
}
