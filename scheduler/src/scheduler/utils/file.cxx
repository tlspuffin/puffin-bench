#include "file.hxx"
#include <cstdint>
#include <fstream>

FileReadState FileExtractText(std::filesystem::path const& file, 
    size_t readSize, ssize_t readOffset, struct FileExtractedText& out) {

  std::error_code ec;
  out.filesize = std::filesystem::file_size(file, ec);
  if (ec) {
    return FileReadState::Error_Access;
  }
  std::ifstream ifs(file);
  if (!ifs) {
    return FileReadState::Error_Open;
  }
  ifs.seekg(readOffset, readOffset >= 0 ? std::ios::beg : std::ios::end);
  if (!ifs) {
    return FileReadState::Error_OverFlow;
  }

  out.buffer.resize(readSize);
  ifs.read(&out.buffer[0], readSize);
  out.buffer.resize(ifs.gcount());

  return out.buffer.size() == readSize ? FileReadState::Ok : FileReadState::EndOfFile; 
}