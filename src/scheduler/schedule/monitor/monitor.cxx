#include "monitor.hxx"

ns_Monitor::Monitor::Monitor(std::filesystem::path const& toolsPath, 
    size_t poolSize) : tasks_(), runningTask_(), lock_(), cv_(), 
    running_(true), thread_(&ns_Monitor::Monitor::Main, this)
{
  std::lock_guard<std::mutex> lock(lock_);
  for(size_t i=0; i<poolSize; ++i) {
    threadsPool_.emplace(std::make_unique<Thread>(*this, toolsPath / "monitoring.sh"));
  }
}

ns_Monitor::Monitor::~Monitor() {
  Shutdown();
}

void ns_Monitor::Monitor::Add(std::shared_ptr<Task>& task) {
  std::lock_guard<std::mutex> lock(lock_);
  if (task->thread) {
    throw std::runtime_error("Monitor task can not be added, already running");
  }
  task->CreateExecutionTime();
  auto [it, success] = tasks_.insert(task);
  if (!success) {
    throw std::runtime_error("Monitor task can not be added, already monitored");
  }
  cv_.notify_one();
}

void ns_Monitor::Monitor::Remove(std::shared_ptr<Task>& task) {
  std::lock_guard<std::mutex> lock(lock_);
  if (tasks_.erase(task) == 0) {
    if (runningTask_.erase(task) == 0) {
      //throw std::runtime_error("Monitor task is not planned");
      // may try remove a 1 shoot monitor
      return;
    }
    task->thread->KillTask();
    threadsPool_.push(std::move(task->thread));
  }
  cv_.notify_one();
}

void ns_Monitor::Monitor::Shutdown() {
  lock_.lock();
  if (running_) {
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

void ns_Monitor::Monitor::TaskDone(std::shared_ptr<ns_Monitor::Task>& task) {
  std::lock_guard<std::mutex> lock(lock_);
  if (!task->thread) {
    throw std::runtime_error("Monitor trying to manage the end of a not running task");
  }
  if (runningTask_.erase(task) != 1) {
    throw std::runtime_error("Monitor trying to manage the end of an unplanned task");
  }
  threadsPool_.push(std::move(task->thread));
  if (task->UpdateExecutionTime()) {
    tasks_.insert(task);
  }
  cv_.notify_one();
}

void ns_Monitor::Monitor::Main() {
  std::unique_lock<std::mutex> lock(lock_);
  while(running_) {
    if (tasks_.empty()) {
      cv_.wait(lock);
    } else {
      cv_.wait_until(lock, (*(tasks_.begin()))->executionTime);
    }

    while ((!threadsPool_.empty()) && ((!tasks_.empty()) && 
        (std::chrono::steady_clock::now() >= (*(tasks_.begin()))->executionTime))) {

      std::shared_ptr<Task> task = *(tasks_.begin());
      tasks_.erase(tasks_.begin());

      task->thread = std::move(threadsPool_.top());
      threadsPool_.pop();

      task->thread->Do(task);

      runningTask_.insert(task);
    }
  }
}