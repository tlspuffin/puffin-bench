#pragma once

#include <vector>
#include <string>
#include <variant>
#include <cstdint>

namespace ns_Analyze {

class Statistics {
public:
  static std::pair<std::vector<std::string>, std::vector<std::vector<double>>>
  ComputeStats(std::string const& metricName,
      std::vector<std::variant<std::vector<uint64_t>, std::vector<double>>>& data,
      size_t startIdx, size_t count);

private:
  struct StatsSeries {
    std::vector<double> mean;
    std::vector<double> ciLower;
    std::vector<double> ciUpper;
  };

  static StatsSeries ComputeStats(std::vector<std::vector<double>> const& series, 
      double confidence =0.0);

};

};
