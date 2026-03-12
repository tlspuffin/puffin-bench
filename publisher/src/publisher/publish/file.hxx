#pragma once

#include "../../utils/dir.hxx"
#include <filesystem>
#include <string>
#include <fstream>

namespace ns_Publish {

class File {
public:
  File(std::filesystem::path const& filename) 
      : projectFile_(filename), file_(filename), remote_() {
    Build(filename);
  }
  File(std::string const& filename) 
      : projectFile_(filename), file_(filename), remote_() {
    Build(filename);
  }
  File(std::string const& filename, std::string const& remote) 
      : projectFile_(filename), file_(filename), remote_(remote) {
    projectFile_.replace_filename(".remote-" + projectFile_.filename().string());
  }

  std::filesystem::path AbsolutePath() const { return remote_; }
  std::filesystem::path ProjectAbsolutePath() const { return file_; }
  bool Exist() const { return std::filesystem::exists(remote_); }
  bool ExistInProject() const { 
    if (std::filesystem::exists(file_)) {
      return true;
    }
    if (std::filesystem::exists(projectFile_)) {
      std::ifstream ifs(projectFile_);
      if (ifs.is_open()) {
        std::filesystem::path remote;
        ifs >> remote;
        if (ifs.fail()) {
          throw std::runtime_error("Error while reading " + projectFile_.string());
        }
        return (remote == remote_.string()) && (std::filesystem::exists(remote));
      }
    }
    return false;
  }
  std::string Extension() const { return remote_.extension(); }
  std::string RelativePath(std::string const& path) const {
    if (IsSubDir(path, remote_)) {
      return std::filesystem::relative(remote_, path);  
    }
    return remote_;
  }
  std::string RelativePathToProject(std::string const& path) const {
    if (IsSubDir(path, file_)) {
      return std::filesystem::relative(file_, path);  
    }
    return file_;
  }
  bool Copy() const {
    std::error_code ec;
    std::filesystem::create_directories(file_.parent_path(), ec);
    if (ec) {
      return false;
    }
    return std::filesystem::copy_file(remote_, file_, ec) && (!ec);
  }
  bool Link() const {
    if (projectFile_ == file_) {
      throw std::runtime_error("Should not call File::Link on same target");
    }
    std::error_code ec;
    std::filesystem::create_directories(projectFile_.parent_path(), ec);
    if (ec) {
      return false;
    }
    std::ofstream ofs(projectFile_);
    if (!ofs.is_open()) {
      return false;
    }
    ofs << remote_;
    if (ofs.fail()) {
      std::filesystem::remove(projectFile_);
      throw std::runtime_error("Unable to write in " + projectFile_.string());
    }
    ofs.close();
    return true;
  }

  void RemoveFromProject() const {
    std::error_code ec;
    if ((!std::filesystem::remove(projectFile_, ec)) || ec ) {
      throw std::runtime_error("Was unable to delete " + projectFile_.string());
    }
  }


private:
  std::filesystem::path projectFile_;
  std::filesystem::path file_;
  std::filesystem::path remote_;

  void Build(std::string const& filename) {
    if (!file_.is_absolute()) {
      throw std::runtime_error("file is not absolute " + filename);
    }
    if (file_.filename().string().find(".remote-") == 0) {
      file_.replace_filename(file_.filename().string().substr(8));
      std::ifstream ifs(filename);
      if (ifs.is_open()) {
        ifs >> remote_;
        if (ifs.fail()) {
          throw std::runtime_error("Error while reading " + filename);
        }
      }
    } else {
      remote_ = file_;
    }
  }
};

}