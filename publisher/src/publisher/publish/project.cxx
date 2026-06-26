#include "project.hxx"
#include "../../utils/logs.hxx"
#include "../../utils/rapidjson.hxx"
#include <unordered_set>

ns_Publish::Project::Project(std::string const& projectName, std::string const& projectPath) 
    : name(projectName), path(projectPath), outputPath(path / ".project"), 
    index_(outputPath), rules_()
{
  std::filesystem::create_directory(outputPath);

  index_.Load(outputPath / ".index.json");
  LOGI << "Rules scan " << path << Log::Flags::End;
  if (!ScanRules(path)) {
    for (auto iterator = std::filesystem::recursive_directory_iterator(path);
        iterator != std::filesystem::recursive_directory_iterator();
        ++iterator) {
      if (!iterator->is_directory()) {
        continue;
      }
      std::filesystem::path currentPath = *iterator;
      if (currentPath.filename().string()[0] == '.') {
        continue;
      }
      if (ScanRules(currentPath)) {
        iterator.disable_recursion_pending();
      }
    }
  }
}

bool ns_Publish::Project::ScanStorage(bool regenCache, std::filesystem::path directory) {
  if (!directory.is_relative()) {
    return false;
  }
  try {
    if (regenCache) {
      index_.Delete(directory);
    }
    int processedCount = 0;
    LOGI << "Scan " << path << Log::Flags::End;

    for(auto it = std::filesystem::recursive_directory_iterator(path / directory);
        it != std::filesystem::recursive_directory_iterator(); ++it) {
      auto const& entry = *it;

      std::filesystem::path file = entry.path();
      std::string filename = file.filename();
      if (filename.empty() || filename[0] == '.') {
        if (entry.is_directory()) {
          it.disable_recursion_pending();
        }
        continue;
      }
      if (!entry.is_regular_file()) {
        continue;
      }

      if (filesInError_.find(file) != filesInError_.end()) {
        continue;
      }

      std::string projectRelativeStr = file.lexically_relative(path);
      if (!regenCache) {
        if (index_.HaveIndexed(projectRelativeStr)) {
          continue;
        }
      }

      for(auto const& rule: rules_) {
        if (rule->Match(projectRelativeStr)) {
          uint64_t timestamp = 0;
          std::string outFile;
          std::unordered_set<std::string> libsManaged;
          if (rule->Apply(file, outputPath, timestamp, outFile, libsManaged, !regenCache)) {
            index_.Add(outFile, timestamp, projectRelativeStr, libsManaged);
            ++processedCount;
          } else {
            filesInError_.insert(file);
          }
          break;
        }
      }
    }
    if (processedCount > 0 || regenCache) {
      index_.Save(outputPath / ".index.json");
      LOGI << "Processed and indexed " << processedCount << " files" << Log::Flags::End;
    }
  } catch (std::filesystem::filesystem_error const& e) {
    LOGE << "Filesystem error during scan: " << e.what() << Log::Flags::End;
    return false;
  } catch (std::exception const& e) {
    LOGE << "Error during storage scan: " << e.what() << Log::Flags::End;
    return false;
  }

  return true;
}

bool ns_Publish::Project::ScanFiles(std::vector<std::filesystem::path> const& files) {
  for(auto const& file: files){
    LOGD << "check - " << file << Log::Flags::End;
  }
  int processedCount = 0;
  try {
    for(auto const& file: files) {
      for(auto const& rule: rules_) {
        std::string projectRelativeStr = file.lexically_relative(path);
        if (rule->Match(projectRelativeStr)) {
          uint64_t timestamp = 0;
          std::string outFile;
          std::unordered_set<std::string> libsManaged;
          if (rule->Apply(file, outputPath, timestamp, outFile, libsManaged, true)) {
            index_.Add(outFile, timestamp, projectRelativeStr, libsManaged);
            ++processedCount;
          } else {
            filesInError_.insert(file);
          }
        }
      }
    }
    if (processedCount > 0) {
      index_.Save(outputPath / ".index.json");
      LOGI << "Processed and indexed " << processedCount << " files" << Log::Flags::End;
    }
  } catch (std::filesystem::filesystem_error const& e) {
    LOGE << "Filesystem error during scan: " << e.what() << Log::Flags::End;
    return false;
  } catch (std::exception const& e) {
    LOGE << "Error during scan: " << e.what() << Log::Flags::End;
    return false;
  }
  return true;
}

std::vector<std::string> ns_Publish::Project::ListData() {
  return index_.List();
}

