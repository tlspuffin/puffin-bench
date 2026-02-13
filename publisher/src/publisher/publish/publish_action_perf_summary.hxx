#pragma once
#include "publish_action.hxx"

namespace ns_Publish {

class PublishActionPerfUseSummary : public PublishAction {
public:
  PublishActionPerfUseSummary() : PublishAction() {}
  PublishActionPerfUseSummary(std::string const& relativePath, std::string const& name, 
      std::string const& filesFilter) : PublishAction(relativePath, name, filesFilter) {}
  bool GenerateCommitJson(std::filesystem::path const& inputFile, 
      std::filesystem::path const& outputPath, std::string& outFile, 
      std::unordered_set<std::string>& libsManaged);
  bool Run(std::filesystem::path const& inputPath, std::filesystem::path const& outputPath, 
      std::string& outFile, std::unordered_set<std::string>& libsManaged) {
    outFile = "";
    libsManaged.clear();
    if (targets_.find(inputPath) == targets_.end()) {
      return false;
    }
    return GenerateCommitJson(inputPath, outputPath, outFile, libsManaged);
  };
};

};