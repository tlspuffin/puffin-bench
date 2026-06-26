#include "statistics.hxx"
#include <cmath>

namespace {

// Two-sided Student-t critical values for the supported confidence levels.
// Rows are degrees of freedom df = 1..30; `z` is the df->infinity (normal) limit
// used for df > 30. Source: standard t-distribution table.
struct CILevel {
  int percent;
  double t[30];
  double z;
};

static const CILevel kCILevels[] = {
  { 60, { 1.376, 1.061, 0.978, 0.941, 0.920, 0.906, 0.896, 0.889, 0.883, 0.879,
          0.876, 0.873, 0.870, 0.868, 0.866, 0.865, 0.863, 0.862, 0.861, 0.860,
          0.859, 0.858, 0.858, 0.857, 0.856, 0.856, 0.855, 0.855, 0.854, 0.854 }, 0.842 },
  { 70, { 1.963, 1.386, 1.250, 1.190, 1.156, 1.134, 1.119, 1.108, 1.100, 1.093,
          1.088, 1.083, 1.079, 1.076, 1.074, 1.071, 1.069, 1.067, 1.066, 1.064,
          1.063, 1.061, 1.060, 1.059, 1.058, 1.058, 1.057, 1.056, 1.055, 1.055 }, 1.036 },
  { 80, { 3.078, 1.886, 1.638, 1.533, 1.476, 1.440, 1.415, 1.397, 1.383, 1.372,
          1.363, 1.356, 1.350, 1.345, 1.341, 1.337, 1.333, 1.330, 1.328, 1.325,
          1.323, 1.321, 1.319, 1.318, 1.316, 1.315, 1.314, 1.313, 1.311, 1.310 }, 1.282 },
  { 90, { 6.314, 2.920, 2.353, 2.132, 2.015, 1.943, 1.895, 1.860, 1.833, 1.812,
          1.796, 1.782, 1.771, 1.761, 1.753, 1.746, 1.740, 1.734, 1.729, 1.725,
          1.721, 1.717, 1.714, 1.711, 1.708, 1.706, 1.703, 1.701, 1.699, 1.697 }, 1.645 },
  { 95, { 12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228,
          2.201, 2.179, 2.160, 2.145, 2.131, 2.120, 2.110, 2.101, 2.093, 2.086,
          2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045, 2.042 }, 1.960 },
  { 98, { 31.821, 6.965, 4.541, 3.747, 3.365, 3.143, 2.998, 2.896, 2.821, 2.764,
          2.718, 2.681, 2.650, 2.624, 2.602, 2.583, 2.567, 2.552, 2.539, 2.528,
          2.518, 2.508, 2.500, 2.492, 2.485, 2.479, 2.473, 2.467, 2.462, 2.457 }, 2.326 },
  { 99, { 63.657, 9.925, 5.841, 4.604, 4.032, 3.707, 3.499, 3.355, 3.250, 3.169,
          3.106, 3.055, 3.012, 2.977, 2.947, 2.921, 2.898, 2.878, 2.861, 2.845,
          2.831, 2.819, 2.807, 2.797, 2.787, 2.779, 2.771, 2.763, 2.756, 2.750 }, 2.576 },
};

// Returns the two-sided t/z multiplier for the requested confidence level and
// sample size. Unknown levels fall back to 95%. A single sample (nbSeries < 2)
// is treated as df = 1.
double GetCIMultiplier(int ciPercent, size_t nbSeries) {
  const CILevel* level = nullptr;
  for (auto const& l : kCILevels) {
    if (l.percent == ciPercent) { level = &l; break; }
  }
  if (level == nullptr) {
    for (auto const& l : kCILevels) {
      if (l.percent == 95) { level = &l; break; }
    }
  }
  size_t df = (nbSeries < 2) ? 1 : (nbSeries - 1);
  if (df >= 1 && df <= 30) {
    return level->t[df - 1];
  }
  return level->z;
}

}  // namespace

std::unordered_map<std::string, std::vector<struct ns_Analyze::DataManager::SMetricValues>>
    ns_Analyze::Statistics::ComputeStats(std::string const& metricName,
    std::vector<struct ns_Analyze::DataManager::SMetricValues>& values,
    std::vector<uint64_t>* runs, int ciPercent) {
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
      results.merge(ComputeStats(metricName, values, indexes, &runID, ciPercent));
    }
  } else {
    for(uint64_t i=0; i<values.size(); ++i) {
      indexes.push_back(i);
    }
    results.merge(ComputeStats(metricName, values, indexes, nullptr, ciPercent));
  }
  return results;
}

std::unordered_map<std::string, std::vector<struct ns_Analyze::DataManager::SMetricValues>>
    ns_Analyze::Statistics::ComputeStats(std::string const& metricName,
    std::vector<struct ns_Analyze::DataManager::SMetricValues>& values,
    std::vector<uint64_t> const& indexes, uint64_t* id, int ciPercent) {

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

  struct StatsSeries stats = ComputeStats(series, ciPercent);

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
    std::vector<std::vector<double>> const& series, int ciPercent) {

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

  // A single sample has no spread; keep the historical fallback of dividing by 1
  // (df = 1) rather than 0. The multiplier is chosen for the requested CI level.
  double varianceDiv = (nbSeries < 2) ? 1 : (nbSeries - 1);
  double multiplier = GetCIMultiplier(ciPercent, nbSeries);

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

    double margin = multiplier * stddev;
    result.mean[i] = mean;
    result.ciLower[i] = std::max(0.0, mean - margin);
    result.ciUpper[i] = mean + margin;
  }

  return result;
}