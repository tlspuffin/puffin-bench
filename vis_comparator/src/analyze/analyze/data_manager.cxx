#include "data_manager.hxx"
#include "../../utils/file_tgz.hxx"
#include "../../utils/compress_tar_zst.hxx"
#include "../../utils/rapidjson.hxx"
#include "../../utils/logs.hxx"
#include <vector>
#include <fstream>
#include <regex>
#include "rapidjson/document.h"
#include "rapidjson/istreamwrapper.h"
#include "rapidjson/ostreamwrapper.h"
#include "rapidjson/writer.h"

static std::regex const reIsNumber("^[0-9]+$");
static std::regex const reRunKeyFiles("^(?:.*/)?(logs/.+|artefacts/(?:[^/]+/)*[0-9]+-(?:stats\\.json|README\\.md))$");
static std::regex const reStats("^((?:.*/)?(artefacts/(?:[^/]+/)*([0-9]+))-stats\\.json)$");
static std::regex const reTypePerf("^Perf.*$");
static std::regex const reTypeVuln("^Vuln.*$");

// Escapes regex metacharacters so a free-form subject name is matched literally.
static std::string RegexEscape(std::string const& s) {
  static std::string const specials = ".^$|()[]{}*+?\\";
  std::string out;
  out.reserve(s.size());
  for (char c : s) {
    if (specials.find(c) != std::string::npos) {
      out.push_back('\\');
    }
    out.push_back(c);
  }
  return out;
}

ns_Analyze::DataManager::DataType StringToDataType(std::string const& type) {
  if (type == "int32") {
    return ns_Analyze::DataManager::DataType::INT32;
  } else if (type == "uint32") {
    return ns_Analyze::DataManager::DataType::UINT32;
  } else if (type == "int64") {
    return ns_Analyze::DataManager::DataType::INT64;
  } else if (type == "uint64") {
    return ns_Analyze::DataManager::DataType::UINT64;
  } else if (type == "double") {
    return ns_Analyze::DataManager::DataType::DOUBLE;
  } else {
    throw std::runtime_error("Unknown DataType " + type);
  }
}

size_t DataTypeToDataSize(ns_Analyze::DataManager::DataType type) {
  switch ((type)) {
    case ns_Analyze::DataManager::DataType::INT32:
      return sizeof(int32_t);
    case ns_Analyze::DataManager::DataType::UINT32:
      return sizeof(uint32_t);
    case ns_Analyze::DataManager::DataType::INT64:
      return sizeof(int64_t);
    case ns_Analyze::DataManager::DataType::UINT64:
      return sizeof(uint64_t);
    case ns_Analyze::DataManager::DataType::DOUBLE:
      return sizeof(double);
    default:
      throw std::runtime_error("Unknown DataType");
  }
}

std::string DataTypeToString(ns_Analyze::DataManager::DataType type) {
  switch ((type)) {
    case ns_Analyze::DataManager::DataType::INT32:
      return "INT32";
    case ns_Analyze::DataManager::DataType::UINT32:
      return "UINT32";
    case ns_Analyze::DataManager::DataType::INT64:
      return "INT64";
    case ns_Analyze::DataManager::DataType::UINT64:
      return "UINT64";
    case ns_Analyze::DataManager::DataType::DOUBLE:
      return "DOUBLE";
    default:
      throw std::runtime_error("Unknown DataType");
  }
}

struct ns_Analyze::DataManager::SMetricsSummary MetricsSummatries(uint64_t id, std::string const& metadataJSON) {
  struct ns_Analyze::DataManager::SMetricsSummary results {0};

  rapidjson::Document doc;
  doc.Parse(metadataJSON.c_str());
  if (doc.HasParseError()) {
    throw std::runtime_error("Wrongly formatted JSON: " + metadataJSON);
  }

  results.id_ = id;
  results.nbClient_ = Get<uint64_t>(doc, "nb_client");
  results.runTime_ = Get<uint64_t>(doc, "run_time");

  results.summary_.resize(results.nbClient_+1); // 0 global 1...N clients

