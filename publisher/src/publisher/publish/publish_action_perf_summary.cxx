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
    LOGE("Parse error in artefacts/summary.json");
    return false;
  }

  std::unordered_map<std::string, std::unordered_map<std::string, std::unordered_map<std::string, std::variant<std::uint64_t, double, std::vector<double>>>>> librariesData;
  try {
    std::string type = Get<std::string>(doc, "type");
    rapidjson::Value::ConstArray libraries = 
        Get<rapidjson::Value::ConstArray>(doc, "libraries");
    for (const auto& librarie: libraries) {
      std::string name = Get<std::string>(librarie, "name");
      rapidjson::Value::ConstArray data = Get<rapidjson::Value::ConstArray>(librarie, "data");
      for (const auto& report: data) {
        std::string id = Get<std::string>(report, "id");
        for (auto& [field, value] : report.GetObject()) {
          std::string fieldname = field.GetString();
          if (fieldname == "id") {
            continue;
          }
          if (value.IsUint64()) {
            librariesData[name][id][fieldname] = value.GetUint64();
          } else if (value.IsArray()) {
            std::vector<double> values;
            for (const auto& elem : value.GetArray()) {
              if (elem.IsDouble()) {
                values.push_back(elem.GetDouble());
              } else {
                throw std::runtime_error("Unexpected type in array of field " + fieldname);
              }
            }
            librariesData[name][id][fieldname] = std::move(values);
          } else {
            throw std::runtime_error("Unexpected type for field " + fieldname);
          }
        }
      }
    }
  } catch(std::exception const& e) {
    LOGE("Fatal Error in " << summaryInfo[0].first << ": " << e.what() << ", skip the file");
    return false;
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
  doc.AddMember("no_stats", rapidjson::kArrayType, allocator);

  int nbFail = 0;
  rapidjson::Value libsObj(rapidjson::kObjectType);
  for (auto const& [libName, state]: states) {
    rapidjson::Value libData(rapidjson::kObjectType);
    std::unordered_map<std::string, rapidjson::Value> datas;
    rapidjson::Value haveObjectif(rapidjson::kArrayType);
    int nbSucess = 0;
    int trustObjectif = strcasecmp(libName.c_str(), "wolfssl") != 0 ? 1 : 
        (((!state.libraryVersion.empty()) && (std::stoull(state.libraryVersion))) > 540 ? 1 : -1);
    for (auto const& [attempt, success]: state.runs) {
      bool successFinal = success;
      if (successFinal) {
        uint64_t experimentDuration = -1;
        for(auto const& experiment: analysis.experiments) {
          if ((experiment.id == libName) && (experiment.attempt == attempt)) {
            experimentDuration = experiment.duration_ms / 1000.0;
          }
        }
        uint64_t clientsDuration = std::get<uint64_t>(librariesData[libName][std::to_string(attempt)]["client_average_duration_s"]);
        uint64_t duration = std::get<uint64_t>(librariesData[libName][std::to_string(attempt)]["duration"]);
        successFinal = (duration > (experimentDuration - 700)) && (clientsDuration > (duration - 400));
      }
      std::string attemptString = std::to_string(attempt);
      if (successFinal) {
        ++nbSucess;

        for (auto const& [key, value]: librariesData[libName][attemptString]) {
          if (key == "duration") {
            continue;
          }
          rapidjson::Value& array = datas[key];
          if (!array.IsArray())  {
            array.SetArray();
          }
          if (std::holds_alternative<std::uint64_t>(value)) {
            array.PushBack(std::get<uint64_t>(value), allocator);
          } else if (std::holds_alternative<double>(value)) {
            array.PushBack(std::get<double>(value), allocator);
          } else if (std::holds_alternative<std::vector<double>>(value)) {
            for (double element : std::get<std::vector<double>>(value)) {
              array.PushBack(element, allocator);
            }
          }
        }
      } else {
        ++nbFail;
        rapidjson::Value& arrayDuration = datas["fail_duration_s"];
        if (!arrayDuration.IsArray())  {
          arrayDuration.SetArray();
        }
        arrayDuration.PushBack(std::get<uint64_t>(librariesData[libName][attemptString]["duration"]), allocator);
        rapidjson::Value& arrayClientsDuration = datas["fail_client_average_duration_s"];
        if (!arrayClientsDuration.IsArray())  {
          arrayClientsDuration.SetArray();
        }
        arrayClientsDuration.PushBack(std::get<uint64_t>(librariesData[libName][attemptString]["client_average_duration_s"]), allocator);
      }
      if ((std::get<uint64_t>(librariesData[libName][attemptString]["objective_size"]) > 0) && (trustObjectif == 1)) {
        haveObjectif.PushBack(attempt, allocator);
      }
    }
    libData.AddMember("cputs", state.cputs, allocator);
    libData.AddMember("total_runs", state.runs.size(), allocator);
    libData.AddMember("success_count", nbSucess, allocator);
    for(auto& [key, value]: datas) {
      libData.AddMember(rapidjson::Value(key.c_str(), allocator), value, allocator);
    }
    if (!haveObjectif.Empty()) {
      libData.AddMember("warn_user", haveObjectif, allocator);
    }
    libsObj.AddMember(
      rapidjson::Value(libName.c_str(), allocator), libData, allocator);
  }
  doc.AddMember("libs", libsObj, allocator);

  if (analysis.experiments.size() == 0) {
    analysis.global_status = "no run";
  } else if (nbFail == 0) {
    analysis.global_status = "success";
  } else if (nbFail == analysis.experiments.size()) {
    analysis.global_status = "fail";
  } else {
    analysis.global_status = "mixed";
  }
  doc.AddMember("global_status",
    rapidjson::Value(analysis.global_status.c_str(), allocator), allocator);

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