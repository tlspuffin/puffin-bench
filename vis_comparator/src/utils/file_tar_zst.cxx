#include "file_tar_zst.hxx"
#include "logs.hxx"
#include <filesystem>
#include <stdexcept>
#include <fstream>
#include <cstdio>
#include <unordered_map>
#include <unordered_set>
#include <regex>
#include <string>

struct posix_header
{                              /* byte offset */
  char name[100];               /*   0 */
  char mode[8];                 /* 100 */
  char uid[8];                  /* 108 */
  char gid[8];                  /* 116 */
  char size[12];                /* 124 */
  char mtime[12];               /* 136 */
  char chksum[8];               /* 148 */
  char typeflag;                /* 156 */
  char linkname[100];           /* 157 */
  char magic[6];                /* 257 */
  char version[2];              /* 263 */
  char uname[32];               /* 265 */
  char gname[32];               /* 297 */
  char devmajor[8];             /* 329 */
  char devminor[8];             /* 337 */
  char prefix[155];             /* 345 */
                                /* 500 */
};

FileTARZST::FileTARZST(std::string const& filename) 
    : filename_(filename)
{
  archiveFile_ = fopen64(filename_.c_str(), "rb");
  if (archiveFile_ == nullptr) {
    throw std::runtime_error("Unable to open file: " + filename);
  }

  zstdStream_ = ZSTD_seekable_create();
  if (!zstdStream_) {
    fclose(archiveFile_);
    throw std::runtime_error("ZSTD_seekable_create failed");
  }
  size_t const err = ZSTD_seekable_initFile(zstdStream_, archiveFile_);
  if (ZSTD_isError(err)) {
    ZSTD_seekable_free(zstdStream_);
    fclose(archiveFile_);
    throw std::runtime_error("ZSTD_seekable_initFile failed on file: " + filename_);
  }

  std::vector<char> buffer(512);
  struct posix_header* header = (struct posix_header*)buffer.data();
  size_t ret = ZSTD_seekable_decompress(zstdStream_, buffer.data(), buffer.size(), 0);
  if (ZSTD_isError(ret)) {
    ZSTD_seekable_free(zstdStream_);
    fclose(archiveFile_);
    throw std::runtime_error("ZSTD_seekable_decompress failed: " + std::string(ZSTD_getErrorName(ret)));
  }
  uint64_t offset = 0;
  while(header->name[0] != 0) {
    std::filesystem::path name;
    if (header->prefix[0] != 0) {
      if (header->prefix[154] == 0) {
        name = header->prefix;
      } else {
        name = std::string(header->prefix, 155);
      }
    }
    if (header->name[99] == 0) {
      name /= header->name;
    } else {
      name /= std::string(header->name, 100);
    }

    //std::string name = std::filesystem::path(std::string(header->prefix, 155)) / std::string(header->name, 100);
    //LOGI(name << ": " << header->size << " " << offset);

    offset += 512;
    uint64_t size = std::stoull(header->size, nullptr, 8);
    index_[name] = { size, offset };

    offset += ((size + 511) & (~0x1ff));
    ret = ZSTD_seekable_decompress(zstdStream_, buffer.data(), buffer.size(), offset);
    if (ZSTD_isError(ret)) {
      ZSTD_seekable_free(zstdStream_);
      fclose(archiveFile_);
      throw std::runtime_error("ZSTD_seekable_decompress failed: " + std::string(ZSTD_getErrorName(ret)));
    }
  }
}

FileTARZST::~FileTARZST() {
  ZSTD_seekable_free(zstdStream_);
  fclose(archiveFile_);
}

std::vector<std::pair<std::string, uint64_t>> FileTARZST::ListFiles(std::regex const searchPattern) {
  std::vector<std::pair<std::string, uint64_t>> results;
  for (auto const& file: index_) {
    if (std::regex_search(file.first, searchPattern)) {
      results.push_back({file.first, file.second.first});
    }
  }
  return results;
}

uint64_t FileTARZST::FileSize(std::string const& filename) {
  auto const& it = index_.find(filename);
  if (it == index_.end()) {
    throw std::runtime_error("Error, file does not exist: "+ filename);
  }
  return it->second.first;
}

int64_t FileTARZST::ExtractFileData(std::string const& filename, uint64_t readSize, uint64_t readOffset, char* buffer, uint64_t* fileSize) {
  auto const& it = index_.find(filename);
  if (it == index_.end()) {
    throw std::runtime_error("File not found: "+filename);
  }
  uint64_t size = it->second.first;
  if ((readOffset + readSize) > size) {
    readSize = size - readOffset;
  }
  size_t ret = ZSTD_seekable_decompress(zstdStream_, buffer, readSize, it->second.second+readOffset);
  if (ZSTD_isError(ret)) {
    throw std::runtime_error("ZSTD_seekable_decompress failed: " + std::string(ZSTD_getErrorName(ret)));
  }
  if (fileSize != nullptr) {
    *fileSize = size;
  }
  return ret;
}

void FileTARZST::ExtractFile(std::string const& filename, std::vector<char>& buffer) {
  auto const& it = index_.find(filename);
  if (it == index_.end()) {
    throw std::runtime_error("File not found: "+filename);
  }
  buffer.resize(it->second.first);
  size_t ret = ZSTD_seekable_decompress(zstdStream_, buffer.data(), buffer.size(), it->second.second);
  if (ZSTD_isError(ret)) {
    throw std::runtime_error("ZSTD_seekable_decompress failed: " + std::string(ZSTD_getErrorName(ret)));
  }
}