  if ((!doc.HasMember("series")) || (!doc["series"].IsObject())) {
    throw std::runtime_error("JSON data missing series array");
  }
  std::stack<std::pair<const rapidjson::Value*, std::string>> stack;
  rapidjson::Value const& value = doc["series"].GetObject();
  stack.push({&value, ""});
  while(!stack.empty()) {
    auto [current, path] = stack.top();
    stack.pop();
    for (auto it = current->MemberBegin(); it != current->MemberEnd(); ++it) {
      std::string fieldName = it->name.GetString();
      std::string fullName = path.empty() ? fieldName : path + "." + fieldName;
      const rapidjson::Value& value = it->value;
      if (value.IsObject() && (!value.HasMember("type"))) {
        stack.push({&value, fullName});
      } else {
        struct ns_Analyze::DataManager::SMetricInfos infos;
        infos.name_ = fieldName;
        infos.type_ = StringToDataType(Get<std::string>(value, "type"));
        infos.nbElement_ = Get<uint64_t>(value, "count");
        infos.file_ = Get<std::string>(value, "file");

        size_t prefixPos = fullName.find('.');
        if (prefixPos == std::string::npos) {
          throw std::runtime_error("Wrongly formatted name (no prefix): " + fullName);
        }
        std::string prefix = fullName.substr(0, prefixPos);
        std::string suffix = fullName.substr(prefixPos + 1);
        long index = 0;
        if (prefix != "global") {
          static std::regex reClientID("client_([0-9]+)");
          std::smatch match;
          if (!std::regex_match(prefix, match, reClientID)) {
            throw std::runtime_error("Wrongly formatted name (no index): " + fullName);
          }
          index = std::strtol(match[1].str().c_str(), nullptr, 10);
          if (index >= results.summary_.size()) {
            throw std::runtime_error("Wrongly formatted name (index invalid): " + fullName);
          }
        }
        results.summary_[index].emplace(suffix, infos);
      }
    }
  }

  /*std::unordered_set<std::string> clientsCommonData_;
  if (nbClient_ > 0) {
    for(auto const& [name, infos]: datasSummary_[1]) {
      bool found = true;
      for(int i=2; i<datasSummary_.size(); ++i) {
        if (datasSummary_[i].count(name) == 0) {
          found = false;
          break;
        }
      }
      if (found) {
        clientsCommonData_.insert(name);
      }
    }
  }*/

  return results;
}


// Pull task.user and task.args[].{key=="COMMIT_ID"}.value from the sidecar <ts>.json.
// The sidecar holds the task metadata but no clean subjects field.
static void ParseSidecar(std::filesystem::path const& jsonFile,
    std::string& user, std::string& commitId) {
  std::ifstream ifs(jsonFile);
  if (!ifs) {
    return;
  }
  rapidjson::IStreamWrapper isw(ifs);
  rapidjson::Document doc;
  doc.ParseStream(isw);
  if (doc.HasParseError() || !doc.IsObject()) {
    return;
  }
  auto taskIt = doc.FindMember("task");
  if (taskIt == doc.MemberEnd() || !taskIt->value.IsObject()) {
    return;
  }
  auto const& task = taskIt->value;
  auto userIt = task.FindMember("user");
  if (userIt != task.MemberEnd() && userIt->value.IsString()) {
    user = userIt->value.GetString();
  }
  auto argsIt = task.FindMember("args");
  if (argsIt != task.MemberEnd() && argsIt->value.IsArray()) {
    for (auto const& e : argsIt->value.GetArray()) {
      if (!e.IsObject()) {
        continue;
      }
      auto kIt = e.FindMember("key");
      auto vIt = e.FindMember("value");
      if (kIt != e.MemberEnd() && kIt->value.IsString() &&
          std::string(kIt->value.GetString()) == "COMMIT_ID" &&
          vIt != e.MemberEnd() && vIt->value.IsString()) {
        commitId = vIt->value.GetString();
      }
    }
  }
}

// Read the subject names from the archive top-level metadata.json ({subject: count}).
// FileTARZST seeks to this tiny file in the seekable zstd+tar — no full decompress.
static std::vector<std::string> ReadSubjects(std::filesystem::path const& zstPath) {
  std::vector<std::string> subjects;
  try {
    FileTARZST archive(zstPath.string());
    std::vector<char> buffer;
    archive.ExtractFile("metadata.json", buffer);
    if (buffer.empty()) {
      return subjects;
    }
    buffer.push_back(0);
    rapidjson::Document doc;
    doc.Parse(buffer.data());
    if (doc.HasParseError() || !doc.IsObject()) {
      return subjects;
    }
    for (auto it = doc.MemberBegin(); it != doc.MemberEnd(); ++it) {
      subjects.push_back(it->name.GetString());
    }
  } catch (std::exception const& e) {
    LOGW(std::string("Could not read subjects from ") + zstPath.string() + ": " + e.what());
  }
  return subjects;
}

ns_Analyze::DataManager::DataManager(Config const& config)
    : config_(config), rootpath_(config.dataPath_)
{
  BuildIndex();
}

