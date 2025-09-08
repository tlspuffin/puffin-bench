#pragma once

#include "../publish/publish.hxx"
#include <sstream>
#include <fstream>
#include <mutex>
#include <filesystem>

namespace ns_API {

class PublishAPI {
public:
  PublishAPI(ns_Publish::Config const& config);

  bool Notify(std::string const& path, std::string& error);
  std::filesystem::path Storage() const;

private:
  ns_Publish::Config const& config_;
  ns_Publish::Publish publish_;
  std::mutex lockNotify_;
};

inline PublishAPI::PublishAPI(ns_Publish::Config const& config) 
    : config_(config), publish_(config) {
}

inline bool PublishAPI::Notify(std::string const& path, std::string& error) {
  std::lock_guard<std::mutex> lock(lockNotify_);
  return publish_.Notify(path, error);
}

inline std::filesystem::path PublishAPI::Storage() const {
  return config_.storage_;
}

};