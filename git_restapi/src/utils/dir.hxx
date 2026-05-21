#pragma once

#include <filesystem>

inline bool IsSubDir(std::filesystem::path const& parentDir, 
    std::filesystem::path const& subDir) {
  std::filesystem::path::iterator parentIt = parentDir.begin();
  for(std::filesystem::path::iterator subDirIt = subDir.begin();
      parentIt != parentDir.end() && subDirIt != subDir.end() &&
      *parentIt == *subDirIt; ++parentIt, ++ subDirIt);
  return parentIt == parentDir.end();
}