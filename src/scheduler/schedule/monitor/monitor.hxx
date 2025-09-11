#pragma once

#include "task.hxx"
#include <filesystem>
#include <memory>
#include <map>
#include <list>
#include <unordered_set>
#include <thread>
#include <mutex>
#include <condition_variable>

namespace ns_Schedule {
  class Step;
};

namespace ns_Monitor {

class Monitor {
public:
  Monitor(std::filesystem::path const& path);
  ~Monitor();

  void Shutdown();

  void Add(std::list<ns_Schedule::Step*> steps);
  void Remove(std::list<ns_Schedule::Step*> steps);
  bool GetChange();

private:
  void Main(int fd, int wd);
  void InitINotify(int& fd, int& wd);

  std::map<ns_Schedule::Step*, std::string> monitorsMessage_;
  std::map<std::string, ns_Schedule::Step*> stepsList_;

  std::filesystem::path path_;
  std::mutex lock_;
  std::condition_variable cv_;
  bool running_;
  std::thread thread_;
};

};