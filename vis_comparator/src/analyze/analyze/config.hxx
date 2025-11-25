#pragma once

#include <filesystem>

namespace ns_Analyze {

class Config {
public:
  std::filesystem::path dataPath_;

  Config() : dataPath_("/home/olivier/Desktop/analyze/tlspuffin/PR") {}
};

};