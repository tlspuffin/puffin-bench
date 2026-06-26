#pragma once

#include "../schedule/config.hxx"
#include <filesystem>
#include <string>
#include <vector>
#include <mutex>
#include <shared_mutex>
#include "rapidjson/document.h"

namespace ns_Schedule {
  class Task;
}

namespace ns_API {

class UsersAPI {
public:
  UsersAPI(ns_Schedule::Config const& config);

  bool Add(ns_Schedule::Task* task, bool running);
  std::vector<std::string> Users();
  bool UserJobTypes(std::string const& user, std::vector<std::string>& result);
  bool UserTasks(std::string const& user, std::string const& jobType, 
      rapidjson::Value& result, rapidjson::Document::AllocatorType& alloc);

private:
  bool Save();
  bool SaveNoLock();
  std::filesystem::path const storagePath_;
  rapidjson::Document doc_;
  rapidjson::MemoryPoolAllocator<>& alloc_;
  std::shared_mutex lockDB_;
};

inline bool UsersAPI::Save() {
  std::unique_lock lock(lockDB_);
  return SaveNoLock();
}

};
