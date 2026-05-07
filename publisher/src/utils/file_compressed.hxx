#pragma once

#include <cstdint>
#include <string>
#include <vector>
#include <regex>
#include <archive.h>

class FileCompressed {
public:
  FileCompressed(std::string const& filename);
  ~FileCompressed();
  std::vector<std::pair<std::string, uint64_t>> ListFiles(std::regex const& pattern =std::regex(".*"));
  int64_t ExtractFileData(std::string const& filename, uint64_t const readSize, char* buffer, uint64_t* fileSize);
  void StopExtractFileData();
  void ExtractFile(std::string const& srcfile, std::string const& dstFile);

private:
  std::string const filename_;
  struct archive* archive_;
  std::string inArchiveFilename_;
  uint64_t inArchiveFilesize_;
};