std::unordered_map<std::string, std::unordered_map<std::string, std::vector<std::pair<std::string,std::string>>>> 
    ns_Publish::Project::ListCampaigns() {
  std::unordered_map<std::string, std::unordered_map<std::string, std::vector<std::pair<std::string,std::string>>>> 
      result;
  for (auto const onerule : rules_) {
    if (!onerule->IsCampaign()) {
      continue;
    }
    std::filesystem::path ruleFolder = path / onerule->DataPath();

    auto itDirectoryEnd = std::filesystem::recursive_directory_iterator();
    for(std::filesystem::recursive_directory_iterator it(ruleFolder); 
        it != itDirectoryEnd; ++it) {
      if (it->is_directory()) {
        continue;
      }
      if (!it->is_regular_file()) {
        continue;
      }
      if (it->path().extension() != ".zst") {
        continue;
      }
      std::filesystem::path id = it->path().lexically_relative(ruleFolder);
      std::ptrdiff_t const pathSize = std::distance(id.begin(), id.end());
      if (pathSize < 3) {
        continue;
      }
      auto itID = id.begin();
      std::advance(itID, pathSize - 3);
      std::string user = itID->string();
      std::string campaignName = (++itID)->string();
      std::string file = (++itID)->string();
      result[user][campaignName].push_back({file, onerule->DataPath() / id});
    }
  }
  return result;
}

bool ns_Publish::Project::DeleteData(std::string const& cacheFile) {
  bool success = index_.Remove(path, cacheFile, true);
  index_.Save(outputPath / ".index.json");
  return success;
}

bool ns_Publish::Project::ScanRules(std::filesystem::path const& rulesPath) {
  std::string rulesFile = rulesPath / ".rules";
  if (!std::filesystem::exists(rulesFile)) {
    return false;
  }
  LOGI << "Looking rules in " << rulesPath << Log::Flags::End;
  std::string const relativePath = std::filesystem::relative(rulesPath, path);

  rapidjson::Document doc;
  if (!ReadJSONFile(rulesFile, doc)) {
    throw std::runtime_error("Error while trying access "+rulesFile);
  }

  if (doc.HasMember("index") && doc["index"].IsString()) {
    std::filesystem::path indexFile = doc["index"].GetString();
    if (indexFile.is_relative() && (std::find(indexFile.begin(), indexFile.end(), "..") == indexFile.end())) {
      indexes[relativePath] = indexFile;
    } else {
      LOGW << "wrong index file \"" << indexFile << "\" in rules in  " << rulesPath << Log::Flags::End;
    }
  }

  for (auto it = doc.MemberBegin(); it != doc.MemberEnd(); ++it) {
    if (!it->name.IsString()) {
      throw std::runtime_error("Fatal error. Invalid rules file " + rulesFile);
    }
    std::string ruleName = it->name.GetString();
    if (ruleName == "index") {
      continue;
    }
    const auto& value = it->value;
    if (!value.IsObject()) {
      throw std::runtime_error("Fatal error. Invalid rules file, \"" + name + "\" is not an object in " + rulesFile);
    }
    if ((!value.HasMember("action")) || (!value["action"].IsString())) {
      throw std::runtime_error("Fatal error. Invalid rules file, \"" + name + "\" object has no action field in " + rulesFile);
    }
    if ((!value.HasMember("onFiles")) || (!value["onFiles"].IsString())) {
      throw std::runtime_error("Fatal error. Invalid rules file, \"" + name + "\" object has no onFiles field in " + rulesFile);
    }

    std::string const action = value["action"].GetString();
    std::string const onFiles = value["onFiles"].GetString();
    static rapidjson::Value const emptyObject(rapidjson::kObjectType);
    rapidjson::Value const* parameters = &emptyObject;
    if (value.HasMember("parameters")) {
      parameters = &(value["parameters"]);
    }
    std::shared_ptr<Rule> rulePtr = 
        std::shared_ptr<Rule>(Rule::Build(action, ruleName, rulesPath, relativePath, onFiles, *parameters));
    if (rulePtr) {
      rules_.push_back(rulePtr);
      LOGI << "Add rules: " << ruleName << " → " << action << " (" << onFiles << ") for: " << relativePath << Log::Flags::End;
    } else {
     throw std::runtime_error("Fatal error. Invalid rules file, \"" + ruleName + "\" object have an unknown action \"" + action + "\" in " + rulesFile);
    }
  }
  return true;
}