// (mtime,size) fingerprint of the .zst, used to skip re-parsing unchanged runs.
static void Fingerprint(std::filesystem::path const& zstPath, int64_t& mtime, uint64_t& size) {
  std::error_code ec;
  auto t = std::filesystem::last_write_time(zstPath, ec);
  mtime = ec ? 0 : (int64_t)t.time_since_epoch().count();
  size = ec ? 0 : (uint64_t)std::filesystem::file_size(zstPath, ec);
}

void ns_Analyze::DataManager::BuildIndex() {
  std::filesystem::path const cachePath = rootpath_ / ".project/vis_comparator-index.json";

  // ── Load the persistent cache: relpath -> (RunEntry, fingerprint) ──────────
  std::unordered_map<std::string, RunEntry> cache;
  size_t cacheRawCount = 0;  // valid entries in the file, before dedup by relpath
  {
    std::ifstream ifs(cachePath);
    if (ifs) {
      rapidjson::IStreamWrapper isw(ifs);
      rapidjson::Document doc;
      doc.ParseStream(isw);
      if (!doc.HasParseError() && doc.IsObject() && doc.HasMember("entries") &&
          doc["entries"].IsArray()) {
        auto hasStr = [](rapidjson::Value const& v, char const* k) {
          return v.HasMember(k) && v[k].IsString();
        };
        for (auto const& e : doc["entries"].GetArray()) {
          // Treat any malformed/stale entry as a cache miss: skip it so the run
          // gets re-parsed fresh during the walk below.
          if (!e.IsObject() || !hasStr(e, "kind") || !hasStr(e, "type") ||
              !hasStr(e, "commit") || !e.HasMember("timestamp") || !e["timestamp"].IsUint64() ||
              !hasStr(e, "user") || !hasStr(e, "campaign") || !hasStr(e, "relpath") ||
              !e.HasMember("mtime") || !e["mtime"].IsInt64() ||
              !e.HasMember("size") || !e["size"].IsUint64() ||
              !e.HasMember("subjects") || !e["subjects"].IsArray()) {
            continue;
          }
          RunEntry r{};
          r.kind      = e["kind"].GetString();
          r.type      = e["type"].GetString();
          r.commit    = e["commit"].GetString();
          r.timestamp = e["timestamp"].GetUint64();
          r.user      = e["user"].GetString();
          r.campaign  = e["campaign"].GetString();
          r.relpath   = std::filesystem::path(e["relpath"].GetString());
          r.mtime     = e["mtime"].GetInt64();
          r.size      = e["size"].GetUint64();
          bool subjectsOk = true;
          for (auto const& s : e["subjects"].GetArray()) {
            if (!s.IsString()) { subjectsOk = false; break; }
            r.subjects.push_back(s.GetString());
          }
          if (!subjectsOk) {
            continue;
          }
          ++cacheRawCount;
          cache.emplace(r.relpath.string(), std::move(r));
        }
      }
    }
  }
  // Build into locals and swap into the members at the end, so a mid-walk
  // failure (e.g. a run directory deleted underneath us) can't leave the live
  // index empty or partial, and concurrent readers keep seeing the old index
  // for the whole scan instead of blocking on it.
  std::vector<RunEntry> index;
  std::unordered_map<std::string,
      std::unordered_map<std::string, std::map<uint64_t, size_t>>> byTriple;

  // Track whether the index differs from the on-disk cache, to skip the rewrite
  // when nothing changed. Set on any fresh parse below; a final count check also
  // catches deletions and heals a bloated cache (duplicate entries from an
  // earlier bug collapse on load, so the rebuilt index has fewer runs).
  bool dirty = false;

  // ── Walk the data root for runs (one .zst with numeric stem + sibling .json) ─
  // Use the error_code overloads so a run directory vanishing mid-walk (a race
  // with run cleanup) skips that entry instead of throwing and aborting the
  // whole rebuild.
  std::error_code walkEc;
  auto const walkEnd = std::filesystem::recursive_directory_iterator();
  for (auto it = std::filesystem::recursive_directory_iterator(rootpath_, walkEc);
       it != walkEnd; it.increment(walkEc)) {
    if (walkEc) {
      LOGW(std::string("Run index walk aborted: ") + walkEc.message());
      break;
    }
    auto const& entry = *it;
    std::filesystem::path const& path = entry.path();

    if (entry.is_directory()) {
      std::string const dirName = path.filename().string();
      if (!dirName.empty() && dirName.front() == '.') {
        it.disable_recursion_pending();
      }
      continue;
    }

    std::string const taskID = path.stem();
    if ((!entry.is_regular_file()) || (path.extension() != ".zst") ||
        (!std::regex_match(taskID, reIsNumber))) {
      continue;
    }
    std::filesystem::path jsonFile = path;
    jsonFile.replace_extension(".json");
    if (!std::filesystem::exists(jsonFile)) {
      continue;
    }

    std::filesystem::path relativePath = path.lexically_relative(rootpath_);
    relativePath.replace_extension("");
    std::string const relKey = relativePath.string();

    int64_t mtime;
    uint64_t size;
    Fingerprint(path, mtime, size);

    // Reuse the cached entry when the fingerprint matches (no archive/sidecar open).
    auto cached = cache.find(relKey);
    if (cached != cache.end() && cached->second.mtime == mtime &&
        cached->second.size == size) {
      index.push_back(cached->second);
      continue;
    }

    // ── Fresh parse ──────────────────────────────────────────────────────────
    dirty = true;
    std::cout << "[index] Parsing run " << relKey << std::endl;
    RunEntry run{};
    run.timestamp = std::strtoull(taskID.c_str(), nullptr, 10);
    run.relpath   = relativePath;
    run.mtime     = mtime;
    run.size      = size;
    run.subjects  = ReadSubjects(path);

    std::string user, commitId;
    ParseSidecar(jsonFile, user, commitId);
    run.user = user;

    // Classify by the top-level path segment.
    std::string topSegment;
    for (auto const& part : relativePath) { topSegment = part.string(); break; }

    if (topSegment == "Campaign") {
      // Campaign/<user>/<campaign>/<ts>
      run.kind     = "campaign";
      run.type     = "Campaign";
      run.commit   = commitId;  // from sidecar COMMIT_ID
      run.user     = run.user.empty()
          ? path.parent_path().parent_path().stem().string() : run.user;
      run.campaign = path.parent_path().stem().string();
    } else {
      // <...>/<commit>/<tasktype>/<ts>  (tolerant of a leading PR/ prefix)
      run.kind   = "commit";
      run.type   = path.parent_path().stem().string();
      run.commit = path.parent_path().parent_path().stem().string();
    }

    index.push_back(std::move(run));
  }

  // ── Build the runId resolution map ─────────────────────────────────────────
  for (size_t i = 0; i < index.size(); ++i) {
    RunEntry const& r = index[i];
    byTriple[r.type][r.commit][r.timestamp] = i;
  }

  // If the rebuilt index has a different run count than the file held, the data
  // changed (deletion) or the file carried duplicates worth rewriting cleanly.
  if (index.size() != cacheRawCount) {
    dirty = true;
  }

  // ── Persist the index only when the on-disk data actually changed ──────────
  // (Build the JSON from the local `index` before it is moved into the member.)
  if (dirty) {
  std::cout << "[index] Reindexed " << rootpath_.string() << ": "
            << index.size() << " runs (" << cache.size() << " cached)"
            << std::endl;
  {
    rapidjson::Document doc;
    doc.SetObject();
    auto& alloc = doc.GetAllocator();
    rapidjson::Value entries(rapidjson::kArrayType);
    for (RunEntry const& r : index) {
      rapidjson::Value e(rapidjson::kObjectType);
      e.AddMember("kind", rapidjson::Value(r.kind.c_str(), alloc), alloc);
      e.AddMember("type", rapidjson::Value(r.type.c_str(), alloc), alloc);
      e.AddMember("commit", rapidjson::Value(r.commit.c_str(), alloc), alloc);
      e.AddMember("timestamp", r.timestamp, alloc);
      e.AddMember("user", rapidjson::Value(r.user.c_str(), alloc), alloc);
      e.AddMember("campaign", rapidjson::Value(r.campaign.c_str(), alloc), alloc);
      e.AddMember("relpath", rapidjson::Value(r.relpath.string().c_str(), alloc), alloc);
      e.AddMember("mtime", r.mtime, alloc);
      e.AddMember("size", r.size, alloc);
      rapidjson::Value subjects(rapidjson::kArrayType);
      for (std::string const& s : r.subjects) {
        subjects.PushBack(rapidjson::Value(s.c_str(), alloc), alloc);
      }
      e.AddMember("subjects", subjects, alloc);
      entries.PushBack(e, alloc);
    }
    doc.AddMember("entries", entries, alloc);

    std::error_code mkdirEc;
    std::filesystem::create_directories(cachePath.parent_path(), mkdirEc);
    std::ofstream ofs(cachePath);
    if (ofs) {
      rapidjson::OStreamWrapper osw(ofs);
      rapidjson::Writer<rapidjson::OStreamWrapper> writer(osw);
      doc.Accept(writer);
      std::cout << "[index] Wrote run index cache to " << cachePath.string() << std::endl;
    } else {
      LOGW("Could not write run index cache to " + cachePath.string());
    }
  }
  }

  // ── Install the freshly built index, replacing the previous one atomically ──
  // The swap is the only place the members are mutated, so concurrent readers
  // see either the old or the new index, never a half-built one.
  std::lock_guard<std::mutex> lk(mutex_);
  runIndex_ = std::move(index);
  runsByTriple_ = std::move(byTriple);
}

