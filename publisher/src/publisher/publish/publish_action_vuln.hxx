#pragma once
#include "publish_action.hxx"

namespace ns_Publish {

class PublishActionVuln : public PublishAction {
public:
  PublishActionVuln() : PublishAction() {}
  PublishActionVuln(std::string const& name, std::string const& filesFilter) : PublishAction(name, filesFilter) {}
  PublishAction::TaskAnalysis Analyze(std::string jsonTaskFile);
  bool GenerateCommitJson(PublishAction::TaskAnalysis const& analysis, std::filesystem::path const& outputPath);
  bool Run(std::filesystem::path const& inputPath, std::filesystem::path const& outputPath) {
    if (targets_.find(inputPath) == targets_.end()) {
      return false;
    }
    PublishAction::TaskAnalysis analyze = Analyze(inputPath);
    return GenerateCommitJson(analyze, outputPath);
  };
};

};