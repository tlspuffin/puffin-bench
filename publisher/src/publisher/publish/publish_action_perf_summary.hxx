#pragma once
#include "publish_action.hxx"

namespace ns_Publish {

class PublishActionPerfUseSummary : public PublishAction {
public:
  PublishActionPerfUseSummary() : PublishAction() {}
  PublishActionPerfUseSummary(std::string const& basePath, 
      std::string const& relativePath, std::string const& name, 
      std::string const& filesFilter, std::string const& finalTrigger) 
      : PublishAction(basePath, relativePath, name, filesFilter, finalTrigger) {}
  bool GenerateCommitJson(std::string const& taskDataFile, 
      std::filesystem::path const& outputPath, std::string& outFile, 
      std::unordered_set<std::string>& libsManaged);
  bool CheckRule(std::vector<std::filesystem::path>& inputFiles);
  bool Process(std::vector<std::filesystem::path> const& inputFiles, 
      std::filesystem::path const& outputPath, std::string& outFile, 
      std::unordered_set<std::string>& libsManaged);
};

inline bool PublishActionPerfUseSummary::CheckRule(std::vector<std::filesystem::path>& inputFiles) {
  return true;
}

inline bool PublishActionPerfUseSummary::Process(std::vector<std::filesystem::path> const& inputFiles, 
    std::filesystem::path const& outputPath, std::string& outFile, 
    std::unordered_set<std::string>& libsManaged) {
  if (inputFiles.empty()) {
    return false;
  }
  std::filesystem::path taskDataFile = inputFiles.back();
  return taskDataFile.extension() == ".tgz" && 
      GenerateCommitJson(taskDataFile, outputPath, outFile, libsManaged);

}

};
