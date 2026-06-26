#pragma once

#include "../publish/publish.hxx"
#include <sstream>
#include <fstream>
#include <filesystem>

namespace ns_API {

class PublishAPI {
public:
  PublishAPI(ns_Publish::Config const& config);

  bool NotifyFiles(std::vector<std::filesystem::path>& srcPath, 
      std::filesystem::path& dstPath, std::string& error);
  bool ProjectListData(std::string const& projectName, std::vector<std::string>& list);  
  std::filesystem::path Storage() const;
  std::filesystem::path HTMLStorage() const;
  std::string RulesIndex(std::filesystem::path path);

  std::unordered_map<std::string, std::unordered_map<std::string, std::vector<std::pair<std::string,std::string>>>> 
      ProjectListCampaigns(std::string const& projectName);

  bool RegenerateDataCache(std::string const& projectName, std::string const& directory);
  bool DeleteData(std::string const& projectName, std::string const& cacheFile);

private:
  ns_Publish::Config const& config_;
  ns_Publish::Publish publish_;
};

inline PublishAPI::PublishAPI(ns_Publish::Config const& config) 
    : config_(config), publish_(config) {
}

inline bool PublishAPI::NotifyFiles(std::vector<std::filesystem::path>& srcPath, 
    std::filesystem::path& dstPath, std::string& error) {
  return publish_.NotifyFiles(srcPath, dstPath, error);
}

inline bool PublishAPI::ProjectListData(std::string const& projectName, 
    std::vector<std::string>& list) {
  return publish_.ProjectListData(projectName, list);
}

inline std::filesystem::path PublishAPI::Storage() const {
  return config_.storage_;
}

inline std::filesystem::path PublishAPI::HTMLStorage() const {
  return config_.html_;
}

inline std::string PublishAPI::RulesIndex(std::filesystem::path path) {
  return publish_.RulesIndex(path);
}

inline std::unordered_map<std::string, std::unordered_map<std::string, std::vector<std::pair<std::string,std::string>>>> 
    PublishAPI::ProjectListCampaigns(std::string const& projectName) {
  return publish_.ProjectListCampaigns(projectName);
}

inline bool PublishAPI::RegenerateDataCache(std::string const& projectName, std::string const& directory) {
  return publish_.RegenerateDataCache(projectName, directory);
}

inline bool PublishAPI::DeleteData(std::string const& projectName, std::string const& cacheFile) {
  return publish_.DeleteData(projectName, cacheFile);
}


};