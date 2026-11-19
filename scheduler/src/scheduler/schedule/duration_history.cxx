#include "duration_history.hxx"
#include "step.hxx"
#include "task.hxx"
#include "../../utils/logs.hxx"
#include "../../utils/md5_poco.hxx"
#include "../../utils/rapidjson.hxx"
#include "rapidjson/document.h"
#include <algorithm>
#include <fstream>
#include <map>
#include <vector>

ns_Schedule::DurationHistory& ns_Schedule::DurationHistory::Instance() {
  static DurationHistory instance;
  return instance;
}

std::string ns_Schedule::DurationHistory::Key(std::string const& jobType, std::string const& name,
    std::unordered_map<std::string, std::string> const& args) {
  // sorted, and each key and value prefixed by its length: no two sets of arguments give the same text
  std::map<std::string, std::string> const sorted(args.begin(), args.end());
  std::string text;
  for (auto const& [key, value] : sorted) {
    text += std::to_string(key.size()) + ":" + key + std::to_string(value.size()) + ":" + value;
  }
  return jobType + "|" + name + "|" + MD5(text).substr(0, 16);
}

std::string ns_Schedule::DurationHistory::Key(ns_Schedule::Step const& step) {
  return Key(step.task_ != nullptr ? step.task_->job_type_ : "", step.name_, step.args_);
}

std::string ns_Schedule::DurationHistory::Context(ns_Schedule::Step const& step) {
  return step.task_ != nullptr ? step.task_->duration_context_ : "";
}

uint64_t ns_Schedule::DurationHistory::Median(std::vector<uint64_t> values) {
  std::sort(values.begin(), values.end());
  return values[values.size() / 2];
}

uint64_t ns_Schedule::DurationHistory::MedianOf(std::deque<Sample> const& samples, uint32_t nbCores, size_t limit,
    std::function<bool(Sample const&)> const& keep) {
  std::vector<uint64_t> sameCores, all;
  // newest first
  for (auto it = samples.rbegin(); it != samples.rend(); ++it) {
    if (!keep(*it)) {
      continue;
    }
    if ((it->nbCores == nbCores) && (sameCores.size() < limit)) {
      sameCores.push_back(it->ms);
    }
    if (all.size() < limit) {
      all.push_back(it->ms);
    }
  }
  if (sameCores.size() >= minSamples_) {
    return Median(sameCores);
  }
  if (all.size() >= minSamples_) {
    return Median(all);
  }
  return 0;
}

void ns_Schedule::DurationHistory::AddSample(std::string const& key, Sample sample) {
  auto& samples = durations_[key];
  samples.push_back(std::move(sample));
  while (samples.size() > samples_) {
    samples.pop_front();
  }
}

void ns_Schedule::DurationHistory::Load(std::filesystem::path const& exportPath) {
  std::lock_guard lock(lock_);
  file_ = exportPath / "duration_history.json";
  durations_.clear();

  // { key: [ { "ms", "context", "nb_cores", "timed_out" }, ... ] }; missing or unreadable: seeded from the log of
  // the finished steps
  rapidjson::Document doc;
  if (std::filesystem::exists(file_) && ReadJSONFile(file_.string(), doc) && doc.IsObject()) {
    for (auto const& entry : doc.GetObject()) {
      if (!entry.value.IsArray()) {
        continue;
      }
      for (auto const& value : entry.value.GetArray()) {
        if (!value.IsObject()) {
          continue;
        }
        Sample sample;
        sample.ms = value.HasMember("ms") && value["ms"].IsUint64() ? value["ms"].GetUint64() : 0;
        sample.context = value.HasMember("context") && value["context"].IsString() ? value["context"].GetString() : "";
        sample.nbCores = value.HasMember("nb_cores") && value["nb_cores"].IsUint() ? value["nb_cores"].GetUint() : 0;
        sample.timedOut = value.HasMember("timed_out") && value["timed_out"].IsBool() && value["timed_out"].GetBool();
        if (sample.ms > 0) {
          AddSample(entry.name.GetString(), std::move(sample));
        }
      }
    }
    LOGI << "Step durations: " << static_cast<uint64_t>(durations_.size()) << " kinds of steps from " << file_.string()
         << Log::Flags::End;
    return;
  }
  Seed(exportPath / "steps_done.json");
  Save();
}

// the log of the finished steps (one JSON object per line), oldest first
bool ns_Schedule::DurationHistory::Seed(std::filesystem::path const& stepsDone) {
  std::ifstream ifs(stepsDone);
  std::string line;
  uint64_t count = 0;
  while (ifs.is_open() && std::getline(ifs, line)) {
    rapidjson::Document step;
    step.Parse(line.c_str());
    if (step.HasParseError() || !step.IsObject()) {
      continue;
    }
    if (!step.HasMember("state") || !step["state"].IsString()) {
      continue;
    }
    std::string const state = step["state"].GetString();
    if ((state != "Done") && (state != "TimedOut")) {
      continue;
    }
    if (!step.HasMember("time_points_ms") || !step["time_points_ms"].IsArray() ||
        (step["time_points_ms"].Size() != 2) || !step["time_points_ms"][0].IsUint64() ||
        !step["time_points_ms"][1].IsUint64()) {
      continue;
    }
    uint64_t const start = step["time_points_ms"][0].GetUint64();
    uint64_t const end = step["time_points_ms"][1].GetUint64();
    if ((start == 0) || (end <= start)) {
      continue;
    }
    std::string jobType, context;
    if (step.HasMember("task") && step["task"].IsObject()) {
      auto const& task = step["task"];
      if (task.HasMember("job_type") && task["job_type"].IsString()) {
        jobType = task["job_type"].GetString();
      }
      // steps finished before the duration contexts have none: they only count for the levels 2 and 3
      if (task.HasMember("duration_context") && task["duration_context"].IsString()) {
        context = task["duration_context"].GetString();
      }
    }
    std::unordered_map<std::string, std::string> args;
    if (step.HasMember("args") && step["args"].IsObject()) {
      for (auto const& arg : step["args"].GetObject()) {
        if (arg.value.IsString()) {
          args.emplace(arg.name.GetString(), arg.value.GetString());
        }
      }
    }
    std::string const name = step.HasMember("name") && step["name"].IsString() ? step["name"].GetString() : "";
    uint32_t const nbCores = step.HasMember("nb_cores") && step["nb_cores"].IsUint() ? step["nb_cores"].GetUint() : 0;
    AddSample(Key(jobType, name, args), Sample{ end - start, context, nbCores, state == "TimedOut" });
    ++count;
  }
  LOGI << "Step durations: " << count << " finished steps learned from " << stepsDone.string() << Log::Flags::End;
  return count > 0;
}

