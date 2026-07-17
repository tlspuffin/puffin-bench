#include "rapidjson.hxx"
#include <fstream>
#include <rapidjson/istreamwrapper.h>
#include <rapidjson/stringbuffer.h>
#include <rapidjson/writer.h>
#include <rapidjson/prettywriter.h>

bool ReadJSONFile(std::string const& file, rapidjson::Document& doc) {
  std::ifstream ifs(file);
  if (!ifs.is_open()) {
    //throw std::runtime_error("Unable to open JSON file: " + file);
    return false;
  }
  rapidjson::IStreamWrapper isw(ifs);
  if (doc.ParseStream(isw).HasParseError()) {
    //throw std::runtime_error("Error JSON file corrupted: " + file);
    return false;
  }
  return true;
}

bool SaveJSONFile(std::string const& file, rapidjson::Document const& doc, bool pretty) {
  rapidjson::Writer<rapidjson::StringBuffer>* writer = nullptr;
  try {
    rapidjson::StringBuffer buffer;
    if (pretty) {
      writer = new rapidjson::PrettyWriter<rapidjson::StringBuffer>(buffer);
    } else {
      writer = new rapidjson::Writer<rapidjson::StringBuffer>(buffer);
    }
    doc.Accept(*writer);
    std::ofstream outFile(file, std::ios::trunc);
    if (!outFile.is_open()) {
      throw std::runtime_error("Unable to open file " + file + " to write");
    }
    outFile << buffer.GetString() << std::endl;
    if (outFile.fail()) {
      outFile.close();
      throw std::runtime_error("Error while writing in " + file);
    }
    outFile.close();
    delete writer;
    return true;
  } catch(...)  {
    if (writer != nullptr) {
      delete writer;
    }
    return false;
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
