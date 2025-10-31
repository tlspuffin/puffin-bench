#include "archiver.hxx"
#include "../../utils/logs.hxx"
#include <iostream>
#include <fstream>
#include <cstdlib>
#include <sstream>

ns_Schedule::Archiver::Archiver() 
  : threadRunning_(true), jobsProcessed_(0), jobsFailed_(0)
{   
  thread_ = std::thread(&Archiver::ThreadLoop, this);
}

ns_Schedule::Archiver::~Archiver() {
  {
    std::lock_guard<std::mutex> lock(queueMutex_);
    threadRunning_ = false;
  }
  queueCV_.notify_one();
    
  if (thread_.joinable()) {
    thread_.join();
  }
  LOGI("[Archiver] Shutdown - Processed: " << jobsProcessed_.load() 
      << ", Failed: " << jobsFailed_.load());
}

void ns_Schedule::Archiver::AddJob(struct ArchiveJob& job) {
  {
    std::lock_guard<std::mutex> lock(queueMutex_);
    jobs_.push(job);
  }
  queueCV_.notify_one();
  LOGI("[Archiver] Job queued: " << job.archivePath_ 
      << " (" << job.sources_.size() << " sources)");
}

size_t ns_Schedule::Archiver::PendingJobs() {
  std::lock_guard<std::mutex> lock(queueMutex_);
  return jobs_.size();
}

void ns_Schedule::Archiver::WaitForCompletion() {
  while (true) {
    size_t nbJobs = 0;
    {
      std::lock_guard<std::mutex> lock(queueMutex_);
      nbJobs = jobs_.size();
      if (nbJobs == 0) {
        break;
      }
    }
    LOGW("[Archiver] close wait " << nbJobs << "job(s)");
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
  }
}

void ns_Schedule::Archiver::ThreadLoop() {
  LOGI("[Archiver] Thread started");
  while (threadRunning_.load()) {
    ArchiveJob job;
    {
      std::unique_lock<std::mutex> lock(queueMutex_);
      queueCV_.wait(lock, [this] { return !jobs_.empty() || !threadRunning_.load(); });            
      if (!threadRunning_.load() && jobs_.empty()) {
        break;
      }
      if (!jobs_.empty()) {
        job = std::move(jobs_.front());
        jobs_.pop();
      } else {
        continue;
      }
    }
    LOGI("[Archiver] Processing: " << job.archivePath_);
    if (ProcessJob(job)) {
      jobsProcessed_++;
      LOGI("[Archiver] Success: " << job.archivePath_);

      try {
        job.publish_.PublishResults(job.variables_, job.sources_[0], { job.archivePath_ });
      } catch(std::runtime_error const& e) {
        LOGW("Error while moving resultats from save to user save storage\n" <<
            "All keep in " << job.baseDir_ << "\n\t" << e.what());
      } catch(...) {
        LOGW("Unknown Error while moving resultats from save to user save storage\n" <<
            "All keep in " << job.baseDir_);
      }

    } else {
      jobsFailed_++;
      LOGW("[Archiver] Failed: " << job.archivePath_);
    }
  }    
  LOGI("[Archiver] Thread stopped");
}

bool ns_Schedule::Archiver::ProcessJob(ArchiveJob const& job) {
  if (job.sources_.size() < 1) {
    LOGW("[Archiver] Error: required at least the task json");
    return false;
  }
  for (auto const& source : job.sources_) {
    if (!std::filesystem::exists(source)) {
      LOGW("[Archiver] Error: source not found: " << source);
      return false;
    }
  }   
  std::filesystem::path archivePath(job.archivePath_);
  if (archivePath.has_parent_path()) {
    std::error_code ec;
    std::filesystem::create_directories(archivePath.parent_path(), ec);
    if (ec) {
      LOGW("[Archiver] Error creating directory: " << ec.message());
      return false;
    }
  }

  std::ostringstream cmd;
  cmd << "tar -czf " << job.archivePath_;
  if (!job.baseDir_.empty()) {
    cmd << " -C " << job.baseDir_;
  }
  for (auto const& source : job.sources_) {
    if (job.baseDir_.empty()) {
      cmd << " " << source;
    } else {
      std::filesystem::path relativePath = std::filesystem::relative(source, job.baseDir_);
      cmd << " " << relativePath.string();
   }
  }
  cmd << " 2>&1";
  LOGI("[Archiver] Command: " << cmd.str());
    
  FILE* pipe = popen(cmd.str().c_str(), "r");
  if (!pipe) {
    LOGW("[Archiver] Error: failed to execute tar command");
    return false;
  }
  char buffer[256];
  std::string output;
  while (fgets(buffer, sizeof(buffer), pipe) != nullptr) {
    output += buffer;
  }
  int exitCode = pclose(pipe);
  if (exitCode != 0) {
    LOGW("[Archiver] tar failed with code " << exitCode << " out:" << output);
    return false;
  }

  if ((!std::filesystem::exists(job.archivePath_)) || 
      (std::filesystem::file_size(job.archivePath_) == 0)) {
    std::error_code ec;
    std::filesystem::remove(job.archivePath_, ec);
    LOGW("[Archiver] Error: archive not created");
    return false;
  }

  if (!job.deleteDir_.empty()) {
    LOGI("[Archiver] remove directory " << job.deleteDir_);
    std::error_code ec;
    std::filesystem::remove_all(job.deleteDir_, ec);
  }

  return true;
}