#include "rapidjson.hxx"
#include "logs.hxx"
#include <fstream>
#include <rapidjson/istreamwrapper.h>
#include <rapidjson/ostreamwrapper.h>
#include <rapidjson/prettywriter.h>

bool ReadJSONFile(std::string const& file, rapidjson::Document& doc) {
  std::ifstream ifs(file);
  if (!ifs.is_open()) {
    LOGE << "Unable to open JSON file: " << file << Log::Flags::End;
    //throw std::runtime_error("Unable to open JSON file: " + file);
    return false;
  }
  rapidjson::IStreamWrapper isw(ifs);
  if (doc.ParseStream(isw).HasParseError()) {
    LOGE << "Error JSON file corrupted: " << file << Log::Flags::End;
    //throw std::runtime_error("Error JSON file corrupted: " + file);
    return false;
  }
  return true;
}

bool SaveJSONFile(std::string const& file, rapidjson::Value const& doc, bool pretty) {
  try {
    std::ofstream ofs(file);
    if (!ofs) {
      throw std::runtime_error("write opening fail");
    }
    rapidjson::OStreamWrapper osw(ofs);
    if (pretty) {
      rapidjson::PrettyWriter<rapidjson::OStreamWrapper> writer(osw);
      writer.SetIndent(' ', 2);
      doc.Accept(writer);
    } else {
      rapidjson::Writer<rapidjson::OStreamWrapper> writer(osw);
      doc.Accept(writer);
    }
    ofs << std::endl;
    if (ofs.fail()) {
      throw std::runtime_error("writing fail");
    }
    return true;
  } catch(std::exception const& e) {
    LOGE << "Unable save JSON file: " << file << " " << e.what() << Log::Flags::End;
  } catch(...)  {
    LOGE << "Unable save JSON file: " << file << " unknown reason" << Log::Flags::End;
  }
  return false;
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
