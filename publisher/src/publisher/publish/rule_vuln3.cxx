#include "rule_vuln3.hxx"
#include "../../utils/logs.hxx"
#include "../../utils/file_compressed.hxx"
#include "../../utils/rapidjson.hxx"

ns_Publish::RuleVuln3::RuleVuln3(std::string const& name, std::string const& rulePath, 
    std::string const& ruleRelativePath, std::string const& filesFilter, 
    rapidjson::Value::ConstObject const& parameters) 
    : Rule(name, rulePath, ruleRelativePath, filesFilter), folder_("Vuln")
{
  if (parameters.HasMember("folder") && parameters["folder"].IsString()) {
    folder_ = parameters["folder"].GetString();
  }
}

bool ns_Publish::RuleVuln3::BuildSummary(std::string const& taskDataFile, 
    Rule::TaskAnalysis& analysis, 
    std::unordered_map<std::string, struct LibSummary>& libSummaries) {

  std::filesystem::path taskInfoFile = taskDataFile;
  taskInfoFile.replace_extension(".json");

  analysis = ExtractExperimentsFromFile(taskInfoFile, taskDataFile);
  LOGI << "  task_id=" << analysis.task_id
      << "  task_name=" << analysis.task_name
      << "  commit=" << analysis.commit_id
      << Log::Flags::End;

  FileCompressed fileCompressed(taskDataFile);
  std::vector<std::pair<std::string, uint64_t>> fileInfo = fileCompressed.ListFiles(std::regex("run-summary.json"));
  if (fileInfo.size() != 1) {
    return false;
  }
  std::string runSummary;
  runSummary.resize(fileInfo[0].second + 1);
  runSummary[fileInfo[0].second] = 0;
  int64_t readSize = fileCompressed.ExtractFileData(fileInfo[0].first, fileInfo[0].second, runSummary.data(), nullptr);
  fileCompressed.StopExtractFileData();
  if ((readSize != fileInfo[0].second) || (runSummary.empty())) {
    return false;
  }
  rapidjson::Document runSummaryJSON;
  runSummaryJSON.Parse(runSummary.c_str());
  if (runSummaryJSON.HasParseError()) {
    throw std::runtime_error("Invalid JSON format");
  }
  if ((!runSummaryJSON.HasMember("libraries")) || (!runSummaryJSON["libraries"].IsArray())) {
    LOGW << "No 'libraries' object found in JSON" << Log::Flags::End;
    return false;
  }
  bool missCputs = false;
  bool haveSuccess = false;
  bool haveFail = false;
  auto const& librariesJSON = runSummaryJSON["libraries"].GetArray();
  for(int i=0; i<librariesJSON.Size(); ++i) {
    if ((!librariesJSON[i].HasMember("name")) || (!librariesJSON[i]["name"].IsString())) {
      continue;
    }
    if ((!librariesJSON[i].HasMember("data")) || (!librariesJSON[i]["data"].IsArray())) {
      continue;
    }
    std::string libName = librariesJSON[i]["name"].GetString();
    if ((librariesJSON[i].HasMember("cputs")) && (librariesJSON[i]["cputs"].IsString())) {
      std::string cputs = librariesJSON[i]["cputs"].GetString();
      libSummaries[libName].cputs = cputs.empty() ? 0 : (cputs == "true" ? 1 : -1);
    } else {
      missCputs = true;
    }
    auto const& libraryJSON = librariesJSON[i]["data"].GetArray();
    for(int j=0; j<libraryJSON.Size(); ++j) {
      if ((!libraryJSON[j].HasMember("id")) || (!libraryJSON[j]["id"].IsString())) {
        continue;
      }
      if ((!libraryJSON[j].HasMember("valid")) || (!libraryJSON[j]["valid"].IsBool())) {
        continue;
      }
      if ((!libraryJSON[j].HasMember("duration")) || (!libraryJSON[j]["duration"].IsUint64())) {
        continue;
      }
      if ((!libraryJSON[j].HasMember("total_execs")) || (!libraryJSON[j]["total_execs"].IsUint64())) {
        continue;
      }
      if ((!libraryJSON[j].HasMember("objective_size")) || (!libraryJSON[j]["objective_size"].IsUint64())) {
        continue;
      }
      if (!libraryJSON[j]["valid"].GetBool()) {
        haveFail = true;
        libSummaries[libName].fail_durations_s.push_back(libraryJSON[j]["duration"].GetUint64());
        libSummaries[libName].fail_total_execs.push_back(libraryJSON[j]["total_execs"].GetUint64());
        libSummaries[libName].total_runs++;
        libSummaries[libName].fail_comment.push_back("execution failed");

        LOGI << "  Fail " << libName << " attempt=" << libraryJSON[j]["id"].GetString() << Log::Flags::End;
        continue;
      }
      if (libraryJSON[j]["objective_size"].GetUint64() > 0) {
        haveSuccess = true;
        libSummaries[libName].success_count++;
        libSummaries[libName].success_durations_s.push_back(libraryJSON[j]["duration"].GetUint64());
        libSummaries[libName].success_total_execs.push_back(libraryJSON[j]["total_execs"].GetUint64());
        libSummaries[libName].total_runs++;
      } else {
        haveFail = true;
        libSummaries[libName].fail_durations_s.push_back(libraryJSON[j]["duration"].GetUint64());
        libSummaries[libName].fail_total_execs.push_back(libraryJSON[j]["total_execs"].GetUint64());
        libSummaries[libName].total_runs++;

        std::string comment = "no objectif found";
        if (libraryJSON[j].HasMember("run_error") && (libraryJSON[j]["run_error"].IsString())) {
          comment = libraryJSON[j]["run_error"].GetString();
        }
        libSummaries[libName].fail_comment.push_back(comment);

        LOGI << "  Fail " << libName << " attempt=" << libraryJSON[j]["id"].GetString() << 
            " comment=" << comment  << Log::Flags::End;
      }
    }
  }

  /** For old files, not having cputs in the summary json **/
  if (missCputs) {
    for (auto const& exp : analysis.experiments) {
      if ((libSummaries[exp.id].cputs == 0) && (!exp.user_run_state.empty())) {
        rapidjson::Document doc;
        doc.Parse(exp.user_run_state.c_str());
        if (doc.HasParseError()) {
          LOGW << "JSON Parse error in (" << taskInfoFile << " " << exp.id << ":" << 
              exp.attempt << ") " << exp.user_run_state << Log::Flags::End;
          continue;
        }
        if (doc.HasMember("cputs") && doc["cputs"].IsBool()) {
          libSummaries[exp.id].cputs = doc["cputs"].GetBool() ? 1 : -1;
        } else {
          LOGE << "Error, missing required field cputs in " << taskInfoFile << 
              " " << exp.id << ":" << exp.attempt << Log::Flags::End;
        }
      }
    }
  }

  if (analysis.experiments.size() == 0) {
    analysis.global_status = "no run";
  } else if (!haveFail) {
    analysis.global_status = "success";
  } else if (!haveSuccess) {
    analysis.global_status = "fail";
  } else {
    analysis.global_status = "mixed";
  }
  return true;
}

