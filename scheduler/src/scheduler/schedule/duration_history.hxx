#pragma once

#include <cstdint>
#include <deque>
#include <filesystem>
#include <functional>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

namespace ns_Schedule {

class Step;

// Durations of the finished steps, to estimate how long a pending or running step will take (start and end
// times of the board).
// A kind of step is its task job type, its name and a digest of its arguments (the step's configuration, after the
// overrides): "<job_type>|<name>|<digest>". The last samples_ finished runs of each kind (Done, failed or timed
// out; not cancelled) are kept, oldest first, with their duration context, their number of cores and whether they
// timed out, in <exportPath>/duration_history.json, seeded from <exportPath>/steps_done.json when it is missing.
// The duration context of a run is the "duration_context" of its job, resolved with the task's arguments (e.g.
// "${COMMIT_ID}"): runs with the same context are expected to last the same; empty when the job has none.
// Estimate of a step, capped by its timeout; at each level, the samples with the step's number of cores are
// preferred when there are at least minSamples_ of them, else all the samples of that level are used:
//  1. the median of the last sameContext_ runs with the step's context (at least minSamples_; not with an empty
//     context): e.g. a VulnA run waits for its expected bug, which a given commit may not have;
//  2. else the median of the last recent_ runs that did not time out (a timeout mostly means "the bug is not in
//     that context", not a typical duration);
//  3. else the median of the last recent_ runs; the timeout (or 10 min) without enough samples.
// A running step past its estimate is expected to end at its timeout when this kind of step has timed out before
// (in its context, or in any context when its context has no run), else a minute from now; never before now (e.g.
// past its timeout).
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
    std::string context;
    uint32_t nbCores = 0;
    bool timedOut = false;
  };
  static constexpr size_t samples_ = 60;
  static constexpr size_t recent_ = 15;
  static constexpr size_t sameContext_ = 5;
  static constexpr size_t minSamples_ = 2;
  static constexpr uint64_t defaultDurationMs_ = 600000;

  // "<job_type>|<name>|<digest of the arguments>"; the digest does not depend on the order of the arguments
  static std::string Key(std::string const& jobType, std::string const& name,
      std::unordered_map<std::string, std::string> const& args);
  static std::string Key(Step const& step);
  static std::string Context(Step const& step);
  static uint64_t Median(std::vector<uint64_t> values);
  // the median of the newest samples kept by `keep` (at most `limit`), those with nbCores first (see above); 0
  // without minSamples_ of them
  static uint64_t MedianOf(std::deque<Sample> const& samples, uint32_t nbCores, size_t limit,
      std::function<bool(Sample const&)> const& keep);
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
