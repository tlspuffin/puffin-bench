#pragma once

#include <filesystem>
#include <rapidjson/document.h>
#include <unordered_map>

namespace ns_Schedule {

class Publisher {
public:
  Publisher();
  Publisher(rapidjson::Value const& config);

  void ReadJSON(rapidjson::Value const& config);
  void Publish(std::filesystem::path const& inLogs, 
      std::filesystem::path const& inArtefacts, 
      std::unordered_map<std::string, std::string> const& taskVariables);

  std::string server_;
  std::filesystem::path storage_;
  bool checkServerCertificat_;

private:
  std::string ResolveVariables(std::string const& pattern, 
      std::unordered_map<std::string, std::string> const& taskVariables);

  void PublishToServer(std::filesystem::path const& archivePath);
};

};