bool ns_Publish::RuleVuln3::BuildJSON(ns_Publish::Rule::TaskAnalysis const& analysis, 
    std::unordered_map<std::string, struct LibSummary> const& libSummaries,
    std::filesystem::path const& outputPath, std::string& outFile, 
    std::unordered_set<std::string>& libsManaged) {
  std::filesystem::create_directories(outputPath / folder_);
  std::string jsonRelativePath = folder_ / (analysis.commit_id + ".json");
  std::filesystem::path jsonPath = outputPath / jsonRelativePath;

  rapidjson::Document doc;
  doc.SetObject();
  auto& allocator = doc.GetAllocator();

  doc.AddMember("type", "Vuln", allocator);
  doc.AddMember("commit_id",
    rapidjson::Value(analysis.commit_id.c_str(), allocator), allocator);

  rapidjson::Value tasksDetails(rapidjson::kArrayType);
  rapidjson::Value taskDetails(rapidjson::kObjectType);
  taskDetails.AddMember("date",
    rapidjson::Value(analysis.date.c_str(), allocator), allocator);
  taskDetails.AddMember("task_id", analysis.task_id, allocator);
  taskDetails.AddMember("task_name",
    rapidjson::Value(analysis.task_name.c_str(), allocator), allocator);
  std::filesystem::path relativePath = ruleRelativePath_;
  taskDetails.AddMember("task_info",
    rapidjson::Value((relativePath / analysis.task_infos).c_str(), allocator), allocator);
  taskDetails.AddMember("task_data",
    rapidjson::Value((relativePath / analysis.task_data).c_str(), allocator), allocator);
  tasksDetails.PushBack(taskDetails, allocator);
  doc.AddMember("tasks", tasksDetails, allocator);

  doc.AddMember("global_status",
    rapidjson::Value(analysis.global_status.c_str(), allocator), allocator);

  rapidjson::Value libsObj(rapidjson::kObjectType);
  for (auto const& [libName, libSum] : libSummaries) {
    rapidjson::Value libData(rapidjson::kObjectType);
    libData.AddMember("details_id", 0, allocator);
    libData.AddMember("success_count", libSum.success_count, allocator);
    libData.AddMember("total_runs", libSum.total_runs, allocator);

    rapidjson::Value successDurations(rapidjson::kArrayType);
    for (auto duration : libSum.success_durations_s) {
      successDurations.PushBack(duration, allocator);
    }
    libData.AddMember("success_durations_s", successDurations, allocator);

    rapidjson::Value failDurations(rapidjson::kArrayType);
    for (auto duration : libSum.fail_durations_s) {
      failDurations.PushBack(duration, allocator);
    }
    libData.AddMember("fail_durations_s", failDurations, allocator);

    rapidjson::Value successTotalExecs(rapidjson::kArrayType);
    for (auto value : libSum.success_total_execs) {
      successTotalExecs.PushBack(value, allocator);
    }
    libData.AddMember("success_total_execs", successTotalExecs, allocator);

    rapidjson::Value failTotalExecs(rapidjson::kArrayType);
    for (auto value : libSum.fail_total_execs) {
      failTotalExecs.PushBack(value, allocator);
    }
    libData.AddMember("fail_total_execs", failTotalExecs, allocator);

    rapidjson::Value failComments(rapidjson::kArrayType);
    for (auto value : libSum.fail_comment) {
      failComments.PushBack(rapidjson::Value(value.c_str(), allocator), allocator);
    }
    libData.AddMember("fail_comments", failComments, allocator);

    libData.AddMember("cputs", libSum.cputs, allocator);

    libsObj.AddMember(
      rapidjson::Value(libName.c_str(), allocator), libData, allocator);

    libsManaged.insert(libName);
  }
  doc.AddMember("libs", libsObj, allocator);

  if (!UpdateJSON(jsonPath, doc, libsManaged)) {
    return false;
  }
  if (!ValidateUpdatedJSON(jsonPath)) {
    return false;
  }

  outFile = jsonRelativePath;
  return true;
}
