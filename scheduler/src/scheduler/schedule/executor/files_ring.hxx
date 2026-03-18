#pragma once
#include <cstdint>
#include <thread>
#include <unordered_map>
#include <string>
#include <vector>
#include <mutex>

namespace ns_Executor {

class FileRing {
public:
  FileRing();
  FileRing(std::string const& file, uint64_t maxSize, int32_t nbFiles, bool mergeAtEnd);

  FileRing(FileRing const&) = delete;
  FileRing& operator=(FileRing const&) = delete;
  FileRing(FileRing&& other);
  FileRing& operator=(FileRing&& other);

  ~FileRing();
  bool Write(uint8_t const* data, uint64_t size);

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

class FilesRing {
public:
  FilesRing(uint64_t maxSize);
  ~FilesRing();

  void UpdateConfig(uint64_t maxSize);
  bool AddFD(int fd, std::string const& outFile);
  bool RemoveFD(int fd);

private:
  uint64_t maxSize_ = 0;
  std::thread runThread_;
  int epollID_;
  int stopFD_;
  std::mutex lockFDs_;
  std::unordered_map<int, FileRing> fds_;

  void threadMain();
  bool AddFD(int fd);
  bool RemoveFDNoLock(int fd);
};

};