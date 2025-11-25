#include <iostream>
#include <filesystem>
#include <string>
#include <vector>
#include <unordered_map>
#include <unordered_set>
#include <fstream>
#include <stack>
#include <sstream>
#include <algorithm>
#include <numeric>
#include <cmath>
#include "rapidjson/document.h"
#include "rapidjson/istreamwrapper.h"
#include "rapidjson/writer.h"
#include "rapidjson/prettywriter.h"

#define CREATE_STRING(expr) ([&](){ std::ostringstream oss; oss << expr; return oss.str(); })()

enum class DataType : uint8_t { INT32, UINT32, INT64, UINT64, DOUBLE };

std::string DataTypeToString(DataType type) {
  switch ((type)) {
    case DataType::INT32:
      return "int32";
    case DataType::UINT32:
      return "uint32";
    case DataType::INT64:      
      return "int64";
    case DataType::UINT64:      
      return "uint64";
    case DataType::DOUBLE:      
      return "double";  
    default:
      throw std::runtime_error("Unknown DataType");
  }
}

DataType StringToDataType(std::string const& type) {
  if (type == "int32") {
    return DataType::INT32;
  } else if (type == "uint32") {
    return DataType::UINT32;
  } else if (type == "int64") {
    return DataType::INT64;
  } else if (type == "uint64") {
    return DataType::UINT64;
  } else if (type == "double") {
    return DataType::DOUBLE;
  } else {
    throw std::runtime_error("Unknown DataType " + type);
  }
}

struct DataInfo {
  DataType type;
  uint64_t count = 0;
};

class StreamingWriter {
public:
  StreamingWriter(std::filesystem::path outputDir);
  void Save(std::string const& seriesName, uint64_t value);
  void Save(std::string const& seriesName, double value);
  void SaveMetadata(std::unordered_map<std::string, DataInfo> const& dataInfos,
    uint64_t nbClient, uint64_t runTime, uint64_t goalTime
  );

private:
  std::filesystem::path outputDir_;
  std::unordered_map<std::string, std::ofstream> writers_;

  void AssertWriter(std::string const& seriesName);
};

StreamingWriter::StreamingWriter(std::filesystem::path outputDir) : outputDir_(outputDir)
{}

void StreamingWriter::AssertWriter(const std::string& seriesName) {
  if (writers_.find(seriesName) != writers_.end()) {
    return;
  }
  std::filesystem::path series_path = outputDir_ / "series" / (seriesName + ".bin");
  std::filesystem::create_directories(series_path.parent_path());
  std::ofstream writer(series_path, std::ios::binary);
  if (!writer.is_open()) {
    throw std::runtime_error("Cannot open " + series_path.string());
  }
  writers_[seriesName] = std::move(writer);
}

void StreamingWriter::Save(const std::string& seriesName, uint64_t value) {
  AssertWriter(seriesName);
  writers_[seriesName].write(reinterpret_cast<const char*>(&value), sizeof(uint64_t));
}

void StreamingWriter::Save(const std::string& seriesName, double value) {
  AssertWriter(seriesName);
  writers_[seriesName].write(reinterpret_cast<const char*>(&value), sizeof(double));
}

