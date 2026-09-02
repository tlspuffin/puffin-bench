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
  int64_t requestReadSize = 0;
  int64_t requestReadOffset = 0;
  int64_t startOffset = 0;
  int64_t filesize = 0;
  int64_t fileStartOffset = 0;

  std::string buffer;
  bool supportSeek = true;
  bool partialFile = false;
  bool live = false;
  FileReadState state = FileReadState::NotExecuted;
};

void FileExtractText(std::filesystem::path const& file, 
    struct FileExtractedText& out);
