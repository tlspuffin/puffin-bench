#pragma once

#include "rule.hxx"
#include "index.hxx"
#include <string>
#include <filesystem>
#include <vector>

namespace ns_Publish {

class Project {
public:
  std::string const name;
  std::filesystem::path const path;
  std::filesystem::path const outputPath;
  std::unordered_map<std::filesystem::path, std::string> indexes;

  Project(std::string const& projectName, std::string const& projectPath);
  bool ScanStorage();
  bool ScanFiles(std::vector<std::filesystem::path> const& files);
  std::vector<std::string> ListData();

  std::unordered_map<std::string, std::unordered_map<std::string, std::vector<std::pair<std::string,std::string>>>> 
      ListCampaigns();

private:
  Index index_;
  std::vector<std::shared_ptr<Rule>> rules_;
  bool ScanRules(std::filesystem::path const& rulesPath);
  std::unordered_set<std::string> filesInError_;
};

};