void StreamingWriter::SaveMetadata(std::unordered_map<std::string, DataInfo> const& dataInfos,
    uint64_t nbClient, uint64_t runTime, uint64_t goalTime) {
  for (auto& [_, stream] : writers_) {
    stream.close();
  }

  rapidjson::Document doc;
  doc.SetObject();
  auto& allocator = doc.GetAllocator();
   
  doc.AddMember("version", 0, allocator);
  doc.AddMember("endianness", 0x0100, allocator);
  doc.AddMember("nb_client", nbClient, allocator);
  doc.AddMember("run_time", runTime, allocator);
  if (goalTime != UINT64_MAX) {
    doc.AddMember("goal_time", goalTime, allocator);
  }

  rapidjson::Value seriesRoot(rapidjson::kObjectType);
  for (auto const& [fullName, info] : dataInfos) {
    
    std::vector<std::string> parts;
    {
      std::stringstream ss(fullName);
      std::string part;
      while (std::getline(ss, part, '.')) {
        parts.push_back(part);
      }
    }
    
    rapidjson::Value* current = &seriesRoot;   
    for (size_t i = 0; i < parts.size() - 1; ++i) {
      std::string const& part = parts[i];
      
      if (!current->HasMember(part.c_str())) {
        current->AddMember(rapidjson::Value(part.c_str(), allocator), 
            rapidjson::Value(rapidjson::kObjectType), 
            allocator);
      }
      current = &(*current)[part.c_str()];
    }
    std::string const& leafName = parts.back();
    rapidjson::Value leafObj(rapidjson::kObjectType);
    leafObj.AddMember("type", (info.type == DataType::DOUBLE ? "double" : "uint64"), allocator);
    leafObj.AddMember("count", info.count, allocator);
    std::string filePath = "series/" + fullName + ".bin";
    leafObj.AddMember("file", rapidjson::Value(filePath.c_str(), allocator), allocator);
    
    current->AddMember(rapidjson::Value(leafName.c_str(), allocator), leafObj, allocator);
  }
  doc.AddMember("series", seriesRoot, allocator);
  
  std::ofstream metaFile(outputDir_ / "metadata.json");
  rapidjson::StringBuffer buffer;
  rapidjson::PrettyWriter<rapidjson::StringBuffer> writer(buffer);
  doc.Accept(writer);
  metaFile << buffer.GetString();
}

void ProcessStatsFile(std::string const& filename) {
  std::ifstream jsonFile(filename);
  if (!jsonFile.is_open()) {
    throw std::runtime_error("Cannot open " + filename);
  }
    
  std::cout << "Parsing " << filename << std::endl;

  StreamingWriter writer(filename+".bin");
  uint64_t startTime = 0;
  uint64_t runTime = 0;
  uint64_t goalTime = UINT64_MAX;
  uint64_t nbClient = 0;
  std::unordered_map<std::string, struct DataInfo> dataInfos;
  rapidjson::IStreamWrapper isw(jsonFile);
  while (!jsonFile.eof()) {
    rapidjson::Document doc;
    doc.ParseStream<rapidjson::kParseStopWhenDoneFlag>(isw);
    if (doc.HasParseError()) {
      break;
    }

    if (!doc.HasMember("type") || !doc["type"].IsString()) {
      continue;
    }
    std::string eventType = doc["type"].GetString();
    uint64_t clientID = 0;
    std::string prefix = "global";
    if (eventType == "client") {
      if (!doc.HasMember("id") || !doc["id"].IsInt()) {
        continue;
      }
      clientID = doc["id"].GetUint64();
      if (clientID > nbClient) {
        nbClient = clientID;
      }
      prefix = "client_" + std::to_string(clientID);
    } else if (eventType != "global") {
      continue;
    }

    uint64_t relativeTime = 0;
    if (doc.HasMember("time") && doc["time"].IsObject()) {
      const auto& time_obj = doc["time"];
      if (time_obj.HasMember("secs_since_epoch") && time_obj["secs_since_epoch"].IsUint64()) {
        uint64_t timestamp = time_obj["secs_since_epoch"].GetUint64();

        timestamp *= 1000000;
        if (time_obj.HasMember("nanos_since_epoch") && time_obj["nanos_since_epoch"].IsUint64()) {
          timestamp += time_obj["nanos_since_epoch"].GetUint64() / 1000;
        }

        if (startTime == 0) {
          startTime = timestamp;
        }
        relativeTime = timestamp - startTime;
        std::string timestampSeries = prefix + ".timestamp";
        dataInfos[timestampSeries].type = DataType::UINT64;
        dataInfos[timestampSeries].count++;
        writer.Save(timestampSeries, relativeTime);
        //if (eventType == "global") {
        if (relativeTime > runTime) {
          runTime = relativeTime;
        }
      }
    }

    std::stack<std::pair<const rapidjson::Value*, std::string>> stack;
    stack.push({&doc, ""});        
    while (!stack.empty()) {

      auto [current, path] = stack.top();
      stack.pop();
            
      if (!current->IsObject()) {
        continue;
      }
      for (auto it = current->MemberBegin(); it != current->MemberEnd(); ++it) {
        std::string fieldName = it->name.GetString();
                
        if (fieldName == "type" || fieldName == "id" || fieldName == "clients") {
          continue;
        }
                
        std::string fullName = path.empty() ? fieldName : path + "." + fieldName;
        const rapidjson::Value& value = it->value;
                
        if (value.IsObject()) {
          stack.push({&value, fullName});
        } else if (value.IsNumber()) {
          std::string seriesName = prefix + "." + fullName;
          if ((fieldName == "secs_since_epoch") ||
              (fieldName == "nanos_since_epoch")) {
            continue;
          }
          if ((fieldName == "objective_size") && (goalTime == UINT64_MAX)) {
            uint64_t objSize = value.GetUint64();
            if (objSize > 0) {
              goalTime = relativeTime;
            }
          }
          if (value.IsDouble()) {
            dataInfos[seriesName].type = DataType::DOUBLE;
            ++(dataInfos[seriesName].count);
            writer.Save(seriesName, value.GetDouble());
          } else {
            uint64_t aValue = value.GetUint64();
            dataInfos[seriesName].type = DataType::UINT64;
            ++(dataInfos[seriesName].count);
            writer.Save(seriesName, aValue);
          }
        }
      }
    }
  }
  writer.SaveMetadata(dataInfos, nbClient, runTime, goalTime);
}

