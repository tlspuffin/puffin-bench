#pragma once

#include "logs.hxx"
#include <filesystem>

inline bool IsSubDir(std::filesystem::path const& parentDir, 
    std::filesystem::path const& subDir) {
  std::filesystem::path subDirNormalized = subDir.lexically_normal();
  if ((subDirNormalized.begin() != subDirNormalized.end()) && 
      (*subDirNormalized.begin() == "..")) {
    return false;
  }

  if ((parentDir.string() == ".") && subDirNormalized.is_relative()) {
    return true;
  }
  std::filesystem::path::iterator parentIt = parentDir.begin();
  for(std::filesystem::path::iterator subDirIt = subDirNormalized.begin();
      parentIt != parentDir.end() && subDirIt != subDirNormalized.end() &&
      *parentIt == *subDirIt; ++parentIt, ++ subDirIt);
  return parentIt == parentDir.end();
}