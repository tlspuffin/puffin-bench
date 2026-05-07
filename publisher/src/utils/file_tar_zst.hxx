#pragma once

#include <cstdint>
#include <string>
#include <vector>
#include <unordered_map>
#include <regex>
#include "zstd.h"
#include "zstd_seekable.h"


class FileTARZST {
public:
  FileTARZST(std::string const& filename);
  ~FileTARZST();
  std::vector<std::pair<std::string, uint64_t>> ListFiles(std::regex const searchPattern =std::regex(".*"));
  uint64_t FileSize(std::string const& filename);
  int64_t ExtractFileData(std::string const& filename, uint64_t readSize, uint64_t readOffset, char* buffer, uint64_t* fileSize);
  void ExtractFile(std::string const& filename, std::vector<char>& buffer);

private:
  std::string const filename_;
  FILE* archiveFile_;
  ZSTD_seekable* zstdStream_;
  std::unordered_map<std::string, std::pair<uint64_t, uint64_t>> index_;
};