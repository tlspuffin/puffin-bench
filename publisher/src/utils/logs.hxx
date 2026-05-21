#pragma once
#include <cstdint>
#include <string>
#include <filesystem>
#include <iostream>
#include <memory>
#include <mutex>
#include <thread>

class Log {
public:
  enum class Flags { End };
  Log() {}
  virtual ~Log() {}
  virtual Log& operator <<(std::string const& msg) { return *this; }
  virtual Log& operator <<(char const* msg) { return *this; }
  virtual Log& operator <<(uint64_t const msg) { return *this; }
  virtual Log& operator <<(int64_t const msg) { return *this; }
  virtual Log& operator <<(uint32_t const msg) { return *this; }
  virtual Log& operator <<(int32_t const msg) { return *this; }
  virtual Log& operator <<(uint16_t const msg) { return *this; }
  virtual Log& operator <<(int16_t const msg) { return *this; }
  virtual Log& operator <<(uint8_t const msg) { return *this; }
  virtual Log& operator <<(int8_t const msg) { return *this; }
  virtual Log& operator <<(std::filesystem::path const msg) { return *this; }

  virtual Log& operator <<(enum Flags const flag) { return *this; }
};

class LogInstance : public Log {
public:
  LogInstance(std::ostream& out, std::mutex& outLock, std::string const& beginMark);
  Log& operator <<(char const* msg);
  Log& operator <<(std::string const& msg);
  Log& operator <<(uint64_t const msg);
  Log& operator <<(int64_t const msg);
  Log& operator <<(uint32_t const msg);
  Log& operator <<(int32_t const msg);
  Log& operator <<(uint16_t const msg);
  Log& operator <<(int16_t const msg);
  Log& operator <<(uint8_t const msg);
  Log& operator <<(int8_t const msg);
  Log& operator <<(std::filesystem::path const msg);

  Log& operator <<(enum Log::Flags const flag);
private:
  std::string const beginMark_;
  std::ostream& out_;
  std::mutex& lock_;

  std::mutex lockCheck_;
  std::thread::id locktid_;

  bool begin_;
  void MarkIfBegin();
};

inline LogInstance::LogInstance(std::ostream& out, std::mutex& outLock, std::string const& beginMark) 
    : beginMark_(beginMark), out_(out), lock_(outLock), begin_(true) {}

inline Log& LogInstance::operator <<(char const* msg) {
  MarkIfBegin();
  out_ << msg;
  return *this;
}

inline Log& LogInstance::operator <<(std::string const& msg) {
  MarkIfBegin();
  out_ << msg;
  return *this;
}

inline Log& LogInstance::operator <<(uint64_t const msg) {
  MarkIfBegin();
  out_ << msg;
  return *this;
}

inline Log& LogInstance::operator <<(int64_t const msg) {
  MarkIfBegin();
  out_ << msg;
  return *this;
}

inline Log& LogInstance::operator <<(uint32_t const msg) {
  MarkIfBegin();
  out_ << msg;
  return *this;
}

inline Log& LogInstance::operator <<(int32_t const msg) {
  MarkIfBegin();
  out_ << msg;
  return *this;
}

inline Log& LogInstance::operator <<(uint16_t const msg) {
  MarkIfBegin();
  out_ << msg;
  return *this;
}

inline Log& LogInstance::operator <<(int16_t const msg) {
  MarkIfBegin();
  out_ << msg;
  return *this;
}

inline Log& LogInstance::operator <<(uint8_t const msg) {
  MarkIfBegin();
  out_ << msg;
  return *this;
}

inline Log& LogInstance::operator <<(int8_t const msg) {
  MarkIfBegin();
  out_ << msg;
  return *this;
}

inline Log& LogInstance::operator <<(std::filesystem::path const msg) {
  MarkIfBegin();
  out_ << msg;
  return *this;
}

inline Log& LogInstance::operator <<(enum Log::Flags const flag) {
  MarkIfBegin();
  out_ << std::endl;
  begin_ = true;
  lock_.unlock();
  return *this;
}

inline void LogInstance::MarkIfBegin() {
  std::thread::id tid = std::this_thread::get_id();
  while(true) {
    {
      std::lock_guard lock(lockCheck_);
      if ((locktid_ == tid) && (!begin_)) {
        break;
      } else if (begin_) {
        locktid_ = tid;
        lock_.lock();
        out_ << beginMark_;
        begin_ = false;
        break;
      }
    }
    lock_.lock();
    lock_.unlock();
  }
}

class Logs {
public:
  struct sLevel {
    uint8_t error:1;
    uint8_t warning:1;
    uint8_t info:1;
    uint8_t debug:1;
  };
  Logs();
  void SetLevel(struct sLevel logsLevel);
  void SetLevel(unsigned int logsLevel);
  unsigned int GetLevel();
  Log& a();
  Log& e();
  Log& w();
  Log& i();
  Log& d();

  struct sLevel logsLevel_;
private:
  LogInstance a_;
  std::shared_ptr<Log> e_;
  std::shared_ptr<Log> w_;
  std::shared_ptr<Log> i_;
  std::shared_ptr<Log> d_;
};

inline Log& Logs::a() {
  return a_;
}

inline Log& Logs::e() {
  return *e_;
}

inline Log& Logs::w() {
  return *w_;
}

inline Log& Logs::i() {
  return *i_;
}

inline Log& Logs::d() {
  return *d_;
}

extern Logs logs;

#define LOGA logs.a()
#define LOGE if (!logs.logsLevel_.error) {} else logs.e()
#define LOGW if (!logs.logsLevel_.warning) {} else logs.w()
#define LOGI if (!logs.logsLevel_.info) {} else logs.i()
#define LOGD if (!logs.logsLevel_.debug) {} else logs.d()
