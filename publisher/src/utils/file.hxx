#pragma once

#include <cstdint>
#include <string>
#include <filesystem>

enum class FileReadState {
  Error_Access,
  Error_Open,
  Error_OverFlow,
  Ok,
  EndOfFile
};

struct FileExtractedText {
  std::string buffer;
  uint64_t filesize;
};

FileReadState FileExtractText(std::filesystem::path const& file, 
    size_t readSize, ssize_t readOffset, struct FileExtractedText& out);