void ns_Schedule::DurationHistory::Save() const {
  if (file_.empty()) {
    return;
  }
  rapidjson::Document doc;
  doc.SetObject();
  auto& alloc = doc.GetAllocator();
  for (auto const& [key, samples] : durations_) {
    rapidjson::Value values(rapidjson::kArrayType);
    for (auto const& sample : samples) {
      rapidjson::Value value(rapidjson::kObjectType);
      value.AddMember("ms", sample.ms, alloc);
      value.AddMember("context", rapidjson::Value(sample.context.c_str(), alloc), alloc);
      value.AddMember("nb_cores", sample.nbCores, alloc);
      value.AddMember("timed_out", sample.timedOut, alloc);
      values.PushBack(value, alloc);
    }
    doc.AddMember(rapidjson::Value(key.c_str(), alloc), values, alloc);
  }
  if (!SaveJSONFile(file_.string(), doc, false)) {
    LOGW << "Unable to save " << file_.string() << Log::Flags::End;
  }
}

void ns_Schedule::DurationHistory::Add(ns_Schedule::Step const& step) {
  // Done (success or failure) and timed out steps; cancelled and launch errors have no run time
  uint64_t const durationMs = static_cast<uint64_t>(step.RunTime().count());
  if (durationMs == 0) {
    return;
  }
  if (step.task_ == nullptr) {
    return;
  }
  std::lock_guard lock(lock_);
  AddSample(Key(step), Sample{ durationMs, Context(step), step.nb_cores_, step.IsTimedOut() });
  Save();
}

std::deque<ns_Schedule::DurationHistory::Sample> const* ns_Schedule::DurationHistory::Samples(
    ns_Schedule::Step const& step) const {
  auto it = durations_.find(Key(step));
  return it != durations_.end() ? &it->second : nullptr;
}

uint64_t ns_Schedule::DurationHistory::Estimate(ns_Schedule::Step const& step) const {
  std::lock_guard lock(lock_);
  return EstimateLocked(step);
}

uint64_t ns_Schedule::DurationHistory::EstimateLocked(ns_Schedule::Step const& step) const {
  uint64_t const timeoutMs = step.timeout_ * 1000;
  uint64_t estimate = timeoutMs > 0 ? timeoutMs : defaultDurationMs_;
  auto const* samples = Samples(step);
  if (samples != nullptr) {
    std::string const context = Context(step);
    uint64_t median = 0;
    if (!context.empty()) {
      median = MedianOf(*samples, step.nb_cores_, sameContext_,
          [&context](Sample const& sample) { return sample.context == context; });
    }
    if (median == 0) {
      median = MedianOf(*samples, step.nb_cores_, recent_, [](Sample const& sample) { return !sample.timedOut; });
    }
    if (median == 0) {
      median = MedianOf(*samples, step.nb_cores_, recent_, [](Sample const&) { return true; });
    }
    if (median > 0) {
      estimate = median;
    }
    if ((timeoutMs > 0) && (estimate > timeoutMs)) {
      estimate = timeoutMs;
    }
  }
  return estimate;
}

uint64_t ns_Schedule::DurationHistory::EstimatedEnd(ns_Schedule::Step const& step, uint64_t nowMs) const {
  std::lock_guard lock(lock_);
  uint64_t const start = static_cast<uint64_t>(
      std::chrono::duration_cast<std::chrono::milliseconds>(step.StartTime().time_since_epoch()).count());
  uint64_t end = start + EstimateLocked(step);
  if (end <= nowMs) {
    // past its estimate: to its timeout when this kind of step has timed out before (in its context, or in any
    // context when its context has no run), else a minute from now
    bool timesOut = false;
    if ((step.timeout_ > 0) && (Samples(step) != nullptr)) {
      std::string const context = Context(step);
      bool sameKnown = false, sameTimedOut = false, anyTimedOut = false;
      for (auto const& sample : *Samples(step)) {
        anyTimedOut = anyTimedOut || sample.timedOut;
        if (!context.empty() && (sample.context == context)) {
          sameKnown = true;
          sameTimedOut = sameTimedOut || sample.timedOut;
        }
      }
      timesOut = sameKnown ? sameTimedOut : anyTimedOut;
    }
    end = timesOut ? start + step.timeout_ * 1000 : nowMs + 60000;
  }
  if (step.timeout_ > 0) {
    end = std::min(end, start + step.timeout_ * 1000);
  }
  // still running: not before now (e.g. past its timeout, while it is being stopped)
  return std::max(end, nowMs);
}