void ns_Analyze::DataManager::Refresh() {
  // Collapse the burst of listing requests a single page load fires into one
  // rebuild; manual page reloads are seconds apart, well past this window.
  // Claim the slot under the lock (so two threads can't rebuild at once), then
  // release it before the walk: BuildIndex() does its own filesystem I/O
  // unlocked and only re-takes the lock for the final atomic swap, so readers
  // are never blocked for the duration of the scan.
  {
    std::lock_guard<std::mutex> lk(mutex_);
    auto now = std::chrono::steady_clock::now();
    if (now - lastRefresh_ < std::chrono::seconds(1)) {
      return;
    }
    lastRefresh_ = now;
  }
  BuildIndex();
}

std::optional<ns_Analyze::DataManager::RunEntry> ns_Analyze::DataManager::Resolve(
    std::string const& type, std::string const& commit, uint64_t timestamp) {
  std::lock_guard<std::mutex> lk(mutex_);
  auto t = runsByTriple_.find(type);
  if (t == runsByTriple_.end()) {
    return std::nullopt;
  }
  auto c = t->second.find(commit);
  if (c == t->second.end()) {
    return std::nullopt;
  }
  auto ts = c->second.find(timestamp);
  if (ts == c->second.end()) {
    return std::nullopt;
  }
  return runIndex_[ts->second];
}

