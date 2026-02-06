#pragma once

#include "config.hxx"
#include "publish_action.hxx"
#include <filesystem>
#include <unordered_map>
#include <unordered_set>
#include <vector>
#include <memory>

namespace ns_Publish {

class Publish {
public:
  Publish(Config const& config);

  bool Notify(std::string const& newPath, std::string& error) { return true; };
  bool NotifyFile(std::string const& srcPath, std::string const& dstPath, std::string& error);

private:
  struct Project {
    std::filesystem::path path_;
    std::filesystem::path outputPath_;
    std::unordered_set<std::string> indexed_;
    std::vector<std::shared_ptr<PublishAction>> rules_;
  };

  Config config_;
  std::unordered_set<std::string> indexed_;
  std::vector<Project> projects_;

  std::vector<Project> ScanProjects();
  std::unordered_set<std::string> LoadIndex(std::string const& indexFilename);
  void SaveIndex(std::unordered_set<std::string> indexed, std::string const& indexFilename);

  void ProjectStorageScan(Project& project);
};

}