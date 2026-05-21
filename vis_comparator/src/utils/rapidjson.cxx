#include "rapidjson.hxx"
#include "logs.hxx"
#include <fstream>
#include <rapidjson/istreamwrapper.h>

void ReadJSONFile(std::string const& file, rapidjson::Document& doc) {
  std::ifstream ifs(file);
  if (!ifs.is_open()) {
    LOGE("Unable to open " << file);
    throw std::runtime_error("Unable to open JSON file: " + file);
  }
  rapidjson::IStreamWrapper isw(ifs);
  if (doc.ParseStream(isw).HasParseError()) {
    LOGE("Error JSON file corrupted " << file);
    throw std::runtime_error("Error JSON file corrupted: " + file);
  }
}

uint64_t ParseDurationToSeconds(const std::string& str) {
  if (str.empty()) return 0;
  char unit = str.back();
  uint64_t value = std::stoull(str.substr(0, str.size() - 1));
  if (unit == 'd') return value * 60 * 60 * 24;
  if (unit == 'h') return value * 60 * 60;
  if (unit == 'm') return value * 60;
  if (unit == 's') return value;
  return value;
}

uint64_t ParseDurationToMilliSeconds(const std::string& str) {
  if (str.empty()) return 0;

  size_t pos = 0;
  while (pos < str.size() && isdigit(str[pos])) {
    ++pos;
  }

  uint64_t value = std::stoull(str.substr(0, pos));
  std::string unit = str.substr(pos);

  if (unit == "d")  return value * 24 * 60 * 60 * 1000;
  if (unit == "h")  return value * 60 * 60 * 1000;
  if (unit == "m")  return value * 60 * 1000;
  if (unit == "s")  return value * 1000;
  if (unit == "ms") return value;
  return value;
}