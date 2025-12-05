#include "publish_action_perf_summary.hxx"
#include "../../utils/logs.hxx"
#include "../../utils/file_tgz.hxx"
#include "../../utils/rapidjson.hxx"
#include <variant>
#include <fstream>
#include <rapidjson/document.h>
#include <rapidjson/ostreamwrapper.h>
#include <rapidjson/writer.h>

bool ns_Publish::PublishActionPerfUseSummary::GenerateCommitJson(
    std::filesystem::path const& inputFile, std::filesystem::path const& outputPath) {
  FileTGZ filetgz(inputFile);

  std::vector<std::pair<std::string, uint64_t>> taskInfo = filetgz.ListFiles(std::regex("[0-9]+\\.json"));
  if (taskInfo.size() != 1) {
    return false;
  }

  std::string taskJSON;
  taskJSON.resize(taskInfo[0].second + 1);
  taskJSON[taskInfo[0].second] = 0;
  int64_t readSize = filetgz.ExtractFileData(taskInfo[0].first, taskInfo[0].second, taskJSON.data(), nullptr);
  if ((readSize != taskInfo[0].second) || (taskJSON.empty())) {
    return false;
  }

  struct SStates {
    bool infoSafe;
    int cputs;
    std::string libraryVersion;
    std::unordered_map<uint64_t, bool> runs;
    SStates() : infoSafe(false), cputs(0) {}
  };

  std::unordered_map<std::string, struct SStates> states;
  int nbTimeout = 0;
  TaskAnalysis analysis;
  try {
    analysis = ExtractExperimentsFromBuffer(taskJSON);
    for (ExperimentResult const& result: analysis.experiments) {
      bool success = (result.exit_code == 512) && (result.state == "TimedOut");
      states[result.id].runs[result.attempt] = success;
      if (success) {
        ++nbTimeout;
      }
      if (states[result.id].infoSafe || result.user_run_state.empty()) {
        continue;
      }
      rapidjson::Document doc;
      doc.Parse(result.user_run_state.c_str());
      if (doc.HasParseError()) {
        LOGW("JSON Parse error in (" << taskInfo[0].first << " " << 
            result.id << ":" << result.attempt << ") " << result.user_run_state);
        continue;
      }
      if (doc.HasMember("cputs") && doc["cputs"].IsBool()) {
        states[result.id].cputs = doc["cputs"].GetBool() ? 1 : -1;
      } else {
        LOGE("Error, missing required field cputs in " << taskInfo[0].first << 
            " " << result.id << ":" << result.attempt);
      }

      if ((!doc.HasMember("features")) || (!doc["features"].IsString())) {
        LOGE("Error, missing required field features in " << taskInfo[0].first  << 
            " " << result.id << ":" << result.attempt);
      }
      std::string features = doc["features"].GetString();
      static std::regex featuresSearch(".*(?:^|,)([a-zA-Z]+)([0-9][0-9a-zA-Z]+),*.*");
      static std::regex vendorSearch("([a-zA-Z]+):[a-zA-Z]+([0-9][0-9a-zA-Z]+)-.*");
      std::smatch matches;
      if (std::regex_match(features, matches, featuresSearch)) {
        states[result.id].libraryVersion = matches[2].str();
        states[result.id].infoSafe = success;
      } else if (std::regex_match(features, matches, vendorSearch)) {
        states[result.id].libraryVersion = matches[2].str();
        states[result.id].infoSafe = success;
      } else if (strcasecmp(result.id.c_str(), "libressl") == 0) {
        states[result.id].libraryVersion = "333";
        states[result.id].infoSafe = true;
      } else {
        LOGE("Error, unable to find library version in " << taskInfo[0].first  << 
            " " << result.id << ":" << result.attempt << " data= " << features);
        states[result.id].libraryVersion = "";
      }
      if (matches.size() > 1) {
        if (strcasecmp(matches[1].str().c_str(), result.id.c_str()) != 0) {
          LOGE("Error expected lib id " << result.id << " not matching id found " << matches[1].str());
          states[result.id].infoSafe = false;
        }
      }
    }
  } catch(...) {
    LOGE("Fatal Error in " << taskInfo[0].first << " skip it");
    return false;
  }

  if (analysis.experiments.size() == 0) {
    analysis.global_status = "no run";
  } else if (nbTimeout == analysis.experiments.size()) {
    analysis.global_status = "success";
  } else if (nbTimeout == 0) {
    analysis.global_status = "fail";
  } else {
    analysis.global_status = "mixed";
  }

  std::vector<std::pair<std::string, uint64_t>> summaryInfo = filetgz.ListFiles(std::regex("artefacts/summary.json"));
  if (summaryInfo.size() != 1) {
    return false;
  }

  std::string summaryJSON;
  summaryJSON.resize(summaryInfo[0].second + 1);
  summaryJSON[summaryInfo[0].second] = 0;
  readSize = filetgz.ExtractFileData(summaryInfo[0].first, summaryInfo[0].second, summaryJSON.data(), nullptr);
  if ((readSize != summaryInfo[0].second) || (summaryJSON.empty())) {
    return false;
  }

  rapidjson::Document doc;
  doc.Parse(summaryJSON.c_str());
  if (doc.HasParseError()) {
    return false;
  }

  std::unordered_map<std::string, std::unordered_map<std::string, std::unordered_map<std::string, std::variant<std::uint64_t, double>>>> librariesData;
  try {
    std::string type = Get<std::string>(doc, "type");
    rapidjson::Value::ConstArray libraries = 
        Get<rapidjson::Value::ConstArray>(doc, "libraries");
    for (const auto& librarie: libraries) {
      std::string name = Get<std::string>(librarie, "name");
      rapidjson::Value::ConstArray data = Get<rapidjson::Value::ConstArray>(librarie, "data");
      for (const auto& report: data) {
        std::string id = Get<std::string>(report, "id");
        for (std::string const& field: {"duration", "corpus_size", "total_execs", "coverage", "objective_size"}) {
          librariesData[name][id][field] = Get<uint64_t>(report, field.c_str());
        }
      }
    }
  } catch(...) {
    LOGE("Fatal Error in " << summaryInfo[0].first << " skip it");
    return false;
  }

  std::filesystem::create_directories(outputPath / "Perf");
  std::filesystem::path jsonPath = outputPath / "Perf" / (analysis.commit_id + ".json");

  doc.SetObject();
  auto& allocator = doc.GetAllocator();

  doc.AddMember("type", "perf_summary", allocator);
  doc.AddMember("commit_id",
    rapidjson::Value(analysis.commit_id.c_str(), allocator), allocator);
  doc.AddMember("date",
    rapidjson::Value(analysis.date.c_str(), allocator), allocator);
  doc.AddMember("task_id", analysis.task_id, allocator);
  doc.AddMember("task_name",
    rapidjson::Value(analysis.task_name.c_str(), allocator), allocator);
  doc.AddMember("global_status",
    rapidjson::Value(analysis.global_status.c_str(), allocator), allocator);
  doc.AddMember("no_stats", rapidjson::kArrayType, allocator);

  rapidjson::Value libsObj(rapidjson::kObjectType);
  for (auto const& [libName, state]: states) {
    rapidjson::Value libData(rapidjson::kObjectType);
    rapidjson::Value failDuration(rapidjson::kArrayType);
    rapidjson::Value corpusSize(rapidjson::kArrayType);
    rapidjson::Value totalExecs(rapidjson::kArrayType);
    rapidjson::Value coverage(rapidjson::kArrayType);
    rapidjson::Value haveObjectif(rapidjson::kArrayType);
    int nbSucess = 0;
    int trustObjectif = strcasecmp(libName.c_str(), "wolfssl") != 0 ? 1 : 
        (((!state.libraryVersion.empty()) && (std::stoull(state.libraryVersion))) > 540 ? 1 : -1);
    for (auto const& [attempt, success]: state.runs) {
      if (success) {
        ++nbSucess;
        corpusSize.PushBack(std::get<uint64_t>(librariesData[libName][std::to_string(attempt)]["corpus_size"]), allocator);
        totalExecs.PushBack(std::get<uint64_t>(librariesData[libName][std::to_string(attempt)]["total_execs"]), allocator);
        coverage.PushBack(std::get<uint64_t>(librariesData[libName][std::to_string(attempt)]["coverage"]), allocator);
      } else {
        failDuration.PushBack(std::get<uint64_t>(librariesData[libName][std::to_string(attempt)]["duration"]), allocator);
      }
      if ((std::get<uint64_t>(librariesData[libName][std::to_string(attempt)]["objective_size"]) > 0) && (trustObjectif == 1)) {
        haveObjectif.PushBack(attempt, allocator);
      }
    }
    libData.AddMember("cputs", state.cputs, allocator);
    libData.AddMember("total_runs", state.runs.size(), allocator);
    libData.AddMember("success_count", nbSucess, allocator);
    libData.AddMember("fail_duration_s", failDuration, allocator);
    libData.AddMember("corpus_size", corpusSize, allocator);
    libData.AddMember("total_execs", totalExecs, allocator);
    libData.AddMember("coverage", coverage, allocator);
    if (!haveObjectif.Empty()) {
      libData.AddMember("warn_user", haveObjectif, allocator);
    }
    libsObj.AddMember(
      rapidjson::Value(libName.c_str(), allocator), libData, allocator);
  }
  doc.AddMember("libs", libsObj, allocator);

  std::ofstream ofs(jsonPath);
  if (!ofs.is_open()) {
    LOGE("Failed to create JSON file: " << jsonPath);
    throw std::runtime_error("Cannot create commit JSON");
  }

  rapidjson::OStreamWrapper os(ofs);
  rapidjson::Writer<rapidjson::OStreamWrapper> writer(os);
  doc.Accept(writer);

  ofs.close();

  LOGI("Generated " << jsonPath);
  return true;
}