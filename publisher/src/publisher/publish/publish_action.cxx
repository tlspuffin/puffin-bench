#include "publish_action.hxx"
#include "publish_action_perf.hxx"
#include "publish_action_perf_summary.hxx"
#include "publish_action_vuln.hxx"
#include "publish_action_vuln2.hxx"
#include "publish_action_vuln3.hxx"
#include "../../utils/logs.hxx"
#include "../../utils/time.hxx"
#include <fstream>
#include <rapidjson/document.h>
#include <rapidjson/istreamwrapper.h>
#include <rapidjson/ostreamwrapper.h>
#include <rapidjson/writer.h>
#include <rapidjson/istreamwrapper.h>

ns_Publish::PublishAction::PublishAction() 
    : name_("unnamed"), filesFilter_() {
}

ns_Publish::PublishAction::PublishAction(std::string const& basePath, 
    std::string const& relativePath, std::string const& name, 
    std::string const& filesFilter, std::string const& finalTrigger) 
    : name_(name), basePath_(basePath), relativePath_(relativePath != "." ? relativePath : ""), 
    filesFilter_(filesFilter), debugFilesFilter_(filesFilter), finalTrigger_(finalTrigger) {
}

ns_Publish::PublishAction::TaskAnalysis ns_Publish::PublishAction::ExtractExperimentsFromFile(
    std::string const& jsonTaskFile, std::string const& taskDataFileName) {
  std::ifstream ifs(jsonTaskFile);
  if (!ifs.is_open()) {
    LOGE("Failed to open JSON file: " << jsonTaskFile.back());
    throw std::runtime_error("Cannot open JSON file");
  }

  std::ostringstream oss;
  oss << ifs.rdbuf();
  ifs.close();

  std::string jsonTaskFileName;
  try {
    return ExtractExperimentsFromBuffer(oss.str(), jsonTaskFileName, taskDataFileName);
  } catch (std::runtime_error const& e) {
    oss.str("");
    oss << e.what() << " in file " << jsonTaskFileName;
    throw std::runtime_error(oss.str());
  }
}

ns_Publish::PublishAction::TaskAnalysis ns_Publish::PublishAction::ExtractExperimentsFromBuffer(
    std::string const& jsonTaskBuffer, std::filesystem::path taskInfo, 
    std::filesystem::path taskData) {
  TaskAnalysis result;

  rapidjson::Document doc;
  doc.Parse(jsonTaskBuffer.c_str());

  if (doc.HasParseError()) {
    throw std::runtime_error("Invalid JSON format");
  }

  if (!doc.HasMember("task") || !doc["task"].IsObject()) {
    LOGW("No 'task' object found in JSON");
    return result;
  }

  auto const& task = doc["task"];
  if (!task.HasMember("steps") || !task["steps"].IsObject()) {
    LOGW("No 'steps' object found in task");
    return result;
  }

  if (IsSubDir(basePath_, taskInfo)) {
    taskInfo = std::filesystem::relative(taskInfo, basePath_);
  }
  result.task_infos = taskInfo;
  if (IsSubDir(basePath_, taskData)) {
    taskData = std::filesystem::relative(taskData, basePath_);
  }
  result.task_data = taskData;

  if (task.HasMember("id") && task["id"].IsUint64()) {
    result.task_id = task["id"].GetUint64();
    result.date = ToReadableDate(result.task_id);
  }

  if (task.HasMember("name") && task["name"].IsString()) {
    result.task_name = task["name"].GetString();
  }

  if (task.HasMember("args") && task["args"].IsArray()) {
    for (auto const& arg : task["args"].GetArray()) {
      if (arg.HasMember("key") && arg["key"].IsString() &&
            std::string(arg["key"].GetString()) == "COMMIT_ID") {
        if (arg.HasMember("value") && arg["value"].IsString()) {
          result.commit_id = arg["value"].GetString();
        }
        break;
      }
    }
  }

  auto const& steps = task["steps"];

  for (auto it = steps.MemberBegin(); it != steps.MemberEnd(); ++it) {
    auto const& step = it->value;

    if (!step.HasMember("name") || !step["name"].IsString()) {
      continue;
    }

    std::string stepName = step["name"].GetString();
    if ((stepName.find("Experiment") != std::string::npos) && (stepName != "ExperimentEnd")) {
      ExperimentResult exp;
      exp.state = step.HasMember("state") && step["state"].IsString()
          ? step["state"].GetString() : "Unknown";
      exp.id = step.HasMember("id") && step["id"].IsString()
          ? step["id"].GetString() : "";
      exp.attempt = step.HasMember("attempt_id") && step["attempt_id"].IsInt()
          ? step["attempt_id"].GetInt() : -1;
      exp.exit_code = step.HasMember("exit_code") && step["exit_code"].IsInt()
          ? step["exit_code"].GetInt() : -1;
      exp.user_run_state = step.HasMember("user_run_state") && step["user_run_state"].IsString()
          ? step["user_run_state"].GetString() : "";

      exp.duration_ms = 0;
      if (step.HasMember("time_points_ms") && step["time_points_ms"].IsArray()) {
        auto const& timePoints = step["time_points_ms"].GetArray();
        if (timePoints.Size() >= 2 && timePoints[0].IsUint64() &&
            timePoints[1].IsUint64()) {
          uint64_t start = timePoints[0].GetUint64();
          uint64_t end = timePoints[1].GetUint64();
          exp.duration_ms = end - start;
        }
      }

      result.experiments.push_back(exp);
    }
  }
  return result;
}

ns_Publish::PublishAction* ns_Publish::PublishAction::Build(std::string const& basePath, 
    std::string const& relativePath, std::string const& action, std::string const& name, 
    std::string const& filesFilter, std::string const& finalTrigger) {
  if (action == "GenerateReportPerf") {
    return new PublishActionPerf(basePath, relativePath, name, filesFilter, finalTrigger);
  } else if (action == "GenerateReportVuln") {
    return new PublishActionVuln(basePath, relativePath, name, filesFilter, finalTrigger);
  } else if (action == "GenerateReportPerfFromSummary") {
    return new PublishActionPerfUseSummary(basePath, relativePath, name, filesFilter, finalTrigger);
  } else if (action == "GenerateReportVuln2") {
    return new PublishActionVuln2(basePath, relativePath, name, filesFilter, finalTrigger);
  } else if (action == "GenerateReportVuln3") {
    return new PublishActionVuln3(basePath, relativePath, name, filesFilter, finalTrigger);
  }
  return nullptr;
}

bool ns_Publish::PublishAction::UpdateJSON(std::string const& jsonPath, 
    rapidjson::Document& newJSON, std::unordered_set<std::string>& libsManaged) {
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
    libsManaged = MergeResults(oldDoc, newJSON);
    if (libsManaged.empty()) {
      return false;
    }
    newJSON.Swap(oldDoc);
  }

  std::ofstream ofs(jsonPath);
  if (!ofs.is_open()) {
    LOGE("Failed to create JSON file: " << jsonPath);
    throw std::runtime_error("Cannot create commit JSON");
  }
  rapidjson::OStreamWrapper os(ofs);
  rapidjson::Writer<rapidjson::OStreamWrapper> writer(os);
  newJSON.Accept(writer);
  ofs.close();
  LOGI("Generated " << jsonPath);

  return true;
}

std::unordered_set<std::string> ns_Publish::PublishAction::MergeResults(
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

