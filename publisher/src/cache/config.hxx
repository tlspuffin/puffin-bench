#pragma once
#include <filesystem>

namespace ns_Cache {

struct Config {
  std::filesystem::path storagePath_;
  std::filesystem::path mappingFile_;
};

};