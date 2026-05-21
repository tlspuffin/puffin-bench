#pragma once

#include <cstdint>
#include <string>
#include <filesystem>

enum class FileReadState {
  Error_Access,
  Error_Open,
  Error_OverFlow,
  NotExecuted,
  Ok,
  EndOfFile
};

struct FileExtractedText {
  size_t requestReadSize = 0;
  ssize_t requestReadOffset = 0;
  ssize_t startOffset = 0;
  size_t filesize = 0;
  std::string buffer;
  bool supportSeek = true;
  bool partialFile = false;
  FileReadState state = FileReadState::NotExecuted;
};

void FileExtractText(std::filesystem::path const& file, 
    struct FileExtractedText& out);
