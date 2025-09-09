#pragma once

#include "task.hxx"
#include "thread.hxx"
#include <filesystem>
#include <memory>
#include <set>
#include <unordered_set>
#include <stack>
#include <vector>
#include <thread>
#include <mutex>
#include <condition_variable>

namespace ns_Monitor {

class Monitor : public ITaskDone {
public:
  Monitor(std::filesystem::path const& toolsPath, size_t poolSize);
  ~Monitor();

  void Add(std::shared_ptr<Task>& task);
  void Remove(std::shared_ptr<Task>& task);
  void Shutdown();

  void TaskDone(std::shared_ptr<Task>& task);

private:
  void Main();

  std::set<std::shared_ptr<Task>, Task::SharedPtrTaskCompare> tasks_;
  std::unordered_set<std::shared_ptr<Task>> runningTask_;
  std::stack<std::unique_ptr<Thread>> threadsPool_;
  std::mutex lock_;
  std::condition_variable cv_;

  bool running_;
  std::thread thread_;
};

};