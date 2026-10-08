#include "duration_history.hxx"
#include "step.hxx"
#include "task.hxx"
#include "../../utils/logs.hxx"
#include "../../utils/rapidjson.hxx"
#include "rapidjson/document.h"
#include <algorithm>
#include <fstream>
#include <vector>

ns_Schedule::DurationHistory& ns_Schedule::DurationHistory::Instance() {
  static DurationHistory instance;
  return instance;
}

std::string ns_Schedule::DurationHistory::Key(std::string const& jobType, std::string const& name,
    std::string const& id) {
  return jobType + "|" + name + "|" + id;
}

std::string ns_Schedule::DurationHistory::Commit(ns_Schedule::Step const& step) {
  if (step.task_ == nullptr) {
    return "";
  }
  auto it = step.task_->args_.find("COMMIT_ID");
  return it != step.task_->args_.end() ? it->second : "";
}

uint64_t ns_Schedule::DurationHistory::Median(std::vector<uint64_t> values) {
  std::sort(values.begin(), values.end());
  return values[values.size() / 2];
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
  file_ = exportPath / "step_durations.json";
  durations_.clear();

  // the current format: { key: [ { "ms", "commit", "timed_out" }, ... ] }; the old one (durations only) is replaced
  // by a seed from the log of the finished steps, which has their commit and state
  rapidjson::Document doc;
  bool current = std::filesystem::exists(file_) && ReadJSONFile(file_.string(), doc) && doc.IsObject();
  if (current) {
    for (auto const& entry : doc.GetObject()) {
      if (!entry.value.IsArray()) {
        continue;
      }
      for (auto const& value : entry.value.GetArray()) {
        if (!value.IsObject()) {
          current = false;
          break;
        }
        Sample sample;
        sample.ms = value.HasMember("ms") && value["ms"].IsUint64() ? value["ms"].GetUint64() : 0;
        sample.commit = value.HasMember("commit") && value["commit"].IsString() ? value["commit"].GetString() : "";
        sample.timedOut = value.HasMember("timed_out") && value["timed_out"].IsBool() && value["timed_out"].GetBool();
        if (sample.ms > 0) {
          AddSample(entry.name.GetString(), std::move(sample));
        }
      }
      if (!current) {
        break;
      }
    }
  }
  if (current) {
    LOGI << "Step durations: " << static_cast<uint64_t>(durations_.size()) << " kinds of steps from " << file_.string()
         << Log::Flags::End;
    return;
  }
  durations_.clear();
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
    std::string jobType, commit;
    if (step.HasMember("task") && step["task"].IsObject()) {
      auto const& task = step["task"];
      if (task.HasMember("job_type") && task["job_type"].IsString()) {
        jobType = task["job_type"].GetString();
      }
      if (task.HasMember("args") && task["args"].IsArray()) {
        for (auto const& arg : task["args"].GetArray()) {
          if (arg.IsObject() && arg.HasMember("key") && arg["key"].IsString() &&
              (std::string(arg["key"].GetString()) == "COMMIT_ID") && arg.HasMember("value") && arg["value"].IsString()) {
            commit = arg["value"].GetString();
          }
        }
      }
    }
    std::string const name = step.HasMember("name") && step["name"].IsString() ? step["name"].GetString() : "";
    std::string const id = step.HasMember("id") && step["id"].IsString() ? step["id"].GetString() : "";
    AddSample(Key(jobType, name, id), Sample{ end - start, commit, state == "TimedOut" });
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
      value.AddMember("commit", rapidjson::Value(sample.commit.c_str(), alloc), alloc);
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
  AddSample(Key(step.task_->job_type_, step.name_, step.id_),
      Sample{ durationMs, Commit(step), step.IsTimedOut() });
  Save();
}

std::deque<ns_Schedule::DurationHistory::Sample> const* ns_Schedule::DurationHistory::Samples(
    ns_Schedule::Step const& step) const {
  auto it = durations_.find(Key(step.task_->job_type_, step.name_, step.id_));
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
    std::string const commit = Commit(step);
    std::vector<uint64_t> same, finished, recent;
    // newest first
    for (auto it = samples->rbegin(); it != samples->rend(); ++it) {
      if (!commit.empty() && (it->commit == commit) && (same.size() < sameCommit_)) {
        same.push_back(it->ms);
      }
      if (!it->timedOut && (finished.size() < recent_)) {
        finished.push_back(it->ms);
      }
      if (recent.size() < recent_) {
        recent.push_back(it->ms);
      }
    }
    if (same.size() >= minSamples_) {
      estimate = Median(same);
    } else if (finished.size() >= minSamples_) {
      estimate = Median(finished);
    } else if (recent.size() >= minSamples_) {
      estimate = Median(recent);
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
    // past its estimate: to its timeout when this kind of step has timed out before (on its commit, or on any commit
    // when its commit has no run), else a minute from now
    bool timesOut = false;
    if ((step.timeout_ > 0) && (Samples(step) != nullptr)) {
      std::string const commit = Commit(step);
      bool sameKnown = false, sameTimedOut = false, anyTimedOut = false;
      for (auto const& sample : *Samples(step)) {
        anyTimedOut = anyTimedOut || sample.timedOut;
        if (!commit.empty() && (sample.commit == commit)) {
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
