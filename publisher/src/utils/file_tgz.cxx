#include "file_tgz.hxx"
#include "logs.hxx"
#include <fstream>
#include <stdexcept>
#include <archive_entry.h>

FileTGZ::FileTGZ(std::string const& filename) 
    : filename_(filename), archive_(nullptr), inArchiveFilename_(), inArchiveFilesize_(0)
{}

FileTGZ::~FileTGZ() {
  StopExtractFileData();
}

std::vector<std::pair<std::string, uint64_t>> FileTGZ::ListFiles(std::regex const& pattern) {
  struct archive* archive = archive_read_new();
  archive_read_support_format_tar(archive);
  archive_read_support_filter_gzip(archive);

  if (archive_read_open_filename(archive, filename_.c_str(), 10240) != ARCHIVE_OK) {
    throw std::runtime_error("Error, unable to open file " + filename_);
  }

  std::vector<std::pair<std::string, uint64_t>> results;
  struct archive_entry* entry;
  while (archive_read_next_header(archive, &entry) == ARCHIVE_OK) {
    std::string name = archive_entry_pathname(entry);
    if (std::regex_search(name, pattern)) {
      results.push_back({name, archive_entry_size(entry)});
    }
    archive_read_data_skip(archive);
  }

  archive_read_free(archive);
  return results;
}

int64_t FileTGZ::ExtractFileData(std::string const& filename, uint64_t const readSize, char* buffer, uint64_t* fileSize) {
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
    archive_read_support_format_tar(archive_);
    archive_read_support_filter_gzip(archive_);
    if (archive_read_open_filename(archive_, filename_.c_str(), 10240) != ARCHIVE_OK) {
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
      *fileSize = 0;
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

void FileTGZ::StopExtractFileData() {
  if (archive_ == nullptr) {
    return;
  }
  archive_read_free(archive_);
  archive_ = nullptr;
  inArchiveFilename_ = "";
  inArchiveFilesize_ = 0;
}

void FileTGZ::ExtractFile(std::string const& srcfile, std::string const& dstFile) {
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