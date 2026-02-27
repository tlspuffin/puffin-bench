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
  std::string GetFilePath(std::string const& project, std::string const& file);
  std::filesystem::path Storage() const;
  std::filesystem::path HTMLStorage() const;

private:
  ns_Publish::Config const& config_;
  ns_Publish::Publish publish_;
};

inline PublishAPI::PublishAPI(ns_Publish::Config const& config) 
    : config_(config), publish_(config) {
}

inline bool PublishAPI::NotifyFiles(std::vector<std::filesystem::path>& srcPath, 
    std::filesystem::path& dstPath, std::string& error) {
  return publish_.NotifyFiles(std::move(srcPath), dstPath, error);
}

inline std::string PublishAPI::GetFilePath(std::string const& project, std::string const& file) {
  return publish_.GetFilePath(project, file);
}

inline std::filesystem::path PublishAPI::Storage() const {
  return config_.storage_;
}

inline std::filesystem::path PublishAPI::HTMLStorage() const {
  return config_.weboutput_;
}

};