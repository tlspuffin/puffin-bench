#pragma once

#include <cstdint>
#include <deque>
#include <filesystem>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

namespace ns_Schedule {

class Step;

// Durations of the finished steps, to estimate how long a pending or running step will take (start and end
// times of the board). A step is known by its task job type, its name and its configuration id: the last
// samples_ finished runs of each (Done, failed or timed out; not cancelled) are kept with their commit and whether
// they timed out, in <exportPath>/step_durations.json, seeded from <exportPath>/steps_done.json (also when the file
// is in the old format, durations only).
// Estimate of a step of commit C, capped by its timeout:
//  1. the median of the last sameCommit_ runs on C (at least minSamples_): the job scripts change over time, e.g. a
//     VulnA run that stopped on any objective now waits for its expected bug, which an old commit may not have;
//  2. else the median of the last recent_ runs that did not time out (a timeout mostly means "the bug is not at that
//     commit", not a typical duration);
//  3. else the median of the last recent_ runs; the timeout (or 10 min) without enough samples.
// A running step past its estimate is expected to end at its timeout when this kind of step has timed out before
// (on C, or on any commit when C has no run), else a minute from now; never before now (e.g. past its timeout).
class DurationHistory {
public:
  static DurationHistory& Instance();

  void Load(std::filesystem::path const& exportPath);
  void Add(Step const& step);
  // estimated duration of a step, in ms
  uint64_t Estimate(Step const& step) const;
  // estimated end of a running step, in ms since the epoch (see above), at most its timeout
  uint64_t EstimatedEnd(Step const& step, uint64_t nowMs) const;

private:
  struct Sample {
    uint64_t ms = 0;
    std::string commit;
    bool timedOut = false;
  };
  static constexpr size_t samples_ = 60;
  static constexpr size_t recent_ = 15;
  static constexpr size_t sameCommit_ = 5;
  static constexpr size_t minSamples_ = 2;
  static constexpr uint64_t defaultDurationMs_ = 600000;

  static std::string Key(std::string const& jobType, std::string const& name, std::string const& id);
  static std::string Commit(Step const& step);
  static uint64_t Median(std::vector<uint64_t> values);
  void AddSample(std::string const& key, Sample sample);
  bool Seed(std::filesystem::path const& stepsDone);
  void Save() const;
  // the samples of a step's kind, or nullptr
  std::deque<Sample> const* Samples(Step const& step) const;
  uint64_t EstimateLocked(Step const& step) const;

  mutable std::mutex lock_;
  std::filesystem::path file_;
  std::unordered_map<std::string, std::deque<Sample>> durations_;
};

};
