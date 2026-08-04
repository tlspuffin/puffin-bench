#include "file.hxx"
#include <cstdint>
#include <fstream>

void FileExtractText(std::filesystem::path const& file, 
    struct FileExtractedText& out) {
  out.supportSeek = true;

  std::error_code ec;
  auto filesize = std::filesystem::file_size(file, ec);
  if (ec || (filesize > INT64_MAX)) {
    out.state = FileReadState::Error_Access;
    return;
  }
  out.filesize = filesize;

  std::ifstream ifs(file);
  if (!ifs) {
    out.state = FileReadState::Error_Open;
    return;
  }

  out.startOffset = out.requestReadOffset;
  if (out.requestReadOffset < 0) {
    out.startOffset = 0;
    if (out.requestReadOffset >= (-out.filesize)) {
      out.startOffset = out.filesize + out.requestReadOffset;
    }
  }
  ifs.seekg(out.startOffset, std::ios::beg);
  if (!ifs) {
    out.state = FileReadState::Error_OverFlow;
    return;
  }

  out.buffer.resize(out.requestReadSize);
  ifs.read(&out.buffer[0], out.requestReadSize);
  out.buffer.resize(ifs.gcount());

  out.state = out.buffer.size() == out.requestReadSize ? FileReadState::Ok : FileReadState::EndOfFile; 
}
