#include "publish_action_vuln3.hxx"
#include "../../utils/logs.hxx"
#include "../../utils/file_tgz.hxx"
#include "../../utils/rapidjson.hxx"
#include <fstream>
#include <rapidjson/ostreamwrapper.h>
#include <rapidjson/writer.h>
#include <rapidjson/istreamwrapper.h>

bool ns_Publish::PublishActionVuln3::Analyze(std::vector<std::filesystem::path>& inputFiles, 
    PublishAction::TaskAnalysis& analysis, 
    std::unordered_map<std::string, struct LibSummary>& libSummaries) {
  std::string taskDataFile = inputFiles.back();
  std::filesystem::path outsideJSON = std::filesystem::path(taskDataFile).replace_extension("json");
  if (!std::filesystem::exists(outsideJSON)) {
    return false;
  }
  FileTGZ filetgz(taskDataFile);
  inputFiles.push_back(outsideJSON);
  std::vector<std::pair<std::string, uint64_t>> fileInfo = filetgz.ListFiles(std::regex("[0-9]+\\.json"));
  if (fileInfo.size() != 1) {
    return false;
  }
  std::string taskJSON;
  taskJSON.resize(fileInfo[0].second + 1);
  taskJSON[fileInfo[0].second] = 0;
  int64_t readSize = filetgz.ExtractFileData(fileInfo[0].first, fileInfo[0].second, taskJSON.data(), nullptr);
  if ((readSize != fileInfo[0].second) || (taskJSON.empty())) {
    return false;
  }
  analysis = ExtractExperimentsFromBuffer(taskJSON, outsideJSON, taskDataFile);
  LOGI("  task_id=" << analysis.date
      << "  task_name=" << analysis.task_name
      << "  commit=" << analysis.commit_id
  );

  fileInfo = filetgz.ListFiles(std::regex("run-summary.json"));
  if (fileInfo.size() != 1) {
    return false;
  }
  std::string runSummary;
  runSummary.resize(fileInfo[0].second + 1);
  runSummary[fileInfo[0].second] = 0;
  readSize = filetgz.ExtractFileData(fileInfo[0].first, fileInfo[0].second, runSummary.data(), nullptr);
  if ((readSize != fileInfo[0].second) || (runSummary.empty())) {
    return false;
  }
  rapidjson::Document runSummaryJSON;
  runSummaryJSON.Parse(runSummary.c_str());
  if (runSummaryJSON.HasParseError()) {
    throw std::runtime_error("Invalid JSON format");
  }
  if ((!runSummaryJSON.HasMember("libraries")) || (!runSummaryJSON["libraries"].IsArray())) {
    LOGW("No 'libraries' object found in JSON");
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
        LOGI("  Fail " << libName << " attempt=" << libraryJSON[j]["id"].GetString());
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
        LOGI("  Fail " << libName << " attempt=" << libraryJSON[j]["id"].GetString());
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
          LOGW("JSON Parse error in (" << fileInfo[0].first << " " << 
              exp.id << ":" << exp.attempt << ") " << exp.user_run_state);
          continue;
        }
        if (doc.HasMember("cputs") && doc["cputs"].IsBool()) {
          libSummaries[exp.id].cputs = doc["cputs"].GetBool() ? 1 : -1;
        } else {
          LOGE("Error, missing required field cputs in " << fileInfo[0].first << 
              " " << exp.id << ":" << exp.attempt);
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

bool ns_Publish::PublishActionVuln3::GenerateCommitJson(
    PublishAction::TaskAnalysis const& analysis, 
    std::unordered_map<std::string, struct LibSummary> const& libSummaries,
    std::filesystem::path const& outputPath, std::string& outFile, 
    std::unordered_set<std::string>& libsManaged) {

  std::filesystem::create_directories(outputPath / "Vuln");
  std::string jsonRelativePath = std::filesystem::path("Vuln") / (analysis.commit_id + ".json");
  std::filesystem::path jsonPath = outputPath / jsonRelativePath;

  rapidjson::Document doc;
  doc.SetObject();
  auto& allocator = doc.GetAllocator();

  doc.AddMember("commit_id",
    rapidjson::Value(analysis.commit_id.c_str(), allocator), allocator);

  rapidjson::Value tasksDetails(rapidjson::kArrayType);
  rapidjson::Value taskDetails(rapidjson::kObjectType);
  taskDetails.AddMember("date",
    rapidjson::Value(analysis.date.c_str(), allocator), allocator);
  taskDetails.AddMember("task_id", analysis.task_id, allocator);
  taskDetails.AddMember("task_name",
    rapidjson::Value(analysis.task_name.c_str(), allocator), allocator);
  taskDetails.AddMember("task_info",
    rapidjson::Value(analysis.task_infos.c_str(), allocator), allocator);
  taskDetails.AddMember("task_data",
    rapidjson::Value(analysis.task_data.c_str(), allocator), allocator);
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

    libData.AddMember("cputs", libSum.cputs, allocator);

    libsObj.AddMember(
      rapidjson::Value(libName.c_str(), allocator), libData, allocator);

    libsManaged.insert(libName);
  }
  doc.AddMember("libs", libsObj, allocator);

  rapidjson::Document oldDoc;
  if (std::filesystem::exists(jsonPath)) {
    std::ifstream ifs(jsonPath);
    if (!ifs) {
      return false;
    }
    rapidjson::IStreamWrapper isw(ifs);
    if (oldDoc.ParseStream(isw).HasParseError()) {
      return false;
    }
    ifs.close();
    libsManaged = MergeResults(oldDoc, doc);
    if (libsManaged.empty()) {
      return false;
    }
    doc.Swap(oldDoc);
  }

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
  outFile = jsonRelativePath;
  return true;
}

std::unordered_set<std::string> ns_Publish::PublishActionVuln3::MergeResults(
    rapidjson::Document& lastResults, rapidjson::Document const& newResults) {
  std::unordered_set<std::string> libsManaged;
  if ((!newResults.HasMember("libs")) || (!newResults["libs"].IsObject())) {
    return libsManaged;
  }

  std::string newCommitID = GetOrDefault<std::string>(newResults, "commit_id", "");
  if (newCommitID.empty()) {
    return libsManaged;
  }
  std::string lastCommitID = GetOrDefault<std::string>(lastResults, "commit_id", "");
  if (lastCommitID.empty() || (newCommitID != lastCommitID)) {
    return libsManaged;
  }
  if ((!newResults.HasMember("tasks")) || (!newResults["tasks"].IsArray())) {
    return libsManaged;
  }
  if ((!lastResults.HasMember("tasks")) || (!lastResults["tasks"].IsArray())) {
    return libsManaged;
  }
  std::string newStatus = GetOrDefault<std::string>(newResults, "global_status", "");
  if (newStatus.empty()) {
    return libsManaged;
  }
  std::string lastStatus = GetOrDefault<std::string>(lastResults, "global_status", "");
  if (lastStatus.empty()) {
    return libsManaged;
  }

  rapidjson::MemoryPoolAllocator<>& alloc = lastResults.GetAllocator();
  //lastResults["date"].SetString(newDate.c_str(), alloc);
  if (newStatus != lastStatus) {
    if (((lastStatus == "no run") && (newStatus == "fail")) || 
        ((lastStatus == "fail") && (newStatus == "no run"))) {
      lastResults["global_status"].SetString("fail", alloc);
    } else {
      lastResults["global_status"].SetString("mixed", alloc);
    }
  }

  uint64_t detailsID = lastResults["tasks"].Size();
  rapidjson::Value taskCopy;
  taskCopy.CopyFrom(newResults["tasks"][0], alloc);
  lastResults["tasks"].PushBack(taskCopy, alloc);

  rapidjson::Value const& newLibs = newResults["libs"].GetObj();
  if ((lastResults.HasMember("libs")) && (lastResults["libs"].IsObject())) {
    rapidjson::Value& libs = lastResults["libs"].GetObj();
    for(auto it=libs.MemberBegin(); it!=libs.MemberEnd(); ++it) {
      if (!it->name.IsString()) {
        continue;
      }
      std::string const libName = it->name.GetString();
      for(auto newIT=newLibs.MemberBegin(); newIT!=newLibs.MemberEnd(); ++newIT) {
        if ((!newIT->name.IsString()) || (libName != newIT->name.GetString())) {
          continue;
        }
        it->value.CopyFrom(newIT->value, alloc);
        it->value["details_id"].SetUint64(detailsID);
        libsManaged.insert(libName);
        break;
      }
    }
  } else {
    lastResults.AddMember("libs", rapidjson::Value(rapidjson::kObjectType), alloc);
  }
  for(auto it=newLibs.MemberBegin(); it!=newLibs.MemberEnd(); ++it) {
    if (!it->name.IsString()) {
      continue;
    }
    std::string const libName = it->name.GetString();
    if (libsManaged.find(libName) != libsManaged.end()) {
      continue;
    }
    rapidjson::Value key(it->name, alloc);
    rapidjson::Value val(it->value, alloc);
    val["details_id"].SetUint64(detailsID);
    lastResults["libs"].AddMember(key, val, alloc);
    libsManaged.insert(it->name.GetString());
  }
  return libsManaged;
}