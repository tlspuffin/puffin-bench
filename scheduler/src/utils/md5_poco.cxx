#include "md5_poco.hxx"
#include <fstream>

std::string MD5(std::string const& data) {
  Poco::MD5Engine md5;
  md5.update(data);
  return Poco::DigestEngine::digestToHex(md5.digest());
}

std::string MD5(char const* data, size_t size) {
  Poco::MD5Engine md5;
  md5.update(data, size);
  return Poco::DigestEngine::digestToHex(md5.digest());
}

std::string MD5(std::filesystem::path const& filepath) {
  std::ifstream file(filepath, std::ios::binary);
  if (!file) {
    throw std::runtime_error("Cannot open file: " + filepath.string());
  }

  Poco::MD5Engine md5;
  std::vector<char> buffer(1024*1024);
  while (file.read(buffer.data(), buffer.size())) {
    md5.update(buffer.data(), file.gcount());
  }
  if (file.gcount() > 0) {
    md5.update(buffer.data(), file.gcount());
  }
    
  return Poco::DigestEngine::digestToHex(md5.digest());
}