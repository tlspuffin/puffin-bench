#include "statistics.hxx"
#include <cmath>

std::unordered_map<std::string, std::vector<struct ns_Analyze::DataManager::SMetricValues>>
    ns_Analyze::Statistics::ComputeStats(std::string const& metricName, 
    std::vector<struct ns_Analyze::DataManager::SMetricValues>& values, 
    std::vector<uint64_t>* runs) {
  std::unordered_map<std::string, std::vector<struct ns_Analyze::DataManager::SMetricValues>> results;
  std::vector<uint64_t> indexes;
  indexes.reserve(values.size());
  if (runs != nullptr) {
    for(uint64_t runID: *runs) {
      indexes.clear();
      for(uint64_t i=0; i<values.size(); ++i) {
        if (values[i].runID_ == runID) {
          indexes.push_back(i);
        }
      }
      results.merge(ComputeStats(metricName, values, indexes, &runID));
    }
  } else {
    for(uint64_t i=0; i<values.size(); ++i) {
      indexes.push_back(i);
    }
    results.merge(ComputeStats(metricName, values, indexes, nullptr));
  }
  return results;
}

std::unordered_map<std::string, std::vector<struct ns_Analyze::DataManager::SMetricValues>>
    ns_Analyze::Statistics::ComputeStats(std::string const& metricName, 
    std::vector<struct ns_Analyze::DataManager::SMetricValues>& values, 
    std::vector<uint64_t> const& indexes, uint64_t* id) {

  uint64_t count = indexes.size();
  std::vector<std::vector<double>> series(count);
  std::vector<bool> didSwap(count, false);
  for (uint64_t i=0; i<count; ++i) {
    if (std::holds_alternative<std::vector<double>>(values[i].values_)) {
      series[i].swap(std::get<std::vector<double>>(values[i].values_));
      didSwap[i] = true;
    } else {
      std::vector<uint64_t> const& uint64Data = std::get<std::vector<uint64_t>>(values[i].values_);
      series[i].assign(uint64Data.begin(), uint64Data.end());
    }
  }

  for (size_t i=0; i<count; ++i) {
    if (didSwap[i]) {
      std::get<std::vector<double>>(values[i].values_).swap(series[i]);
    }
  }

  struct StatsSeries stats = ComputeStats(series);

  std::string prefix;
  uint64_t idValue = 0;
  if (id != nullptr) { 
    prefix = "_" + std::to_string(*id);
    idValue = *id;
  }

  std::unordered_map<std::string, std::vector<struct ns_Analyze::DataManager::SMetricValues>> results;
  results[metricName + prefix + ".mean"] = {{ idValue, 0, { std::move(stats.mean) } }};
  results[metricName + prefix + ".ci_lower"] = {{ idValue, 0, { std::move(stats.ciLower) } }};
  results[metricName + prefix + ".ci_upper"] = {{ idValue, 0, { std::move(stats.ciUpper) } }};

  return results;
}

ns_Analyze::Statistics::StatsSeries ns_Analyze::Statistics::ComputeStats(
    std::vector<std::vector<double>> const& series, double confidence) {

  StatsSeries result;
  if (series.empty()) {
    return result;
  }
  size_t nbSeries = series.size();

  size_t nbElements = series[0].size();
  for (auto const& serie : series) {
    if (serie.size() != nbElements) {
      return result;
    }
  }

  double varianceDiv = nbSeries - 1;
  if (confidence == 0) {
    static const double tTable[] = { 
        12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228 
    };
    if (nbSeries < 2) {
      confidence = 12.706;
      varianceDiv = 1;
    } else if (nbSeries <= 11) {
      confidence = tTable[nbSeries - 2];
    } else {
      confidence = 1.96;
    }
  }

  result.mean.resize(nbElements);
  result.ciLower.resize(nbElements);
  result.ciUpper.resize(nbElements);

  std::vector<double> values(nbSeries);
  for (size_t i=0; i<nbElements; ++i) {  
    for(size_t j=0; j<nbSeries; ++j) {
      values[j] = series[j][i];
    }

    double sum = 0.0;
    for (double value : values) {
      sum += value;
    }
    double mean = sum / nbSeries;

    double variance = 0.0;
    for (double value : values) {
      double diff = value - mean;
      variance += diff * diff;
    }
    variance /= varianceDiv;
    double stddev = std::sqrt(variance);

    double margin = confidence * stddev;
    result.mean[i] = mean;
    result.ciLower[i] = std::max(0.0, mean - margin);
    result.ciUpper[i] = mean + margin;
  }

  return result;
}