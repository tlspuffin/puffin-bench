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
  if (str.empty()) throw std::runtime_error("ParseDurationToSeconds: error, empty duration not supported");
  size_t pos = 0;
  while (pos < str.size() && isdigit((unsigned char)(str[pos]))) {
    ++pos;
  }
  uint64_t value = std::stoull(str.substr(0, pos));
  std::string unit = str.substr(pos);
  uint64_t unitValueS = 0;
  if (unit == "d") unitValueS = 60 * 60 * 24;
  if (unit == "h") unitValueS = 60 * 60;
  if (unit == "m") unitValueS = 60;
  if (unit == "s") unitValueS = 1;
  if (unitValueS == 0) {
    throw std::runtime_error("ParseDurationToSeconds: error, bad duration string: " + str);
  }
  if ((UINT64_MAX / unitValueS) < value) {
    throw std::runtime_error("ParseDurationToSeconds: error, duration is too big: " + str);
  }
  return value * unitValueS;
}

uint64_t ParseDurationToMilliSeconds(const std::string& str) {
  if (str.empty()) throw std::runtime_error("ParseDurationToMilliSeconds: error, empty duration not supported");
  size_t pos = 0;
  while (pos < str.size() && isdigit((unsigned char)(str[pos]))) {
    ++pos;
  }
  uint64_t value = std::stoull(str.substr(0, pos));
  std::string unit = str.substr(pos);
  uint64_t unitValueMS = 0;
  if (unit == "d")  unitValueMS = 24 * 60 * 60 * 1000;
  if (unit == "h")  unitValueMS = 60 * 60 * 1000;
  if (unit == "m")  unitValueMS = 60 * 1000;
  if (unit == "s")  unitValueMS = 1000;
  if (unit == "ms") unitValueMS = 1;
  if (unitValueMS == 0) {
    throw std::runtime_error("ParseDurationToMilliSeconds: error, bad duration string: " + str);
  }
  if ((UINT64_MAX / unitValueMS) < value) {
    throw std::runtime_error("ParseDurationToMilliSeconds: error, duration is too big: " + str);
  }
  return value * unitValueMS;
}
