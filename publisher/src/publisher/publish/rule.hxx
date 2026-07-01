#pragma once

#include <string>
#include <regex>
#include <filesystem>
#include <unordered_set>
#include <unordered_map>
#include <rapidjson/document.h>

#include "../../utils/logs.hxx"

namespace ns_Publish {

class Rule {
public:
  struct ExperimentResult {
    std::string id;
    std::string state;
    std::string user_run_state;
    uint64_t duration_ms;
    uint64_t timeout_ms;
    uint64_t attempt;
    uint64_t exit_code;
  };
  struct TaskAnalysis {
    std::string task_infos;
    std::string task_data;
    std::string commit_id;
    std::string task_name;
    uint64_t task_id;
    std::vector<ExperimentResult> experiments;
    std::string date;
    std::string global_status;

    std::string user;
    std::string campaign_id;
  };

  Rule() : Rule("empty", "!", "!", "") {}
  Rule(std::string const& name, std::string const& rulePath, 
      std::string const& ruleRelativePath, std::string const& filesFilter);
  bool Match(std::string const& file);

  virtual bool Apply(std::string const& file, std::filesystem::path const& outPath, 
      uint64_t& timestamp, std::string& outFile, std::unordered_set<std::string>& libsManaged, 
      bool generateArtefact) = 0;

  static Rule* Build(std::string const& action, std::string const& name, 
      std::string const& rulesPath, std::string const& rulesRelativePath, 
      std::string const& filesFilter, rapidjson::Value::ConstObject const& parameters);

protected:
  TaskAnalysis ExtractExperimentsFromFile(std::string const& jsonTaskFile, 
      std::string const& taskDataFileName);
  TaskAnalysis ExtractExperimentsFromBuffer(std::string const& jsonTaskBuffer, 
      std::filesystem::path taskInfos, std::filesystem::path taskData);

  static bool UpdateJSON(std::string jsonPath, rapidjson::Document& newJSON, 
      std::unordered_set<std::string>& libsManaged);
  static bool ValidateUpdatedJSON(std::string const& jsonPath);
  static std::unordered_set<std::string> MergeResults(
      rapidjson::Document& lastResults, rapidjson::Document const& newResults);

  std::string const name_;
  std::filesystem::path const rulePath_;
  std::string const ruleRelativePath_;
  std::regex filesFilter_;

public:
  std::string debugFilesFilter_;
};

inline bool Rule::ValidateUpdatedJSON(std::string const& jsonPath) {
  std::error_code ec;
  std::string tmpName = jsonPath + ".tmp";
  std::filesystem::rename(tmpName, jsonPath, ec);
  if (ec) {
    LOGE << "Unable to move " << tmpName << " to " << jsonPath << " : " << 
        ec.message() << Log::Flags::End;
  }
  return !ec;
}

class RuleNULL : public Rule {
public:
   RuleNULL(std::string const& name, std::string const& rulePath, 
      std::string const& ruleRelativePath, std::string const& filesFilter, 
      rapidjson::Value::ConstObject const& parameters)
      : Rule(name, rulePath, ruleRelativePath, filesFilter) {}
  bool Apply(std::string const& file, std::filesystem::path const& outPath, 
      uint64_t& timestamp, std::string& outFile, std::unordered_set<std::string>& libsManaged, 
      bool generateArtefact) {
    return true;
  }
};

};
