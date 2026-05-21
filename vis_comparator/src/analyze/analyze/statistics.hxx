#pragma once

#include "data_manager.hxx"
#include <vector>
#include <string>
#include <variant>
#include <cstdint>

namespace ns_Analyze {

class Statistics {
public:
  static std::unordered_map<std::string, std::vector<struct ns_Analyze::DataManager::SMetricValues>>
      ComputeStats(std::string const& metricName, 
      std::vector<struct ns_Analyze::DataManager::SMetricValues>& values, 
      std::vector<uint64_t>* runs);

private:
  struct StatsSeries {
    std::vector<double> mean;
    std::vector<double> ciLower;
    std::vector<double> ciUpper;
  };

  static std::unordered_map<std::string, std::vector<struct ns_Analyze::DataManager::SMetricValues>> 
      ComputeStats(std::string const& metricName, 
      std::vector<struct ns_Analyze::DataManager::SMetricValues>& values, 
      std::vector<uint64_t> const& indexes, uint64_t* id);

  static StatsSeries ComputeStats(std::vector<std::vector<double>> const& series, 
      double confidence =0.0);

};

};
