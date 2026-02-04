#include "files_ring.hxx"
#include "../../../utils/logs.hxx"
#include <unistd.h>
#include <fcntl.h>
#include <sys/epoll.h>
#include <sys/eventfd.h>
#include <filesystem>
#include <fstream>

ns_Executor::FileRing::FileRing() 
    : file_(), maxSize_(0), nbFiles_(0), 
    mergeAtEnd_(false), fd_(-1), fileSize_(0)
{}

ns_Executor::FileRing::FileRing(std::string const& file, uint64_t maxSize, int32_t nbFiles, bool mergeAtEnd) 
    : file_(file), maxSize_(maxSize), nbFiles_(nbFiles), 
    mergeAtEnd_(mergeAtEnd), fd_(-1), fileSize_(0)
{
  if (!CleanRotationFiles()) {
    throw std::runtime_error("Unable to clean rotation log for " + file_);
  }
  fd_ = open(file_.c_str(), O_CREAT | O_TRUNC | O_WRONLY, 0644);
  if (fd_ < 0) {
    throw std::runtime_error("Failed to open " + file_);
  }
}

ns_Executor::FileRing::FileRing(FileRing&& other)
    : file_(std::move(other.file_)), maxSize_(other.maxSize_), nbFiles_(other.nbFiles_),
    mergeAtEnd_(other.mergeAtEnd_), fd_(other.fd_), fileSize_(other.fileSize_)
{
  other.fd_ = -1;
}

ns_Executor::FileRing& ns_Executor::FileRing::operator=(FileRing&& other) {
  if (this != &other) {
    this->~FileRing();

    file_ = std::move(other.file_);
    maxSize_ = other.maxSize_;
    nbFiles_ = other.nbFiles_;
    mergeAtEnd_ = other.mergeAtEnd_;
    fd_ = other.fd_;
    fileSize_ = other.fileSize_;
        
    other.fd_ = -1;
  }
  return *this;
}

ns_Executor::FileRing::~FileRing() {
  if (fd_ == -1) {
    return;
  }
  close(fd_);
  std::string previousFile = file_ + ".0";
  if ((!mergeAtEnd_) || (nbFiles_ < 2) || !std::filesystem::exists(previousFile)) {
    return;
  }
  uint64_t currentSize = std::filesystem::file_size(file_);
  if (currentSize < maxSize_) {
    uint64_t previousSize = std::filesystem::file_size(previousFile);
    uint64_t needed = maxSize_ - currentSize;
    int64_t offset = previousSize > needed ? previousSize - needed : 0;

    std::ifstream in(previousFile, std::ios::binary);
    if (!in) {
      LOGE("Unable to open file " << previousFile);
      return;
    }
    std::string tmpFile = file_ + ".tmp";    
    std::ofstream out(tmpFile, std::ios::binary);
    if (!out) {
      LOGE("Unable to create file " << tmpFile);
      return;
    }
    in.seekg(offset);
    out << in.rdbuf();
    in.close();
    std::ifstream current(file_, std::ios::binary);
    if (!current) {
      LOGE("Unable to open file " << file_);
      return;
    }
    out << current.rdbuf();
    current.close();
    out.close();
    std::error_code ec;
    std::filesystem::rename(tmpFile, file_, ec);
    if (ec) {
      LOGE("Failed to rename " << tmpFile << " in " << file_);
    }
  }
  CleanRotationFiles();
}

bool ns_Executor::FileRing::Write(uint8_t const* data, uint64_t size) {
  uint64_t written = 0;
  while (written < size) {
    uint64_t spaceLeft = maxSize_ - fileSize_;
    if (spaceLeft == 0) {
      if (!RotateFile()) {
        return false;
      }
      spaceLeft = maxSize_;
    }
    uint64_t toWrite = std::min(size - written, spaceLeft);
    if (!WriteBytes(&data[written], toWrite)) {
      return false;
    }
    written += toWrite;
    fileSize_ += toWrite;
  }
  return true;
}

bool ns_Executor::FileRing::RotateFile() {
  close(fd_);

  std::error_code ec;
  for (int32_t i = (nbFiles_ - 3); i >= 0; --i) {
    std::string file = file_ + '.' + std::to_string(i);
    if (std::filesystem::exists(file)) {
      std::filesystem::rename(file, file_ + '.' + std::to_string(i + 1), ec);
      if (ec) {
        LOGE("Failed to rename " << file << " in " << file_ << '.' << (i+1));
      }
    }
  }
  if (nbFiles_ > 1) {
    std::filesystem::rename(file_, file_ + ".0", ec);
  }
  if (ec) {
    LOGE("Failed to rename " << file_ << " in " << file_ << ".0");
  }

  fileSize_ = 0;
  fd_ = open(file_.c_str(), O_CREAT | O_TRUNC | O_WRONLY, 0644); 
  if (fd_ < 0) {
    LOGE("Failed to open " << file_);
    return false;
  }   
  return true;
}

bool ns_Executor::FileRing::WriteBytes(uint8_t const* data, uint64_t size) {
  uint64_t written = 0;
  while (written < size) {
    ssize_t ret = write(fd_, &data[written], size - written);
    if (ret < 0) {
      if (errno == EAGAIN || errno == EINTR) {
        continue;
      }
      LOGE("Fatal error when writing on " << file_ << " errno " << errno);
      return false;
    }
    written += ret;
  }
  //fdatasync(fd_);
  return true;
}

bool ns_Executor::FileRing::CleanRotationFiles() {
  bool success = true;
  for(int32_t i=0; i<nbFiles_; ++i) {
    std::string file = file_ + '.' + std::to_string(i);
    std::error_code ec;
    std::filesystem::remove(file, ec);
    if (ec) {
      success = false;
      LOGE("Failed to remove " << file);
    }
  }
  return success;
}