std::vector<std::filesystem::path> ListJSONFilesIn(std::filesystem::path const& path) {
  std::vector<std::filesystem::path> results;
  for (std::filesystem::directory_entry const& entry : std::filesystem::directory_iterator(path)) {
    if (entry.is_regular_file() && entry.path().extension() == ".json") {
        results.push_back(entry.path());
    }
  }
  return results;
}

int main(int argc, char* argv[]) {
  //std::filesystem::path inPath = "data";
  std::filesystem::path inPath = "/home/olivier/Desktop/analyze/BINOUT";
  std::unordered_set<std::string> ingnoredFiles;
  int argKey = -1;
  for(int i=1; i<argc; ++i) {
    std::string arg = argv[i];
    if (argKey == -1) {
      if (arg.find("--") != 0) {
        std::cerr << "Missing argument parameter" << std::endl;
        return 1;
      }
      arg = arg.substr(2);
      if (arg == "path") {
        argKey = 0;
      } else if (arg == "ignore") {
        argKey = 1;  
      } else {
        std::cerr << "Unknown argument parameter " << arg << std::endl;
        return 1;
      }
    } else {
      switch(argKey) {
        case 0:
          inPath = argv[i];
          if (!std::filesystem::exists(inPath)) {
            std::cerr << "Path not existing " << argv[i] << std::endl;
            return 1;
          }
          break;
        case 1:
          ingnoredFiles.insert(argv[i]);
          break;
        default:
          std::cerr << "Unknown argument parameter" << std::endl;
          return 1;
      }
      argKey = -1;
    }
  }
  if (argKey != -1) {
    std::cerr << "Missing argument value" << std::endl;
    return 1;
  }

  std::vector<std::filesystem::path> jsonDataFiles = ListJSONFilesIn(inPath);
  for(std::filesystem::path const& path: jsonDataFiles) {
    if (ingnoredFiles.count(path.filename()) > 0) {
      std::cerr << "Ignore " << path << '\n';
      continue;
    }
    ProcessStatsFile(path);
  }

  return 0;
}
