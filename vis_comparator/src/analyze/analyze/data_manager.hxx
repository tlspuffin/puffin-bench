#pragma once

#include "data.hxx"
#include "../../utils/file_tar_zst.hxx"
#include <string>
#include <filesystem>
#include <unordered_map>
#include <unordered_set>
#include <variant>
#include <cmath>

#include <iostream>

namespace ns_Analyze {

class DataManager {
public:
  enum class DataType : uint8_t { INT32, UINT32, INT64, UINT64, DOUBLE };
  struct SMetricInfos {
    std::string name_;
    DataType type_;
    size_t nbElement_;
    std::string file_;
  };
  struct SMetricsSummary {
    uint64_t id_;
    uint64_t nbClient_;
    uint64_t runTime_;
    std::vector<std::unordered_map<std::string, struct SMetricInfos>> summary_;
  };
  struct SMetricsSummaries {
    uint64_t nbRun_;
    std::vector<struct SMetricsSummary> runSummary_;
  };

  DataManager(std::string const& rootpath);
  std::vector<std::string> Commits(std::string const& type);
  std::vector<std::pair<std::string, uint64_t>> 
      CommitSubjects(std::string const& type, std::string const& commitID);
  struct ns_Analyze::DataManager::SMetricsSummaries CommitMetrics(
      std::string const& type, std::string const& commitID, 
      std::string const& subject);
  std::vector<std::variant<std::vector<uint64_t>, std::vector<double>>> CommitValues(
      std::string const& type, std::string const& commitID, 
      std::string const& subject, uint64_t min, uint64_t max, 
      uint64_t step, std::vector<uint64_t> const& runs,
      std::vector<uint64_t> const& clients,
      std::vector<std::string> const& metrics, std::string const& aggregate);

private:
  struct SInterpolations {
    std::pair<double, double> ratios;
    std::pair<uint64_t, uint64_t> offsets;
  };
  std::filesystem::path const rootpath_;
  std::unordered_map<std::string, 
      std::unordered_map<std::string, std::filesystem::path>> runsResults_;

  std::vector<struct SInterpolations> ExtractDataTS(FileTARZST& archive, 
      std::filesystem::path const& prefixPath, 
      struct SMetricInfos const& metricInfos, uint64_t min, uint64_t max, 
      uint64_t step);
  template<typename T>
  std::vector<T> ExtractData(FileTARZST& archive, std::string filename, 
      std::vector<struct ns_Analyze::DataManager::SInterpolations> dataPoints);

};

template<typename T>
inline std::vector<T> DataManager::ExtractData(FileTARZST& archive, 
    std::string filename, std::vector<struct ns_Analyze::DataManager::SInterpolations> dataPoints) {
  std::vector<T> result;
  result.reserve(dataPoints.size());

  std::vector<T> values(4*1024*1024);
  uint64_t fileOffset = 0; 
  uint64_t nbElementRead = 0;
  uint64_t lastElement = 0;

  std::vector<uint64_t> inOffset(2);
  std::vector<T> dataPointValues(2);

  for(struct ns_Analyze::DataManager::SInterpolations const& dataPoint: dataPoints) {
    // special code for out of range TS
    if ((dataPoint.ratios.first == 0.0) && (dataPoint.ratios.second == 0.0)) {
      result.push_back(0);
      continue;
    }

    inOffset = { dataPoint.offsets.first, dataPoint.offsets.second };
    for(int i=0; i<2; ++i) {
      uint64_t elementOffset = inOffset[i];
      if (elementOffset >= lastElement) {
        fileOffset = elementOffset;
        nbElementRead = archive.ExtractFileData(filename, values.size() * sizeof(T), 
            fileOffset * sizeof(T), (char*)(values.data()), nullptr) / sizeof(T);
        if (nbElementRead == 0) {
          uint64_t nbMissingElement = result.capacity() - result.size();
          result.insert(result.end(), nbMissingElement, T(0));
          return result;
        }          
        if (nbElementRead != values.size()) {
          values.resize(nbElementRead);
        }
        lastElement = fileOffset + values.size();
      }
      dataPointValues[i] = values[elementOffset - fileOffset];
    }
    if (inOffset[0] == inOffset[1]) {
      result.push_back(dataPointValues[0] * dataPoint.ratios.first);
    } else {
      result.push_back(dataPointValues[0] * dataPoint.ratios.first + dataPointValues[1] * dataPoint.ratios.second);
    }
  }

  return result;
}

};