std::vector<std::pair<std::string, uint64_t>>
ns_Analyze::DataManager::Commits(std::string const& type) {
  Refresh();
  std::lock_guard<std::mutex> lk(mutex_);
  auto t = runsByTriple_.find(type);
  if (t == runsByTriple_.end()) {
    return {};
  }
  std::vector<std::pair<std::string, uint64_t>> result;
  result.reserve(t->second.size());
  for (auto const& [commitID, byTs] : t->second) {
    uint64_t latest = byTs.empty() ? 0 : byTs.rbegin()->first;
    result.emplace_back(commitID, latest);
  }
  return result;
}

std::vector<ns_Analyze::DataManager::RunEntry>
ns_Analyze::DataManager::Campaigns() {
  Refresh();
  std::lock_guard<std::mutex> lk(mutex_);
  std::vector<RunEntry> result;
  for (RunEntry const& run : runIndex_) {
    if (run.kind == "campaign") {
      result.push_back(run);
    }
  }
  return result;
}

std::string ns_Analyze::DataManager::RunTag(std::string const& type,
    std::string const& commitID, uint64_t timestamp) {
  std::optional<RunEntry> run = Resolve(type, commitID, timestamp);
  if (!run) {
    return "";
  }
  return std::to_string(run->mtime) + ":" + std::to_string(run->size);
}

std::vector<std::pair<std::string, uint64_t>>
    ns_Analyze::DataManager::CommitSubjects(
    std::string const& type, std::string const& commitID, uint64_t timestamp) {
  std::vector<std::pair<std::string, uint64_t>> result{};

  std::optional<RunEntry> run = Resolve(type, commitID, timestamp);
  if (!run) {
    return result;
  }
  std::string binFilename = rootpath_ / (run->relpath.string() + ".zst");
  FileTARZST archive(binFilename);
  std::vector<char> buffer;
  archive.ExtractFile("metadata.json", buffer);
  if (buffer.empty()) {
    throw std::runtime_error("metadata.json is empty");
  }
  rapidjson::Document doc;
  doc.Parse(buffer.data());
  if (doc.HasParseError()) {
    throw std::runtime_error("metadata.json is mal formatted");
  }
  for(auto val=doc.MemberBegin(); val!=doc.MemberEnd(); ++val) {
    result.push_back({val->name.GetString(), val->value.GetInt64()});
  }
  return result;
}

struct ns_Analyze::DataManager::SMetricsSummaries
ns_Analyze::DataManager::CommitMetrics(std::string const& type, std::string const& commitID, uint64_t timestamp, std::string const& subject) {
  std::optional<RunEntry> run = Resolve(type, commitID, timestamp);
  if (!run) {
    return SMetricsSummaries{0};
  }
  std::string binFilename = rootpath_ / (run->relpath.string() + ".zst");
  FileTARZST archive(binFilename);
  return CommitMetrics(archive, subject);
}

