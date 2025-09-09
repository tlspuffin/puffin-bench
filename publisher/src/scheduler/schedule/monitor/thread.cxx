#include "thread.hxx"
#include <vector>
#include <string.h>
#include <sys/wait.h>

ns_Monitor::Thread::Thread(ITaskDone& callbackDone, std::filesystem::path const& launcherScript) 
    : callbackDone_(callbackDone), launcherScript_(launcherScript), running_(true), 
    thread_(&Thread::Main, this), taskPID_(0)
{
}

ns_Monitor::Thread::~Thread() {
  Shutdown();
}

void ns_Monitor::Thread::Do(std::shared_ptr<Task>& task) {
  std::lock_guard lock(lock_);
  if (task_) {
    throw std::runtime_error("Thread alread having a monitor task");
  }
  task_ = task;
  cv_.notify_one();
}

void ns_Monitor::Thread::KillTask() {
  std::lock_guard lock(lock_);
  if (taskPID_ != 0) {
    EndProcess(taskPID_);
  }
}

void ns_Monitor::Thread::Shutdown() {
  lock_.lock();
  if (running_) {
    if (taskPID_ != 0) {
      EndProcess(taskPID_);
    }
    running_ = false;
    cv_.notify_one();
    lock_.unlock();
    if (thread_.joinable()) {
      thread_.join();
    }
  } else {
    lock_.unlock();
  }
}

void ns_Monitor::Thread::Main() {
  std::unique_lock<std::mutex> lock(lock_);
  while (running_) {
    cv_.wait(lock);
    if (!running_) {
      continue;
    }
    status_ = 0xff00;
    lock.unlock();

    int status = 0;
    taskPID_ = fork();
    if (taskPID_ == 0) {
      std::filesystem::current_path(task_->rootPath);
      std::vector<char*> arguments;
      arguments.push_back(strdup(launcherScript_.c_str()));
      arguments.push_back(strdup(task_->moduleFile.c_str()));
      arguments.push_back(strdup(task_->entryPoint.c_str()));
      arguments.push_back(strdup(task_->monitorFile.c_str()));
      arguments.push_back(nullptr);
      execv(launcherScript_.c_str(), arguments.data());
      _exit(127);
    } else if (taskPID_ > 0) {
      uint64_t nbWait = 0;
      while(true) {
        lock.lock();
        if ((task_->timeoutS > 0) && (nbWait >= task_->timeoutS)) {
          EndProcess(taskPID_);
        }
        pid_t retval = waitpid(taskPID_, &status, WNOHANG);
        if ((retval == taskPID_) || ((retval == -1) && (errno != EINTR))) {
          callbackDone_.TaskDone(task_);
          taskPID_ = 0;
          break;
        }
        lock.unlock();
        std::this_thread::sleep_for(std::chrono::seconds(1));
        nbWait++;
      }
    } else {
      lock.lock();
      status = 0x0100;
    }

    status_ = status;
    task_.reset();
  }
  lock.unlock();
}

void ns_Monitor::Thread::EndProcess(pid_t pid) {
  kill(pid, SIGHUP);
  std::this_thread::sleep_for(std::chrono::seconds(1));
  for(int sig: std::vector<int>{SIGTERM, SIGKILL}) {
    if (kill(pid, 0) != 0) {
      break;
    }
    std::this_thread::sleep_for(std::chrono::seconds(4));
    kill(pid, sig);
  }
}