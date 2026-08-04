#pragma once
#include <string>
#include <map>
#include <unordered_set>
#include <unordered_map>
#include <vector>
#include <filesystem>
#include <shared_mutex>

namespace ns_Publish {

class Index {
public:
  Index(Index&& other);
  Index(std::filesystem::path const& path);
  bool Load(std::filesystem::path filename);
  bool Save(std::filesystem::path filename);

  bool Add(std::string const& key, uint64_t timestamp, std::string const& file,
      std::unordered_set<std::string>& libsManaged);
  bool HaveIndexed(std::string const& srcFile);

  bool RemoveKey(std::string const& key, std::vector<std::string>& srcFiles);
  bool Clear(std::filesystem::path const& dataDirectory);
  bool ClearOrphelins(std::filesystem::path const& dataDirectory, std::filesystem::path const& rootPath, uint64_t& nbDelete);

  std::vector<std::string> List();
  std::pair<std::string, std::string> FindByTaskID(uint64_t taskID);

private:
  struct sEntryInfos {
    std::string srcFiles;
    std::unordered_set<std::string> libsName;
  };

  std::filesystem::path const path_;
  std::unordered_map<std::string, std::map<uint64_t, sEntryInfos>> entries_;
  std::shared_mutex lock_;
};

};
