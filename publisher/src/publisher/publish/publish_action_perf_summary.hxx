#pragma once
#include "publish_action.hxx"
#include "../analyze/generate_perf_zst.hxx"
#include "../../utils/logs.hxx"
#include <fstream>

namespace ns_Publish {

class PublishActionPerfUseSummary : public PublishAction {
public:
  PublishActionPerfUseSummary() : PublishAction() {}
  PublishActionPerfUseSummary(std::string const& basePath, 
      std::string const& relativePath, std::string const& name, 
      std::string const& filesFilter, std::string const& finalTrigger) 
      : PublishAction(basePath, relativePath, name, filesFilter, finalTrigger) {}
  bool CopyRemote() const;
  bool GenerateCommitJson(std::string const& taskDataFile, 
      std::filesystem::path const& outputPath, std::string& outFile, 
      std::unordered_set<std::string>& libsManaged, std::string& taskJSON);
  bool CheckRule(std::vector<File>& inputFiles);
  bool Process(std::vector<File> const& inputFiles, 
      std::filesystem::path const& destPath, std::filesystem::path const& outputPath, 
      std::string& outFile, std::unordered_set<std::string>& libsManaged);
};

inline bool PublishActionPerfUseSummary::CopyRemote() const {
  return false;
}

inline bool PublishActionPerfUseSummary::CheckRule(std::vector<File>& inputFiles) {
  return true;
}

};
