#pragma once
#include <cstdint>
#include <string>
#include <filesystem>
#include <rapidjson/document.h>

namespace ns_Server {

struct Config {
  uint16_t port_;
  bool secure_;
  std::string hostname_;
  std::filesystem::path key_;
  std::filesystem::path cert_;
  std::filesystem::path CA_;
  std::filesystem::path html_;
  std::string apiURL_;
  // HTTP serving limits. With Poco's defaults (16 worker threads, unlimited keep-alive
  // requests, 15 s keep-alive idle) each open browser connection holds a thread: past 16,
  // a request waits for a held connection to idle out (up to 15 s), past 64 queued it is
  // refused.
  uint16_t maxThreads_;
  uint16_t maxQueued_;
  uint16_t keepAliveTimeout_;
  uint16_t maxKeepAliveRequests_;

  Config();
  void Load(std::string const& name, rapidjson::Value& doc);
  void Save(std::string const& name, rapidjson::Value& doc, 
      rapidjson::MemoryPoolAllocator<>& alloc) const;
  void Validate(bool forceInstall) const;
};

};