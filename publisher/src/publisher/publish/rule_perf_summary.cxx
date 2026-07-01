#include "rule_perf_summary.hxx"
#include "../../utils/logs.hxx"
#include "../../utils/file_compressed.hxx"
#include "../../utils/rapidjson.hxx"
#include <fstream>
#include <variant>
#include "rapidjson/stringbuffer.h"
#include "rapidjson/writer.h"

#define TOLOWER(astring) { std::transform(astring.begin(), astring.end(), astring.begin(), \
    [](unsigned char c){ return std::tolower(c); }); }

ns_Publish::RulePerfUseSummary::RulePerfUseSummary(std::string const& name, 
    std::string const& rulePath, std::string const& ruleRelativePath, 
    std::string const& filesFilter, rapidjson::Value::ConstObject const& parameters) 
    : RulePerfUseSummary(name, rulePath, ruleRelativePath, filesFilter, parameters, 
    "Perf", "Perf", true)
{}

bool ns_Publish::RulePerfUseSummary::Apply(std::string const& file, 
    std::filesystem::path const& outPath, uint64_t& timestamp, 
    std::string& outFile, std::unordered_set<std::string>& libsManaged, bool generateArtefact) {
  try {
    timestamp = std::stoull(std::filesystem::path(file).stem());
  } catch(...) {
    LOGE << "Unable to get timestamp from filename " << file << Log::Flags::End;
    return false;
  }

  std::string error;
  std::filesystem::path taskJSONFile = file;
  taskJSONFile.replace_extension(".json");
  std::filesystem::path zstdFile = file;
  zstdFile.replace_extension(".zst");

  if (!BuildJSON(file, outPath, outFile, libsManaged)) {
    error = "Error: while parsing task json " + taskJSONFile.string();
    goto RulePerfUseSummary__Process;
  }
  if (generateArtefact) {
    if (!ns_Analyze::Generate_Perf_ZST(file, zstdFile, "")) {
      error = "Error: file " + file + " is not usable to generate ZST";
      goto RulePerfUseSummary__Process;
    }
  }
  if (!ValidateUpdatedJSON(outPath / outFile)) {
    error = "Error: while making permanent " + outFile;
    goto RulePerfUseSummary__Process;
  }
  return true;

RulePerfUseSummary__Process:
  LOGE << error << Log::Flags::End;
  if (!generateArtefact) {
    throw std::runtime_error("Unable to generate informations for " + file);
  }
  std::error_code ec;
  (!zstdFile.empty()) && std::filesystem::exists(zstdFile) && 
      std::filesystem::remove(zstdFile, ec);
  if (!outFile.empty()) {
    std::string file = rulePath_ / outFile;
    std::filesystem::exists(file) && std::filesystem::remove(file, ec);
    file += ".tmp";
    std::filesystem::exists(file) && std::filesystem::remove(file, ec);
    outFile = "";
  }
  return false;
}

ns_Publish::RulePerfUseSummary::RulePerfUseSummary(std::string const& name, 
    std::string const& rulePath, std::string const& ruleRelativePath, 
    std::string const& filesFilter, rapidjson::Value::ConstObject const& parameters, 
    std::string const& type, std::filesystem::path const& folder, bool checkIDMatchFeature) 
    : Rule(name, rulePath, ruleRelativePath, filesFilter), type_(type), 
    folder_(folder), checkIDMatchFeature_(checkIDMatchFeature)
{
  if (parameters.HasMember("folder") && parameters["folder"].IsString()) {
    folder_ = parameters["folder"].GetString();
  }
}

