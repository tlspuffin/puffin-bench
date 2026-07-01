#pragma once

#include "logs.hxx"
#include <filesystem>

bool DeleteFilesWithPrefix(std::filesystem::path files);

inline bool IsSubDir(std::filesystem::path const& parentDir, 
    std::filesystem::path const& subDir) {
   std::filesystem::path parentDirNormalized = parentDir.lexically_normal();
  std::filesystem::path subDirNormalized = subDir.lexically_normal();

  if ((subDirNormalized.begin() != subDirNormalized.end()) && 
      (*subDirNormalized.begin() == "..")) {
    return false;
  }

  if ((parentDirNormalized.string() == ".") && subDirNormalized.is_relative()) {
    return true;
  }
  std::filesystem::path::iterator parentIt = parentDirNormalized.begin();
  for(std::filesystem::path::iterator subDirIt = subDirNormalized.begin();
      parentIt != parentDirNormalized.end() && subDirIt != subDirNormalized.end() &&
      *parentIt == *subDirIt; ++parentIt, ++ subDirIt);
  return parentIt == parentDirNormalized.end();
}
