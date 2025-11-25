#pragma once

#include <cstdint>
#include <string>
#include <vector>
#include <filesystem>
#include <unordered_map>
#include <unordered_set>

namespace ns_Analyze {

class Data {
public:
  struct MetricsInfo {
    uint64_t nbClient_;
    uint64_t runTime_;
    std::unordered_set<std::string> metricsNames_;
  };
  struct StrElement {
    uint64_t index_low_;
    uint64_t index_high_;
    double weight_low_;
    double weight_high_;
    StrElement() {};
    StrElement(uint64_t index_low, uint64_t index_high, double weight_low, double weight_high) 
        : index_low_(index_low), index_high_(index_high), weight_low_(weight_low), weight_high_(weight_high)
    {};
  };
  struct StrDataMappingRange {
    struct StrDataMappingRange* base_;
    std::string file_;
    uint64_t windowSize_;
    uint64_t sampling_;

    uint64_t startElement_;
    uint64_t nbElement_;

    std::vector<StrElement> elements_;
    std::vector<uint64_t> timestamps_;

    StrDataMappingRange() 
        : base_(nullptr), file_(), windowSize_(0), sampling_(0), startElement_(0), nbElement_(0) {}
    StrDataMappingRange(std::string const& id, uint64_t windowSize, uint64_t sampling) 
        : StrDataMappingRange(id, windowSize, sampling, nullptr) {}
    StrDataMappingRange(std::string const& id, uint64_t windowSize, uint64_t sampling, struct StrDataMappingRange* base) 
        : base_(base), file_(id+".timestamp"), windowSize_(windowSize), sampling_(sampling), startElement_(0), nbElement_(0) {}
  };

  Data(std::filesystem::path baseDir, std::string const& metadataJSON);
  Data(std::filesystem::path const& metadataFilename);
  void Metrics(struct MetricsInfo& metricsInfo);
  void AlignData(std::vector<std::string> yAxis, uint64_t windowDataSize, uint64_t sampling, 
      std::vector<struct StrDataMappingRange>& dataMappingRange);

private:
  enum class DataType : uint8_t { INT32, UINT32, INT64, UINT64, DOUBLE };
  struct StrInfos {
    std::string name_;
    DataType type_;
    size_t nbElement_;
    std::string file_;
  };
  /*struct AxisData {
    struct StrInfos infos_;
    std::vector<uint64_t> dataUInt64_;
    std::vector<double> dataDouble_;
    std::vector<size_t> dataIndex_;
    std::vector<bool> dataIndexExact_;
    std::vector<std::pair<double, double>> dataInterpolationCoeff_;
    bool valid_;
    uint64_t startOffset_;
    uint64_t endOffset_;
    uint64_t noDataTillOffset_;
    AxisData() : valid_(false) {};
  };*/

  std::filesystem::path baseDir_;
  uint64_t nbClient_;
  uint64_t runTime_;
  std::unordered_set<std::string> valuesNames_;
  std::unordered_map<std::string, struct StrInfos> datas_;

  void Constructor(std::filesystem::path baseDir, std::string const& metadataJSON);

  DataType StringToDataType(std::string const& type);
  size_t DataTypeToDataSize(DataType type);

  void ExtractTimestampAxis(struct StrDataMappingRange& data);

  /*template<typename T> void SetupFile(std::string const& filename, struct AxisData const& axisData, std::vector<T>& buffer);
  template<typename T> void ExtractValues(std::string const& filename, struct AxisData const& axisData, std::vector<T>& values);
  template<typename T> void ExtractAccumulateValues(std::string const& filename, struct AxisData const& axisData, std::vector<T>& values);*/
};

/*template<typename T> 
void Data::SetupFile(std::string const& filename, struct AxisData const& axisData, std::vector<T>& buffer) {
  std::ifstream ifs(baseDir_ / filename);
  if (!ifs.is_open()) {
    throw std::runtime_error("Failed to open file: " + (baseDir_ / filename).string());
  }

  ifs.seekg(axisData.startOffset_* sizeof(T));
  uint64_t windowDataSize = axisData.endOffset_ - axisData.startOffset_;
  uint64_t readSize = windowDataSize * sizeof(T);
  buffer.resize(windowDataSize);
  ifs.read((char*)buffer.data(), readSize);
  if ((!ifs) && (!ifs.eof())) {
    throw std::runtime_error("Failed to read " + std::to_string(readSize) + 
        " bytes from: " + (baseDir_ / filename).string());
  }
}

template<typename T>
void Data::ExtractValues(std::string const& filename, struct AxisData const& axisData, std::vector<T>& values) {
  std::vector<T> buffer;
  SetupFile<T>(filename, axisData, buffer);

  values.resize(axisData.dataIndex_.size());
  T* data = buffer.data();
  for(size_t j=0; j<axisData.dataIndex_.size(); ++j) {
    size_t index = axisData.dataIndex_[j];
    if (axisData.dataIndexExact_[j]) {
      values[j] = data[index];
    } else {
      T val1 = (double)data[index] * axisData.dataInterpolationCoeff_[j].first;
      T val2 = (double)data[index+1] * axisData.dataInterpolationCoeff_[j].second;
      values[j] = val1 + val2;
    }
  }
}

template<typename T>
void Data::ExtractAccumulateValues(std::string const& filename, struct AxisData const& axisData, std::vector<T>& values) {
  std::vector<T> buffer;
  SetupFile<T>(filename, axisData, buffer);

  T* data = (T*)buffer.data();
  for(size_t j=0; j<axisData.dataIndex_.size(); ++j) {
    size_t index = axisData.dataIndex_[j];
    if (axisData.dataIndexExact_[j]) {
      values[j] += data[index];
    } else {
      T val1 = (double)data[index] * axisData.dataInterpolationCoeff_[j].first;
      T val2 = (double)data[index+1] * axisData.dataInterpolationCoeff_[j].second;
      values[j] += val1 + val2;
    }
  }
}*/

}