struct ns_Analyze::DataManager::SMetricsSummaries
ns_Analyze::DataManager::CommitMetrics(FileTARZST& archive, std::string const& subject) {
  struct SMetricsSummaries result {0};
  std::vector<std::pair<std::string, uint64_t>> metadatasFilename =
      archive.ListFiles(std::regex("^/*artefacts/"+RegexEscape(subject)+"/[^/]+/metadata.json$"));

  for(auto const& metadataFilename : metadatasFilename) {
    static std::regex reRunID(".*/([0-9]+)-stats.json.bin/.*");
    std::smatch match;
    if (!std::regex_search(metadataFilename.first, match, reRunID)) {
      LOGW("Ignoring folder "+metadataFilename.first);
      continue;
    }
    std::vector<char> buffer;
    archive.ExtractFile(metadataFilename.first, buffer);
    buffer.push_back(0);
    ns_Analyze::DataManager::SMetricsSummary metricsSummary = 
        MetricsSummatries(std::strtol(match[1].str().c_str(), nullptr, 10), buffer.data());
    ++result.nbRun_;
    result.runSummary_.push_back(metricsSummary);
  }

  return result;
}

std::unordered_map<std::string, std::vector<struct ns_Analyze::DataManager::SMetricValues>> 
ns_Analyze::DataManager::CommitValues(
    std::string const& type, std::string const& commitID, uint64_t timestamp,
    std::string const& subject, uint64_t min, uint64_t max,
    uint64_t step, std::vector<uint64_t>& runs,
    std::vector<uint64_t> const& clients,
    std::vector<std::string> const& metrics, std::string const& aggregate) {
  std::unordered_map<std::string, std::vector<struct ns_Analyze::DataManager::SMetricValues>> result;

  std::optional<RunEntry> run = Resolve(type, commitID, timestamp);
  if (!run) {
    return result;
  }
  std::string binFilename = rootpath_ / (run->relpath.string() + ".zst");
  FileTARZST archive(binFilename);

  // Reuse the same opened archive for the metrics summary and the values below.
  struct ns_Analyze::DataManager::SMetricsSummaries metricsSummaries = CommitMetrics(archive, subject);

  std::unordered_map<uint64_t, uint64_t> runsIDMap;
  bool findRun = !runs.empty();
  for(uint64_t i=0; i<metricsSummaries.nbRun_; ++i) {
    uint64_t runID = metricsSummaries.runSummary_[i].id_;
    if (findRun) {
      bool notfound = true;
      for(uint64_t wantedRunID: runs) {
        if (wantedRunID == runID) {
          notfound = false;
          break;
        }
      }
      if (notfound) {
        continue;
      }
    } else {
      runs.push_back(runID);
    }
    runsIDMap.emplace(runID, i);
  }

  std::vector<std::pair<std::string, uint64_t>> metadatasFilename =
      archive.ListFiles(std::regex("^/*artefacts/"+RegexEscape(subject)+"/[0-9]+-stats.json.bin/$"));

  std::unordered_map<uint64_t, std::filesystem::path> runsFolders;
  for(auto const& metadataFilename : metadatasFilename) {
    static std::regex reRunID(".*/([0-9]+)-stats.json.bin/");
    std::smatch match;
    if (!std::regex_search(metadataFilename.first, match, reRunID)) {
      LOGW("Ignoring folder "+metadataFilename.first);
      continue;
    }
    uint64_t runID = std::strtol(match[1].str().c_str(), nullptr, 10);
    if ((runsIDMap.count(runID) == 0) || (runsIDMap[runID] == ~0)) {
      continue;
    }
    runsFolders.emplace(runID, metadataFilename.first);
  }

  uint64_t nbElement = ((max - min) + step - 1) / step;
  std::vector<char> sumValues(
      nbElement * (sizeof(double) > sizeof(uint64_t) ? sizeof(double) : sizeof(uint64_t)), 0);

  std::vector<std::vector<std::vector<struct ns_Analyze::DataManager::SInterpolations>>> 
      timestamps(metricsSummaries.nbRun_);
  for(auto const& [runID, _]: runsFolders) {
    timestamps[runID].resize(metricsSummaries.runSummary_[runsIDMap[runID]].nbClient_ + 1);
  }

  for(std::string metric: metrics) {
    std::string metricFullname = metric;
    bool clientsMetric = false;
    bool allClients = false;
    std::vector<uint64_t> indexes;
    if (metric.find("global.") == 0) {
      indexes.push_back(0);
      metric = metric.substr(7);
    } else {
      clientsMetric = true;
      allClients = clients.size() == 0;
      if (!allClients) {
        indexes = clients;
      }
      size_t suffixPos = metric.find(".");
      if (suffixPos == std::string::npos) {
        throw std::runtime_error("Mal formatted metric name: "+ metric);
      }
      metric = metric.substr(suffixPos+1);
    }
    std::vector<uint64_t> savedIndexes = indexes;
    for (uint64_t runID: runs) {
      bool doAggregate = (!aggregate.empty()) && clientsMetric;
      uint64_t runIndex = runsIDMap[runID];
      if (runIndex == ~0) {
        throw std::runtime_error("Unknown run ID: " + std::to_string(runID));
      }
      auto const& itRunFolder = runsFolders.find(runID);
      if (itRunFolder == runsFolders.end()) {
        throw std::runtime_error("No folder for run ID: "+ std::to_string(runID));
      }

      if (clientsMetric) {
        uint64_t nbClients = metricsSummaries.runSummary_[runIndex].nbClient_;
        if (allClients) {
          indexes.resize(nbClients);
          for(int i=1; i<=nbClients; ++i) {
            indexes[i-1] = i;
          }
        } else {
          indexes.resize(0);
          for(uint64_t index: savedIndexes) {
            if (index <= nbClients) {
              indexes.push_back(index);
            }
          }
        }
      }

      std::filesystem::path const& runFolder = itRunFolder->second;
      if (doAggregate) {
        memset(sumValues.data(), 0, sumValues.size());
      }
      auto const& refSummary = metricsSummaries.runSummary_[runIndex].summary_[clientsMetric ? 1 : 0];
      if (refSummary.count(metric) == 0) {
        LOGW("Metric not found in run, skipping | type: " << type << " | commit: " << commitID
            << " | subject: " << subject << " | metric: " << metricFullname << " | runID: " << runID);
        continue;
      }
      DataType dataType = refSummary.at(metric).type_;
      for(uint64_t index: indexes) {
        //LOGI(metric << " " << runIndex << " (" << metricsSummaries.runSummary_[runIndex].id_ << ") " << index);
        auto const& indexSummary = metricsSummaries.runSummary_[runIndex].summary_[index];
        if (indexSummary.count(metric) == 0 || dataType != indexSummary.at(metric).type_) {
          LOGE("Fatal request error, 2 different kind of data for the same serie");
          return {};
        }
        if (timestamps[runID][index].empty()) {
          timestamps[runID][index] = ExtractDataTS(archive, runFolder, metricsSummaries.runSummary_[runIndex].summary_[index]["timestamp"], min, max, step);
        }
        std::string filename = runFolder / metricsSummaries.runSummary_[runIndex].summary_[index][metric].file_;

        switch(dataType) {
          case DataType::UINT64:
            if (doAggregate) {
              auto data = ExtractData<uint64_t>(archive, filename, timestamps[runID][index]);
              uint64_t* sum = (uint64_t*)sumValues.data();
              for (size_t i=0; i<data.size(); ++i) {
                sum[i] += data[i];
              }
            } else {
              result[metricFullname].push_back(
                  {runID, index, { ExtractData<uint64_t>(archive, filename, timestamps[runID][index]) }});
            }
            break;
          case DataType::DOUBLE:
            if (doAggregate) {
              auto data = ExtractData<double>(archive, filename, timestamps[runID][index]);
              double* sum = (double*)sumValues.data();
              for (size_t i=0; i<data.size(); ++i) {
                sum[i] += data[i];
              }
            } else {
              result[metricFullname].push_back(
                  {runID, index, { ExtractData<double>(archive, filename, timestamps[runID][index]) }});
            }
            break;
          default:
            LOGE("Fatal request error, serie of data have an unmanaged kind: " << DataTypeToString(dataType)
                << " | type: " << type << " | commit: " << commitID << " | subject: " << subject
                << " | metric: " << metricFullname
                << " | file: " << filename
                << " | runID: " << runID << " index: " << index);
            return {};
            break;
        }
      }
      if (doAggregate) {
        switch(dataType) {
          case DataType::UINT64: {
              uint64_t* sum = (uint64_t*)sumValues.data();
              result[metricFullname].push_back({runID, 0, { std::vector<uint64_t>(sum, sum + nbElement) }});
            }
            break;
          case DataType::DOUBLE: {
              double* sum = (double*)sumValues.data();
              result[metricFullname].push_back({runID, 0, { std::vector<double>(sum, sum + nbElement) }});
            }
            break;
          default:
            LOGE("Fatal request error, serie of data have an unmanaged kind: " << DataTypeToString(dataType)
                << " | type: " << type << " | commit: " << commitID << " | subject: " << subject
                << " | metric: " << metricFullname
                << " | runID: " << runID);
            return {};
            break;
        }
      }
    }
  }

  return result;
}

