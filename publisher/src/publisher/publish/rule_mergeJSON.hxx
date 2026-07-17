#pragma once

#include "rule.hxx"
#include <string>
#include <filesystem>
#include <unordered_set>
#include <unordered_map>
#include <rapidjson/document.h>

namespace ns_Publish {

class RuleMergeJSON : public Rule {
public:
  RuleMergeJSON(std::string const& name, std::string const& rulePath, 
      std::string const& ruleRelativePath, std::string const& filesFilter, 
      rapidjson::Value const& parameters);

  bool Apply(std::string const& file, std::filesystem::path const& outPath, 
      uint64_t& timestamp, std::string& outFile, std::unordered_set<std::string>& libsManaged, 
      bool generateArtefact);

private:

  template<typename T> void ListMergedKeys(T const& doc, 
      std::unordered_map<std::string, std::unordered_set<std::string>>& result);

  std::string src_;
  std::string dst_;
  std::unordered_set<std::string> keep_;
  std::string firstMerge_;
  std::unordered_set<std::string> merge_;
  bool (*strategyComparator_)(uint64_t, uint64_t);
  std::string strategyField_;
  bool generateZST_;
};

};
