#include "file_compressed.hxx"
#include "logs.hxx"
#include <fstream>
#include <stdexcept>
#include <filesystem>
#include <archive_entry.h>

FileCompressed::FileCompressed(std::string const& filename) 
    : filename_(filename), memory_(nullptr), memorySize_(0), archive_(nullptr), 
    inArchiveFilename_(), inArchiveFilesize_(0)
{}

FileCompressed::FileCompressed(unsigned char const* data, size_t dataSize) 
    : filename_(), memory_(data), memorySize_(dataSize), archive_(nullptr), 
    inArchiveFilename_(), inArchiveFilesize_(0)
{
}

FileCompressed::~FileCompressed() {
  StopExtractFileData();
}

std::unordered_map<std::string, uint64_t> FileCompressed::ListFiles(std::regex const& pattern) {
  struct archive* archive = archive_read_new();
  archive_read_support_format_all(archive);
  archive_read_support_filter_all(archive);

  if (OpenArchive(archive) != ARCHIVE_OK) {
    throw std::runtime_error("Error, unable to open file " + filename_);
  }

  std::unordered_map<std::string, uint64_t> results;
  struct archive_entry* entry;
  while (archive_read_next_header(archive, &entry) == ARCHIVE_OK) {
    std::string name = archive_entry_pathname(entry);
    if (std::regex_search(name, pattern)) {
      results.try_emplace(name, archive_entry_size(entry));
    }
    archive_read_data_skip(archive);
  }

  archive_read_free(archive);
  return results;
}

int64_t FileCompressed::ExtractFileData(std::string const& filename, uint64_t const readSize, char* buffer, uint64_t* fileSize) {
  if (filename != inArchiveFilename_) {
    if (archive_ != nullptr) {
      archive_read_free(archive_);
      archive_ = nullptr;
      inArchiveFilename_ = "";
      inArchiveFilesize_ = 0;
    } else if (!inArchiveFilename_.empty()) {
      throw std::runtime_error("Error, illegal state reached, archive_ null with inArchiveFilename_ not empty");
    }

    archive_ = archive_read_new();
    archive_read_support_format_all(archive_);
    archive_read_support_filter_all(archive_);
    if (OpenArchive(archive_) != ARCHIVE_OK) {
      throw std::runtime_error("Error, unable to open file " + filename_);
    }

    inArchiveFilename_ = filename; 

    bool notfound = true;
    struct archive_entry* entry;
    while (archive_read_next_header(archive_, &entry) == ARCHIVE_OK) {
      char const* name = archive_entry_pathname(entry);
      if (filename == name) {
        inArchiveFilesize_ = archive_entry_size(entry);
        notfound = false;
        break;
      }
    }
    if (notfound) {
      if (fileSize != nullptr) {
        *fileSize = 0;
      }
      return 0;
    }
  } else if (archive_ == nullptr) {
    throw std::runtime_error("Error, illegal state reached, archive_ null with inArchiveFilename_ not empty");
  }

  if (fileSize != nullptr) {
    *fileSize = inArchiveFilesize_;
  }
  return archive_read_data(archive_, buffer, readSize);
}

void FileCompressed::StopExtractFileData() {
  if (archive_ == nullptr) {
    return;
  }
  archive_read_free(archive_);
  archive_ = nullptr;
  inArchiveFilename_ = "";
  inArchiveFilesize_ = 0;
}

void FileCompressed::ExtractFile(std::string const& srcfile, std::string const& dstFile) {
  std::ofstream ofs(dstFile, std::ios::binary);
  if (!ofs.is_open()) {
    throw std::runtime_error("Unable to create file " + dstFile);
  }

  std::vector<char> buffer(1024*1024);
  int64_t size = ExtractFileData(srcfile, buffer.size(), buffer.data(), nullptr);
  while(size > 0) {
    ofs.write(buffer.data(), size);
    size = ExtractFileData(srcfile, buffer.size(), buffer.data(), nullptr);
  }
}

std::vector<std::string> FileCompressed::ExtractAll(std::string const& targetDir, bool overwrite) {
  std::vector<std::string> result;
  for (auto const& [name, size] : ListFiles()) {
    std::filesystem::path dst = std::filesystem::path(targetDir) / name;
    if (!overwrite && std::filesystem::exists(dst)) {
      continue;
    }
    std::filesystem::create_directories(dst.parent_path());
    ExtractFile(name, dst.string());
    result.push_back(name);
  }
  return result;
}
