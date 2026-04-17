#pragma once
#include "../../../utils/logs.hxx"
#include "../../../utils/file.hxx"
#include <cstdint>
#include <thread>
#include <unordered_map>
#include <string>
#include <vector>
#include <mutex>
#include <memory>
#include <list>
#include <cstring>

namespace ns_Executor {

class OutputBuffer {
public:
  virtual ~OutputBuffer();
  virtual bool Write(uint8_t const* data, uint64_t size) = 0;
  virtual void Read(struct FileExtractedText& data) = 0;
};

inline OutputBuffer::~OutputBuffer() {}

class FileRing : public OutputBuffer {
public:
  FileRing();
  FileRing(std::string const& file, uint64_t maxSize, int32_t nbFiles, bool mergeAtEnd);

  FileRing(FileRing const&) = delete;
  FileRing& operator=(FileRing const&) = delete;
  FileRing(FileRing&& other);
  FileRing& operator=(FileRing&& other);

  ~FileRing();
  bool Write(uint8_t const* data, uint64_t size);
  //void Read(struct FileExtractedText& data); Not used currently

private:
  std::string file_;
  uint64_t maxSize_ = 0;
  int32_t nbFiles_ = 0;
  bool mergeAtEnd_  = false;
  int fd_ = -1;
  uint64_t fileSize_ = 0;

  bool RotateFile();
  bool WriteBytes(uint8_t const* data, uint64_t size);
  bool CleanRotationFiles();
};

class MemoryRing : public OutputBuffer {
public:
  MemoryRing();
  MemoryRing(std::string const& file, uint64_t maxSize);

  MemoryRing(MemoryRing const&) = delete;
  MemoryRing& operator=(MemoryRing const&) = delete;
  MemoryRing(MemoryRing&& other);
  MemoryRing& operator=(MemoryRing&& other);

  ~MemoryRing();

  bool Write(uint8_t const* data, uint64_t size);
  void Read(struct FileExtractedText& data);
private:
  std::mutex lock_;
  std::vector<uint8_t> buffer_;
  uint64_t bufferStart_;
  uint64_t maxSize_;
  uint64_t virtualSize_;
  std::string file_;
  bool full_;
};

class FDCaptureThread {
public:
  FDCaptureThread(uint64_t nbFileDescriptor);
  ~FDCaptureThread();

  bool AddFD(int fd, OutputBuffer* outputBuffer);
  bool RemoveFD(int fd);
  bool HaveFD(int fd);

  void Read(int fd, struct FileExtractedText& data);

private:
  class FDCaptureThreadImpl {
  public:
    FDCaptureThreadImpl();
    ~FDCaptureThreadImpl();

    bool AddFD(int fd, std::shared_ptr<OutputBuffer> outputBuffer);
    bool RemoveFD(int fd);
    bool HaveFD(int fd);

    bool Load(uint64_t load);
    uint64_t Unload(uint64_t load);

  private:
    void threadMain();
    bool AddFD(int fd);
    bool RemoveFDNoLock(int fd);
    int epollID_;
    int stopFD_;
    std::mutex lockFDs_;
    std::unordered_map<int, std::shared_ptr<OutputBuffer>> fds_;
    std::thread runThread_;
    uint64_t load_;
  };
  std::shared_ptr<FDCaptureThreadImpl> thread_;
  std::unordered_map<int, std::shared_ptr<OutputBuffer>> fds_;
  std::mutex lockFDs_;
  uint64_t nbFileDescriptor_;

  static std::mutex threadsLock__;
  static std::list<std::shared_ptr<FDCaptureThreadImpl>> threadsPoll__;
};

inline bool FDCaptureThread::AddFD(int fd, OutputBuffer* outputBuffer) {
  std::shared_ptr<ns_Executor::OutputBuffer> outputBufferPtr(outputBuffer);
  {
    std::lock_guard lock((lockFDs_));
    auto result = fds_.insert({fd, outputBufferPtr});
    if (!result.second) {
      LOGE << "Unable to store fd: " << fd << " errno: " << errno << Log::Flags::End;
      return false;
    }

  }
  return thread_->AddFD(fd, outputBufferPtr);
}

inline bool FDCaptureThread::RemoveFD(int fd) {
  {
    std::lock_guard lock((lockFDs_));
    fds_.erase(fd);
  }
  return thread_->RemoveFD(fd);
}

inline bool FDCaptureThread::HaveFD(int fd) {
  return thread_->HaveFD(fd);
}

inline void FDCaptureThread::Read(int fd, struct FileExtractedText& data) {
  std::lock_guard lock((lockFDs_));
  if (auto it = fds_.find(fd); it != fds_.end()) {
    it->second->Read(data);
  }
}

};