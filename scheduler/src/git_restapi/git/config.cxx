#include "config.hxx"
#include "../../utils/rapidjson.hxx"
#include "../../embeded/git_restapi/tlspuffin_history_sh.h"
#include <iostream>
#include <fstream>

ns_GIT::Config::Config(std::filesystem::path const& tmpStorage)
    : scriptsPath_(tmpStorage), storage_(tmpStorage), repositories_(), 
      tmpStorage_(tmpStorage)
{}

void ns_GIT::Config::Load(std::string const& name, rapidjson::Value& doc) {
  rapidjson::Value emptyGitConfig(rapidjson::kObjectType);
  rapidjson::Value const* gitConfig = &emptyGitConfig;
  if (doc.HasMember(name.c_str()) && (doc[name.c_str()].IsObject())) {
    gitConfig = &(doc[name.c_str()]);
  }

  scriptsPath_ = GetOrDefaultPath(*gitConfig, "scripts", tmpStorage_);
  storage_ = GetOrDefaultPath(*gitConfig, "storage", tmpStorage_);
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
      std::cerr << "Ignoring invalid configuration" << std::endl;
      continue;
    }
    std::string const& name = it->name.GetString();
    if ((!(it->value.HasMember("url"))) || (!(it->value["url"].IsString()))) {
      std::cerr << "Ignoring mal formed configuration " << name << std::endl;
      continue;
    }
    std::string const& url = it->value["url"].GetString();
    repositories_.push_back(std::make_pair<>(name, url));
  }
}

void ns_GIT::Config::Save(std::string const& name, rapidjson::Value& doc, 
    rapidjson::MemoryPoolAllocator<>& alloc) const {
  rapidjson::Value node(rapidjson::kObjectType);
  node.AddMember("storage", rapidjson::Value(storage_.c_str(), alloc), alloc);

  rapidjson::Value repositories(rapidjson::kObjectType);
  for(auto const& repository: repositories_) {
    rapidjson::Value repositoryJSON(rapidjson::kObjectType);
    repositoryJSON.AddMember("url", rapidjson::Value(repository.second.c_str(), alloc), alloc);
    repositories.AddMember(rapidjson::Value(repository.first.c_str(), alloc), repositoryJSON, alloc);
  }
  node.AddMember("repositories", repositories, alloc);
  doc.AddMember(rapidjson::Value(name.c_str(), alloc), node, alloc);
}

void ns_GIT::Config::Validate(bool forceInstall) const {
  auto discard = std::filesystem::canonical(scriptsPath_);
  discard = std::filesystem::canonical(storage_);
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
      std::cerr << "Creating missing required file " << filePath << std::endl;
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