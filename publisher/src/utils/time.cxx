#include "time.hxx"
#include <ctime>

std::string ToReadableDate(uint64_t time_in_ms) {
  std::time_t timestamp = time_in_ms / 1000;
  std::tm* tm_info = std::localtime(&timestamp);
  char date_buffer[20];
  std::strftime(date_buffer, 20, "%Y-%m-%d", tm_info);
  return date_buffer;
}