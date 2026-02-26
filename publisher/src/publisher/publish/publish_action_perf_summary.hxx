#pragma once
#include "publish_action.hxx"

namespace ns_Publish {

class PublishActionPerfUseSummary : public PublishAction {
public:
  PublishActionPerfUseSummary() : PublishAction() {}
  PublishActionPerfUseSummary(std::string const& basePath, 
      std::string const& relativePath, std::string const& name, 
      std::string const& filesFilter) 
      : PublishAction(basePath, relativePath, name, filesFilter) {}
  bool GenerateCommitJson(std::vector<std::filesystem::path>& inputFiles, 
      std::filesystem::path const& outputPath, std::string& outFile, 
      std::unordered_set<std::string>& libsManaged);
  bool Run(std::vector<std::filesystem::path>& inputFiles, std::filesystem::path const& outputPath, 
      std::string& outFile, std::unordered_set<std::string>& libsManaged) {
    outFile = "";
    libsManaged.clear();
    if (targets_.find(inputFiles.back()) == targets_.end()) {
      return false;
    }
    return GenerateCommitJson(inputFiles, outputPath, outFile, libsManaged);
  };
};

};