#include "config.hxx"
#include "../../utils/logs.hxx"
#include "../../utils/rapidjson.hxx"
#include "../../utils/dir.hxx"
#include "embeded/git_restapi/tlspuffin_history_sh.h"
#include <iostream>
#include <fstream>

ns_GIT::Config::Config()
    : scriptsPath_("repo/.scripts"), storage_("repo"), repositories_()
{}

void ns_GIT::Config::Load(std::string const& name, rapidjson::Value& doc) {
  rapidjson::Value emptyGitConfig(rapidjson::kObjectType);
  rapidjson::Value const* gitConfig = &emptyGitConfig;
  if (doc.HasMember(name.c_str()) && (doc[name.c_str()].IsObject())) {
    gitConfig = &(doc[name.c_str()]);
  }

  scriptsPath_ = GetOrDefaultPath(*gitConfig, "scripts", scriptsPath_);
  storage_ = GetOrDefaultPath(*gitConfig, "storage", storage_);

  repositories_.clear();
  if (!gitConfig->HasMember("repositories")) {
    return;
  }
  auto const& repositories = (*gitConfig)["repositories"];
  if (!repositories.IsObject()) {
    throw std::runtime_error("Configuration error " + name + "/repositories is not an object");
  }
  for(auto it = repositories.MemberBegin(); it != repositories.MemberEnd(); ++it) {
    if (!it->name.IsString()) {
      LOGW << "Ignoring invalid configuration" << Log::Flags::End;
      continue;
    }
    std::string const& name = it->name.GetString();
    if ((!(it->value.HasMember("url"))) || (!(it->value["url"].IsString()))) {
      LOGW << "Ignoring mal formed configuration " << name << Log::Flags::End;
      continue;
    }
    std::unordered_map<std::string, std::string> repos;
    if (it->value.HasMember("url_pr") && (it->value["url_pr"].IsString())) {
      repos.emplace("url_pr", it->value["url_pr"].GetString());
    }
    repos.emplace("url", it->value["url"].GetString());
    repositories_.push_back(std::make_pair<>(name, repos));
  }
}

void ns_GIT::Config::Save(std::string const& name, rapidjson::Value& doc, 
    rapidjson::MemoryPoolAllocator<>& alloc) const {
  rapidjson::Value node(rapidjson::kObjectType);
  node.AddMember("scripts", rapidjson::Value(scriptsPath_.c_str(), alloc), alloc);
  node.AddMember("storage", rapidjson::Value(storage_.c_str(), alloc), alloc);

  rapidjson::Value repositories(rapidjson::kObjectType);
  for(auto const& repository: repositories_) {
    rapidjson::Value repositoryJSON(rapidjson::kObjectType);
    std::unordered_map<std::string, std::string> const& infos = repository.second;
    repositoryJSON.AddMember("url", rapidjson::Value(infos.at("url").c_str(), alloc), alloc);
    auto const& it = infos.find("url_pr");
    if (it != infos.end()) {
      repositoryJSON.AddMember("url_pr", rapidjson::Value(it->second.c_str(), alloc), alloc);
    }
    repositories.AddMember(rapidjson::Value(repository.first.c_str(), alloc), repositoryJSON, alloc);
  }
  node.AddMember("repositories", repositories, alloc);
  doc.AddMember(rapidjson::Value(name.c_str(), alloc), node, alloc);
}

void ns_GIT::Config::Validate(bool forceInstall) const {
  auto discard = std::filesystem::canonical(storage_);
  if (IsSubDir(storage_, scriptsPath_)) {
    std::filesystem::create_directories(scriptsPath_);
  } else {
    discard = std::filesystem::canonical(scriptsPath_);
  }
  for(auto const& repository: repositories_) {
    std::string path = storage_ / repository.first;
    std::error_code ec;
    if ((!std::filesystem::create_directories(path, ec)) && ec) {
      throw std::runtime_error("Problem with folder: " + path);
    }
  }
  for(auto const& [ file, data, size ] : {
      std::tuple{ "tlspuffin_history.sh", TLSPuffinHistory_Script_data, TLSPuffinHistory_Script_size },
  }) {
    std::filesystem::path filePath = 
        std::filesystem::weakly_canonical(scriptsPath_ / file);
    if (forceInstall || (!std::filesystem::exists(filePath))) {
      LOGI << "Creating missing required file " << filePath << Log::Flags::End;
      std::ofstream ofs(filePath, std::ios::binary);
      ofs.write(data, size);
      ofs.close();
      std::filesystem::permissions(filePath,
        std::filesystem::perms::owner_all | 
        std::filesystem::perms::group_read | std::filesystem::perms::group_exec, 
        std::filesystem::perm_options::replace);
    }
  }
}
