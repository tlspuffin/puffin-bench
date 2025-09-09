#pragma once

#include "task.hxx"
#include <memory>
#include <thread>
#include <mutex>
#include <condition_variable>
#include <filesystem>

namespace ns_Monitor {

class ITaskDone {
public:
  virtual ~ITaskDone();
  virtual void TaskDone(std::shared_ptr<Task>& task) = 0;
};

inline ITaskDone::~ITaskDone() {};

class Thread {
public:
  Thread(ITaskDone& callbackDone, std::filesystem::path const& launcherPath);
  ~Thread();

  void Do(std::shared_ptr<Task>& task);
  void KillTask();
  void Shutdown();

  bool IsManagingTask();
  int TaskExitStatus();

private:
  void Main();

  ITaskDone& callbackDone_;
  std::filesystem::path const launcherScript_;
  std::thread thread_;
  std::mutex lock_;
  std::condition_variable cv_;
  bool running_;
  std::shared_ptr<Task> task_;
  pid_t taskPID_;
  int status_;

  static void EndProcess(pid_t pid);
};

inline bool ns_Monitor::Thread::IsManagingTask() {
  std::lock_guard lock(lock_);
  return status_ == 0xff00;
}

inline int ns_Monitor::Thread::TaskExitStatus() {
  std::lock_guard lock(lock_);
  return status_;
}

};