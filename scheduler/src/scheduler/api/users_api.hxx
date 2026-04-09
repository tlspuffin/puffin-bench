#pragma once

#include "../schedule/config.hxx"
#include <filesystem>
#include <string>
#include <vector>
#include <shared_mutex>
#include "rapidjson/document.h"

namespace ns_Schedule {
  class Task;
}

namespace ns_API {

class UsersAPI {
public:
  struct TaskInfos {
    uint64_t id;
    std::string name;
    bool running;
    bool cancelled;
    std::string ToJSON() const;
  };
  UsersAPI(ns_Schedule::Config const& config);

  bool Add(ns_Schedule::Task* task, bool running);
  std::vector<std::string> Users();
  bool UserJobTypes(std::string const& user, std::vector<std::string>& result);
  bool UserTasks(std::string const& user, std::string const& jobType, 
      std::vector<struct TaskInfos>& result);

private:
  bool Save();
  std::filesystem::path const storagePath_;
  rapidjson::Document doc_;
  rapidjson::MemoryPoolAllocator<>& alloc_;
  std::shared_mutex lockDB_;
};

inline std::string UsersAPI::TaskInfos::ToJSON() const {
  return std::string(R"({"id":)") + std::to_string(id) + 
      R"(,"name":")" + name + R"(")" +
      R"(,"running":)" + (running ? "true" : "false") +
      R"(,"cancelled":)" + (cancelled ? "true" : "false") +
      "}";
}

};
