#include "api.hxx"
#include <unistd.h>
#include <cstring>

ns_API::APIS::APIS(std::string const& cmdLine) 
    : tmpPath_(std::filesystem::temp_directory_path() / (std::string(basename(cmdLine.c_str())) + "-" + std::to_string(getpid())))
{
  if (!std::filesystem::create_directories(tmpPath_)) {
    throw std::runtime_error(std::string("Fatal error: ") + tmpPath_.string() + " seems not empty");
  }
}