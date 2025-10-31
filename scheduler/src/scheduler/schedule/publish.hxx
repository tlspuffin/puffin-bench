#pragma once

#include "config.hxx"
#include <vector>
#include <filesystem>
#include <rapidjson/document.h>
#include <unordered_map>

namespace ns_Schedule {

class Publish {
public:
  Publish();
  Publish(std::unordered_map<std::string, PublisherConfig> const& publishersConfig, 
      rapidjson::Value const& config);

  void ReadJSON(std::unordered_map<std::string, PublisherConfig> const& publishersConfig, 
      rapidjson::Value const& config);
  void ToJSON(rapidjson::Value& node, rapidjson::Document::AllocatorType& alloc) const;
  void PublishResults(std::unordered_map<std::string, std::string> const& taskVariables, 
      std::filesystem::path const& taskJSONfile,
      std::vector<std::filesystem::path> const& data);

  std::string server_;
  std::filesystem::path storage_;
  bool checkServerCertificat_;
  std::string goal_;

private:
  void PublishToServer(std::filesystem::path const& archivePath);
};

};