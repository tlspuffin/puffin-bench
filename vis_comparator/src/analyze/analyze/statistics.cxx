#include "statistics.hxx"
#include <cmath>

std::pair<std::vector<std::string>, std::vector<std::vector<double>>>
ns_Analyze::Statistics::ComputeStats(std::string const& metricName,
      std::vector<std::variant<std::vector<uint64_t>, std::vector<double>>>& data,
      size_t startIdx, size_t count) {
  std::pair<std::vector<std::string>, std::vector<std::vector<double>>> result;

  std::vector<std::vector<double>> series(count);
  std::vector<bool> didSwap(count, false);
  for (size_t i=startIdx, j=0; (i<(startIdx + count)) && (i < data.size()); ++i, ++j) {
    if (std::holds_alternative<std::vector<double>>(data[i])) {
      series[j].swap(std::get<std::vector<double>>(data[i]));
      didSwap[j] = true;
    } else {
      std::vector<uint64_t> const& uint64Data = std::get<std::vector<uint64_t>>(data[i]);
      series[j].assign(uint64Data.begin(), uint64Data.end());
    }
  }

  struct StatsSeries stats = ComputeStats(series);

  for (size_t i=startIdx, j=0; (i<(startIdx + count)) && (i < data.size()); ++i, ++j) {
    if (didSwap[j]) {
      std::get<std::vector<double>>(data[i]).swap(series[j]);
    }
  }

  std::vector<std::string> names = {
      metricName + ".mean",
      metricName + ".ci_lower",
      metricName + ".ci_upper"
  };
    
  std::vector<std::vector<double>> statsData = {
      std::move(stats.mean),
      std::move(stats.ciLower),
      std::move(stats.ciUpper)
  };
    
  return {names, statsData};
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