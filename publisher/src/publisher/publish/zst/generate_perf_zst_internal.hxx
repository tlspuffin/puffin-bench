#pragma once

#include <cstdint>
#include <string>
#include <filesystem>
#include <fstream>
#include <unordered_map>
#include <vector>

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
  std::unordered_map<std::string, std::vector<uint8_t>> buffers_;
  uint64_t buffersSize_;

  void UpdateData(std::string const& seriesName, uint8_t const* data, size_t size);
  void FlushBuffers();
};

inline void StreamingWriter::Save(const std::string& seriesName, uint64_t value) {
  UpdateData(seriesName, reinterpret_cast<uint8_t const*>(&value), sizeof(uint64_t));
}

inline void StreamingWriter::Save(const std::string& seriesName, double value) {
  UpdateData(seriesName, reinterpret_cast<uint8_t const*>(&value), sizeof(double));
}

};