ns_Executor::FilesRing::FilesRing(uint64_t maxSize) 
    : maxSize_(maxSize), epollID_(epoll_create1(EPOLL_CLOEXEC)), 
    stopFD_(eventfd(0, EFD_CLOEXEC | EFD_NONBLOCK))
{
  std::string errorMsg;
  if (epollID_ == -1) {
    errorMsg = "Fatal Error: Unable to create EPOLL";
    goto ns_Executor__FilesRing__FilesRing__Error;
  }
  if (stopFD_ == -1) {
    errorMsg = "Fatal Error: Unable to create EVENTFD";
    goto ns_Executor__FilesRing__FilesRing__Error;
  }
  if (!AddFD(stopFD_)) {
    errorMsg = "Fatal Error: Unable to start FilesRing thread";
    goto ns_Executor__FilesRing__FilesRing__Error;
  }
  runThread_ = std::thread([this]() { threadMain(); });
  return;

ns_Executor__FilesRing__FilesRing__Error:
  if (stopFD_ > -1) {
    close(stopFD_);
  }
  if (epollID_ > -1) {
    close(epollID_);
  }
  throw std::runtime_error(errorMsg);
}

ns_Executor::FilesRing::~FilesRing() {
  if (runThread_.joinable()) {
    uint64_t one = 1;
    write(stopFD_, &one, sizeof(one));
    runThread_.join();
  }
  close(stopFD_);
  close(epollID_);
}

void ns_Executor::FilesRing::UpdateConfig(uint64_t maxSize) {
  std::lock_guard<std::mutex> lock(lockFDs_);
  maxSize_ = maxSize;
}

bool ns_Executor::FilesRing::AddFD(int fd, std::string const& outFile) {
  std::lock_guard<std::mutex> lock(lockFDs_);

  std::pair<std::unordered_map<int, ns_Executor::FileRing>::iterator, bool> storage;
  storage = fds_.insert({fd, ns_Executor::FileRing{outFile, maxSize_, 2, true}});
  if (!storage.second) {
    LOGE("Unable to store fd: " << fd << " errno: " << errno);
    return false;
  }

  int flags = fcntl(fd, F_GETFL, 0);
  if (flags == -1) {
    LOGE("Unable to retrieve flags on fd: " << fd << " errno: " << errno);
    return false;
  }
  if (fcntl(fd, F_SETFL, flags | O_NONBLOCK) == -1) {
    LOGE("Unable to set O_NONBLOCK on fd: " << fd << " errno: " << errno);
    return false;
  }

  if (!AddFD(fd)) {
    fds_.erase(storage.first);
    return false;
  }
  return true;
}

bool ns_Executor::FilesRing::RemoveFD(int fd) {
  if (fd == stopFD_) {
    bool success = epoll_ctl(epollID_, EPOLL_CTL_DEL, fd, nullptr) == 0;
    close(fd);
    return success;
  }

  std::lock_guard<std::mutex> lock(lockFDs_);
  auto it = fds_.find(fd);
  if (it == fds_.end()) {
    LOGE("Unable to remove no existing fd: " << fd << " errno: " << errno);
    close(fd);
    return false;
  }
  bool success = epoll_ctl(epollID_, EPOLL_CTL_DEL, fd, nullptr) == 0;
  if (!success) {
    LOGE("Unable to remove fd: " << fd << " errno: " << errno);
  }
  fds_.erase(it);

  close(fd);
  return success;
}

void ns_Executor::FilesRing::threadMain() {
  std::vector<epoll_event> events(128);
  std::vector<uint8_t> buffers(65535);
  while(true) {
    int n = epoll_wait(epollID_, events.data(), (int)events.size(), -1);

    if (n < 0) {
      if (errno == EINTR) {
        continue;
      }
      LOGE("Fatal Error epoll_wait failed errno: " << errno);
      return;
    }

    for (int i = 0; i < n; ++i) {
      int fd = events[i].data.fd;
      if (fd == stopFD_) {
        uint64_t value;
        read(stopFD_, &value, sizeof(value));
        return;
      }

      uint32_t event = events[i].events;
      if (event & (EPOLLERR | EPOLLHUP)) {
        LOGE("Close " << fd << " for EPOLLERR | EPOLLHUP");
        RemoveFD(fd);
      } else if (event & (EPOLLIN | EPOLLPRI)) {
        std::lock_guard<std::mutex> lock(lockFDs_);
        auto it = fds_.find(fd);
        while(true) {
          ssize_t readBytes = read(fd, buffers.data(), buffers.size());
          if (readBytes > 0) {
            it->second.Write(buffers.data(), readBytes);
          } else if (readBytes == 0) {
            LOGE("Close " << fd << " for read == 0");
            RemoveFD(fd);
            break;
          } else {
            if (errno == EINTR) {
              continue;
            }
            if (errno == EAGAIN || errno == EWOULDBLOCK) {
              break;
            }
            LOGE("Fatal Error on reading on fd: " << fd);
            RemoveFD(fd);
            break;
          }
        }
      }
    }
  }
}

bool ns_Executor::FilesRing::AddFD(int fd) {
  struct epoll_event epollEvent {};
  epollEvent.events = EPOLLIN | EPOLLPRI;
  epollEvent.data.fd = fd;
  if (epoll_ctl(epollID_, EPOLL_CTL_ADD, fd, &epollEvent) != 0) {
    LOGE("Unable to add fd: " << fd << " errno: " << errno);
    return false;
  }
  return true;
}
