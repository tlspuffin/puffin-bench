#pragma once
#include <string>
#include <unordered_set>
#include <unordered_map>
#include <vector>
#include <filesystem>

namespace ns_Publish {

class Index {
public:
  Index();
  bool Load(std::string const& filename);
  bool Save(std::string const& filename) const;

  bool Add(std::string const& key, std::vector<std::string> const& file, 
      std::unordered_set<std::string> const& libsManaged);
  bool HaveCachedJSON(std::filesystem::path const& projectPath, std::string const& key) const;
  bool HaveIndexed(std::filesystem::path const& projectPath, std::string const& key) const;

private:
  struct sEntryInfos {
    std::vector<std::string> srcFiles;
    std::unordered_set<std::string> libsName;
  };

  std::unordered_map<std::string, std::vector<sEntryInfos>> entries_;
};

};