std::vector<struct ns_Analyze::DataManager::SInterpolations> 
ns_Analyze::DataManager::ExtractDataTS(FileTARZST& archive, std::filesystem::path const& prefixPath, 
    struct SMetricInfos const& metricInfos, uint64_t min, uint64_t max, 
    uint64_t step) {
  std::vector<struct ns_Analyze::DataManager::SInterpolations> result;
  std::string filename = prefixPath / metricInfos.file_;
  uint64_t filesize = archive.FileSize(filename);
  if ((filesize == 0) || ((filesize % sizeof(uint64_t)) != 0)) {
    return result;
  }

  result.reserve(((max - min) + step - 1) / step);

  uint64_t timestampMaxIndex = (filesize / sizeof(uint64_t)) - 1;

  uint64_t minOffset = 0;
  uint64_t value;
  archive.ExtractFileData(filename, sizeof(uint64_t), 0, (char*)&value, nullptr);
  if (value < min) {
    minOffset = ~0;
    size_t low = 0;
    size_t high = timestampMaxIndex;
    while (low <= high) {
      size_t mid = low + (high - low) / 2;
      archive.ExtractFileData(filename, sizeof(uint64_t), mid * sizeof(uint64_t), (char*)&value, nullptr);
      if (value <= min) {
        minOffset = mid;
        if (mid == timestampMaxIndex) {
          for(uint64_t time=min; time<max; time+=step) {
            result.push_back({{0.0, 0.0},{timestampMaxIndex, timestampMaxIndex}});
          }
          return result;
        }
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
  } else if (value >= max) {
    for(uint64_t time=min; time<max; time+=step) {
      result.push_back({{0.0, 0.0},{0, 0}});
    }
    return result;
  } else if (value > min) {
    uint64_t newMin = (min + (((value - min) / step) * step)) + step;
    for(uint64_t time=min; time<newMin; time+=step) {
      result.push_back({{0.0, 0.0},{0, 0}});
    }
    min = newMin;
  }

  size_t fileOffset = minOffset;
  size_t currentFileOffset = fileOffset * sizeof(uint64_t);
  size_t currentOffset = 0;
  std::vector<uint64_t> values(4*1024*1024);
  uint64_t nbElementToRead = values.size();
  int64_t nbElementRead = archive.ExtractFileData(filename, nbElementToRead * sizeof(uint64_t), 
    fileOffset * sizeof(uint64_t), (char*)values.data(), nullptr) / sizeof(uint64_t);
  fileOffset += nbElementRead;
  if (nbElementRead != nbElementToRead) {
    values.resize(nbElementRead);
  }

  --nbElementToRead;

  for(uint64_t time=min; time<max; time+=step) {
    while(values[currentOffset] < time) {
      ++currentOffset;

      if (currentOffset >= values.size()) {
        values[0] = values.back();
        currentFileOffset = fileOffset * sizeof(uint64_t);
        nbElementRead = archive.ExtractFileData(filename, nbElementToRead * sizeof(uint64_t), 
          fileOffset * sizeof(uint64_t), (char*)(values.data()+1), nullptr) / sizeof(uint64_t);
        fileOffset += nbElementRead;
        currentOffset = 0;
        if (nbElementRead == 0) {
          break;
        }
        if (nbElementRead != nbElementToRead) {
          values.resize(nbElementRead + 1);
        }
      }
    }
    if (nbElementRead == 0) {
      break;
    }
    uint64_t offset = (currentFileOffset / sizeof(uint64_t)) + currentOffset;
    if (values[currentOffset] == time) {
      //LOGE(values[currentOffset] << " == " << time);
      result.push_back({{1.0, 0.0},{offset, offset}});
    } else {
      //LOGE(values[currentOffset-1] << " < " << time << " < " << values[currentOffset]);
      double diff1 = time - values[currentOffset-1];
      double diff2 = values[currentOffset] - time;
      double diff = diff1 + diff2;
      result.push_back({
          {1.0 - (diff1 / diff), 1.0 - (diff2 / diff)}, {offset - 1, offset}
      });
    }
  }

  uint64_t nbMissingElement = result.capacity() - result.size();
  if (nbMissingElement != 0) {
    struct ns_Analyze::DataManager::SInterpolations value = result.back();
    value.ratios = { 0.0, 0.0 };
    /*for(uint64_t i=0; i<nbMissingElement; ++i) {
      result.push_back(value);
    }*/
    result.insert(result.end(), nbMissingElement, value);
  }

  return result;
}
