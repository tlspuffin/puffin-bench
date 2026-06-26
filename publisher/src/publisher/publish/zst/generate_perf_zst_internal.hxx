#pragma once

#include <cstdint>
#include <string>
#include <filesystem>
#include <fstream>
#include <unordered_map>

namespace {

enum class DataType : uint8_t { INT32, UINT32, INT64, UINT64, DOUBLE };

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

};
