#pragma once
#include <string>
#include <filesystem>

namespace ns_API {

struct APIS {
  APIS(std::string const& cmdLine);

  std::filesystem::path const tmpPath_;
};

};