bool ns_Publish::RulePerfUseSummary::BuildJSON(std::string const& taskDataFile, 
      std::filesystem::path const& outputPath, std::string& outFile, 
      std::unordered_set<std::string>& libsManaged) {
  std::filesystem::path taskInfoFile = taskDataFile;
  taskInfoFile.replace_extension(".json");
  TaskAnalysis analysis;
  analysis = ExtractExperimentsFromFile(taskInfoFile, taskDataFile);

  struct SStates {
    bool infoSafe;
    int cputs;
    std::string libraryName;
    std::string libraryVersion;
    std::unordered_map<uint64_t, bool> runs;
    SStates() : infoSafe(false), cputs(0) {}
  };

  std::unordered_map<std::string, struct SStates> states;
  int nbTimeout = 0;
  try {
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
        LOGW << "JSON Parse error in (" << taskInfoFile << " " << 
            result.id << ":" << result.attempt << ") " << result.user_run_state << Log::Flags::End;
        continue;
      }
      if (doc.HasMember("cputs") && doc["cputs"].IsBool()) {
        states[result.id].cputs = doc["cputs"].GetBool() ? 1 : -1;
      } else {
        LOGE << "Error, missing required field cputs in " << taskInfoFile << 
            " " << result.id << ":" << result.attempt << Log::Flags::End;
        continue;
      }

      if (doc.HasMember("library") && doc["library"].IsObject()) {
        rapidjson::Value const& libraryJSON = doc["library"];
        if (((!libraryJSON.HasMember("name")) || (!libraryJSON["name"].IsString())) || 
            ((!libraryJSON.HasMember("version")) || (!libraryJSON["version"].IsString()))) {
          LOGE << "Error, missing required field in user_run_state.library " << 
              taskInfoFile  << " " << result.id << ":" << result.attempt << Log::Flags::End;
          continue;
        }
        states[result.id].libraryName = libraryJSON["name"].GetString();
        TOLOWER(states[result.id].libraryName);
        states[result.id].libraryVersion = libraryJSON["version"].GetString();
        states[result.id].infoSafe = success;
      } else if (doc.HasMember("features") && doc["features"].IsString()) {
        std::string features = doc["features"].GetString();
        static std::regex featuresSearch(".*(?:^|,)([a-zA-Z]+)([0-9][0-9a-zA-Z]+)(?:$|,.*)");
        static std::regex vendorSearch("([a-zA-Z]+):[a-zA-Z]+([0-9][0-9a-zA-Z]+)(?:$|-.*)");
        std::smatch matches;
        if (std::regex_match(features, matches, featuresSearch)) {
          std::string name = matches[1].str();
          TOLOWER(name);
          states[result.id].libraryName = name;
          states[result.id].libraryVersion = matches[2].str();
          states[result.id].infoSafe = success;
        } else if (std::regex_match(features, matches, vendorSearch)) {
          std::string name = matches[1].str();
          TOLOWER(name);
          states[result.id].libraryName = name;
          states[result.id].libraryVersion = matches[2].str();
          states[result.id].infoSafe = success;
        } else if (strcasecmp(result.id.c_str(), "libressl") == 0) {
          states[result.id].libraryName = "libressl";
          states[result.id].libraryVersion = "333";
          states[result.id].infoSafe = true;
        } else {
          LOGE << "Error, unable to find library version in " << taskInfoFile  << 
              " " << result.id << ":" << result.attempt << " data= " << features << Log::Flags::End;
          states[result.id].libraryVersion = "";
        }
        if ((checkIDMatchFeature_) && (matches.size() > 1)) {
          if (strcasecmp(matches[1].str().c_str(), result.id.c_str()) != 0) {
            LOGE << "Error expected lib id " << result.id << " not matching id found " 
                << matches[1].str() << Log::Flags::End;
            states[result.id].infoSafe = false;
          }
        }
      } else {
        LOGE << "Error, missing required field library/feature in user_run_state " << 
            taskInfoFile  << " " << result.id << ":" << result.attempt << Log::Flags::End;
        continue;
      }
    }
  } catch(...) {
    LOGE << "Fatal Error in " << taskInfoFile << " skip it" << Log::Flags::End;
    return false;
  }

  FileCompressed fileCompressed(taskDataFile);

  std::vector<std::pair<std::string, uint64_t>> summaryInfo = fileCompressed.ListFiles(std::regex("artefacts/summary.json"));
  if (summaryInfo.size() != 1) {
    return false;
  }

  std::string summaryJSON;
  summaryJSON.resize(summaryInfo[0].second + 1);
  summaryJSON[summaryInfo[0].second] = 0;
  int64_t readSize = fileCompressed.ExtractFileData(summaryInfo[0].first, summaryInfo[0].second, summaryJSON.data(), nullptr);
  fileCompressed.StopExtractFileData();
  if ((readSize != summaryInfo[0].second) || (summaryJSON.empty())) {
    return false;
  }

  rapidjson::Document doc;
  auto& allocator = doc.GetAllocator();
  doc.Parse(summaryJSON.c_str());
  if (doc.HasParseError()) {
    LOGE << "Parse error in artefacts/summary.json" << Log::Flags::End;
    return false;
  }

  std::unordered_map<std::string, rapidjson::Value> cliData;
  std::unordered_map<std::string, std::unordered_map<std::string, std::unordered_map<std::string, std::variant<std::uint64_t, double, std::vector<double>>>>> 
      librariesData;
  try {
    std::string type = Get<std::string>(doc, "type");
    rapidjson::Value::ConstArray libraries = 
        Get<rapidjson::Value::ConstArray>(doc, "libraries");
    for (const auto& librarie: libraries) {
      std::string name = Get<std::string>(librarie, "name");
      if (librarie.HasMember("cli") && librarie["cli"].IsObject()) {
        cliData[name].CopyFrom(librarie["cli"], allocator);
      }
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
    LOGE << "Fatal Error in " << summaryInfo[0].first << ": " << e.what() << ", skip the file" << Log::Flags::End;
    return false;
  } catch(...) {
    LOGE << "Fatal Error in " << summaryInfo[0].first << " skip it" << Log::Flags::End;
    return false;
  }

  std::filesystem::path jsonRelativePath = OutputName(analysis);
  std::filesystem::path jsonPath = outputPath / folder_ / jsonRelativePath;
  std::filesystem::create_directories(jsonPath.parent_path());

  doc.SetObject();

  doc.AddMember("type", rapidjson::Value(type_.c_str(), allocator), allocator);
  if (type_ == "Campaign") {
    doc.AddMember("user", rapidjson::Value(analysis.user.c_str(), allocator), allocator);
    doc.AddMember("campaign_id", 
        rapidjson::Value((analysis.campaign_id+"-"+std::to_string(analysis.task_id)).c_str(), allocator), 
        allocator);
  }
  doc.AddMember("commit_id",
    rapidjson::Value(analysis.commit_id.c_str(), allocator), allocator);

  rapidjson::Value tasksDetails(rapidjson::kArrayType);
  rapidjson::Value taskDetails(rapidjson::kObjectType);
  taskDetails.AddMember("date",
    rapidjson::Value(analysis.date.c_str(), allocator), allocator);
  taskDetails.AddMember("task_id", analysis.task_id, allocator);
  taskDetails.AddMember("task_name",
    rapidjson::Value(analysis.task_name.c_str(), allocator), allocator);
  std::filesystem::path ruleRelativePath = ruleRelativePath_;
  taskDetails.AddMember("task_info",
    rapidjson::Value((ruleRelativePath / analysis.task_infos).c_str(), allocator), allocator);
  taskDetails.AddMember("task_data",
    rapidjson::Value((ruleRelativePath / analysis.task_data).c_str(), allocator), allocator);
  tasksDetails.PushBack(taskDetails, allocator);
  doc.AddMember("tasks", tasksDetails, allocator);

  int nbFail = 0;
  rapidjson::Value libsObj(rapidjson::kObjectType);
  for (auto const& [libName, state]: states) {
    rapidjson::Value libData(rapidjson::kObjectType);
    std::unordered_map<std::string, rapidjson::Value> datas;
    rapidjson::Value haveObjectif(rapidjson::kArrayType);
    int nbSuccess = 0;
    int trustObjectif = state.libraryName != "wolfssl" ? 1 : 
        (((!state.libraryVersion.empty()) && (std::stoull(state.libraryVersion) > 540)) ? 1 : -1);
    for (auto const& [attempt, success]: state.runs) {
      bool successFinal = success;
      if (successFinal) {
        bool experimentTimedOut = false;
        for(auto const& experiment: analysis.experiments) {
          if ((experiment.id == libName) && (experiment.attempt == attempt)) {
            experimentTimedOut = experiment.duration_ms >= experiment.timeout_ms;
            break;
          }
        }
        successFinal = experimentTimedOut;
      }
      std::string attemptString = std::to_string(attempt);
      if (successFinal) {
        ++nbSuccess;

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
    if (type_ == "Campaign") {
      libData.AddMember("library", rapidjson::Value(state.libraryName.c_str(), allocator), allocator);
      libData.AddMember("library_version", rapidjson::Value(state.libraryVersion.c_str(), allocator), allocator);
    }
    if (!cliData[libName].IsNull()) {
      libData.AddMember("cli", cliData[libName], allocator);
    }
    libData.AddMember("cputs", state.cputs, allocator);
    libData.AddMember("total_runs", state.runs.size(), allocator);
    libData.AddMember("success_count", nbSuccess, allocator);
    for(auto& [key, value]: datas) {
      libData.AddMember(rapidjson::Value(key.c_str(), allocator), value, allocator);
    }
    if (!haveObjectif.Empty()) {
      libData.AddMember("warn_user", haveObjectif, allocator);
    }
    libData.AddMember("details_id", 0, allocator);
    libsObj.AddMember(
      rapidjson::Value(libName.c_str(), allocator), libData, allocator);

    libsManaged.insert(libName);
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

  if (!UpdateJSON(jsonPath, doc, libsManaged)) {
    return false;
  }

  outFile = folder_ / jsonRelativePath;
  return true;
}

std::filesystem::path ns_Publish::RulePerfUseSummary::OutputName(TaskAnalysis const& analysis) const {
  return  analysis.commit_id + ".json";
}
