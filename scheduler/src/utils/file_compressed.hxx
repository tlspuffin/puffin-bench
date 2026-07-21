#pragma once

#include <cstdint>
#include <string>
#include <unordered_map>
#include <regex>
#include <archive.h>

class FileCompressed {
public:
  FileCompressed(std::string const& filename);
  FileCompressed(unsigned char const* data, size_t dataSize);
  ~FileCompressed();
  std::unordered_map<std::string, uint64_t> ListFiles(std::regex const& pattern =std::regex(".*"));
  int64_t ExtractFileData(std::string const& filename, uint64_t const readSize, char* buffer, uint64_t* fileSize);
  void StopExtractFileData();
  void ExtractFile(std::string const& srcfile, std::string const& dstFile);
  std::vector<std::string> ExtractAll(std::string const& targetDir, bool overwrite);

private:
  std::string const filename_;
  unsigned char const* memory_;
  size_t const memorySize_;
  struct archive* archive_;
  std::string inArchiveFilename_;
  uint64_t inArchiveFilesize_;

  int OpenArchive(struct archive* archive) const;
};

inline int FileCompressed::OpenArchive(struct archive* archive) const {
  return memory_ ? archive_read_open_memory(archive, memory_, memorySize_)
      : archive_read_open_filename(archive, filename_.c_str(), 10240);
}