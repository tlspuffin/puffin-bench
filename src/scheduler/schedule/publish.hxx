#pragma once

#include <filesystem>
#include <rapidjson/document.h>
#include <unordered_map>

namespace ns_Schedule {

class Publish {
public:
  Publish();
  Publish(rapidjson::Value const& config);

  void ReadJSON(rapidjson::Value const& config);
  void ToJSON(rapidjson::Value& node, rapidjson::Document::AllocatorType& alloc) const;
  void PublishResults(std::filesystem::path const& inLogs, 
      std::filesystem::path const& inArtefacts, 
      std::unordered_map<std::string, std::string> const& taskVariables);

  std::string server_;
  std::filesystem::path storage_;
  bool checkServerCertificat_;

private:
  void PublishToServer(std::filesystem::path const& archivePath);
};

};