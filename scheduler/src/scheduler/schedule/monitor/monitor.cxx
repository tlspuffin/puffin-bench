#include "monitor.hxx"
#include "../step.hxx"
#include "../../../utils/logs.hxx"
#include <iostream>
#include <climits>
#include <unistd.h>
#include <sys/inotify.h>

ns_Monitor::Monitor::Monitor(std::filesystem::path const& path) 
    : monitorsMessage_(), stepsList_(), path_(path), lock_(), cv_(), 
    running_(false), thread_()
{
  std::error_code ec;
  if ((!std::filesystem::create_directories(path, ec)) && (ec.value() != 0)) {
    throw std::runtime_error("Unable to create monitors directories: " + path_.string());
  }
  int fd = 0;
  int wd = 0;
  InitINotify(fd, wd);
  running_ = true;
  thread_ = std::thread(&ns_Monitor::Monitor::Main, this, fd, wd);
}

ns_Monitor::Monitor::~Monitor() {
  Shutdown();
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

void ns_Monitor::Monitor::Add(std::list<ns_Schedule::Step*> steps) {
  std::lock_guard<std::mutex> lock(lock_);
  for (auto const& step : steps) {
    if (step->monitor_) {
      //LOGI("add to monitoring step: " << step->task_->id_ << " " << step->ID());
      stepsList_.insert(std::make_pair<>(step->monitor_path_.filename(), step));
    }
  }
}

void ns_Monitor::Monitor::Remove(std::list<ns_Schedule::Step*> steps) {
  {
    std::lock_guard<std::mutex> lock(lock_);
    for (auto const& step : steps) {
      if (step->monitor_) {
        //LOGI("remove from monitoring step: " << step->task_->id_ << " " << step->ID());
        stepsList_.erase(step->monitor_path_.filename());
      }
    }
  }
  for (auto const& step : steps) {
    if (step->monitor_) {
      step->message_from_run_ = GetMessage(step->monitor_path_);
      std::error_code ec;
      std::filesystem::remove(step->monitor_path_, ec);
    }
  }
}

bool ns_Monitor::Monitor::GetChange() {
  std::map<ns_Schedule::Step*, std::string> monitorsMessage;
  {
    std::lock_guard<std::mutex> lock(lock_);
    monitorsMessage.swap(monitorsMessage_);
  }
  bool haveMessage = monitorsMessage.size() > 0;
  for(auto const& [step, message] : monitorsMessage) {
    step->message_from_run_ = message;
    //LOGI(message);
  }
  return haveMessage;
}

void ns_Monitor::Monitor::Main(int fd, int wd) {
  LOGI << "Monitoring: " << path_ << Log::Flags::End;

  std::vector<char> buffer(1024 * (sizeof(struct inotify_event) + NAME_MAX + 1), 0);

  while(true) {
    ssize_t length = read(fd, buffer.data(), buffer.size());
    {
      std::unique_lock<std::mutex> lock(lock_);
      if ((!running_) || (length == 0)) {
        break;
      }
      if (length == -1) {
        if (errno == EAGAIN || errno == EWOULDBLOCK) {
          cv_.wait_for(lock, std::chrono::seconds(1));
          continue;
        } else if (errno == EINTR) {
          continue;
        } else {
          break;
        }
      }
    }

    struct SPendingUpdate {
      std::string filename;
      std::string fullfilename;
      std::string message;
    };
    std::vector<struct SPendingUpdate> pendingUpdates;

    ssize_t i = 0;
    while (i < length) {
      struct inotify_event *event = (struct inotify_event *) &buffer[i];
      if (event->len > 0) {
        if (event->mask & IN_MOVED_TO) {
          pendingUpdates.push_back({event->name, "", ""});
          //LOGI << "Step monitor updated: " << event->name << Log::Flags::End;
        }
      }
      i += sizeof(struct inotify_event) + event->len;
      if (i >= buffer.size()) {
        break;
      }
    }

    {
      std::lock_guard<std::mutex> lock(lock_);
      for(auto& [filename, fullfilename, _]: pendingUpdates) {
        auto const& it = stepsList_.find(filename);
        if (it != stepsList_.end()) {
          fullfilename = it->second->monitor_path_;
        } /*else {
          //LOGE << "Ignoring modification on " << modifiedFile << Log::Flags::End;
        }*/
      }
    }

    std::vector<std::string> activeMessages;
    for(auto& [_, fullfilename, message]: pendingUpdates) {
      if (!fullfilename.empty()) {
        message = GetMessage(fullfilename);
      }
    }

    {
      std::lock_guard<std::mutex> lock(lock_);
      for(auto const& [filename, fullfilename, message]: pendingUpdates) {
        if (fullfilename.empty()) {
          continue;
        }
        auto const& it = stepsList_.find(filename);
        if (it != stepsList_.end()) {
          monitorsMessage_[it->second] = message;
        }
      }
    }

  }

  inotify_rm_watch(fd, wd);
  close(fd);
}

void ns_Monitor::Monitor::InitINotify(int& fd, int& wd) {
  fd = inotify_init1(IN_NONBLOCK | IN_CLOEXEC);
  if (fd == -1) {
    throw std::runtime_error("Unable to init inotify");
  }

  wd = inotify_add_watch(fd, path_.c_str(), IN_MOVED_TO);
  if (wd == -1) {
    close(fd);
    throw std::runtime_error("Unable to add inotify watch on " + path_.string());
  }
}

std::string ns_Monitor::Monitor::GetMessage(std::filesystem::path const& filePath) {
  std::ifstream file(filePath);
  if (!file.is_open()) {
    LOGE << "Monitor can not extract run message from " << filePath << Log::Flags::End;
    return "";
  }
  std::ostringstream buffer;
  buffer << file.rdbuf();
  return buffer.str();
}
