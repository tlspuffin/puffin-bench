#include "file.hxx"
#include <cstdint>
#include <fstream>

void FileExtractText(std::filesystem::path const& file, 
    struct FileExtractedText& out) {
  out.supportSeek = true;

  std::error_code ec;
  out.filesize = std::filesystem::file_size(file, ec);
  if (ec) {
    out.state = FileReadState::Error_Access;
    return;
  }
  std::ifstream ifs(file);
  if (!ifs) {
    out.state = FileReadState::Error_Open;
    return;
  }
  ifs.seekg(out.requestReadOffset, out.requestReadOffset >= 0 ? std::ios::beg : std::ios::end);
  if (!ifs) {
    out.state = FileReadState::Error_OverFlow;
    return;
  }
  out.startOffset = out.requestReadOffset;

  out.buffer.resize(out.requestReadSize);
  ifs.read(&out.buffer[0], out.requestReadSize);
  out.buffer.resize(ifs.gcount());

  out.state = out.buffer.size() == out.requestReadSize ? FileReadState::Ok : FileReadState::EndOfFile; 
}
