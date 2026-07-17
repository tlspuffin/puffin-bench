#include "rule.hxx"
#include "rule_mergeJSON.hxx"
#include "rule_vuln3.hxx"
#include "rule_perf_summary.hxx"
#include "rule_campaign_summary.hxx"
#include "../../utils/logs.hxx"
#include "../../utils/dir.hxx"
#include "../../utils/time.hxx"
#include "../../utils/rapidjson.hxx"
#include <fstream>
#include <rapidjson/istreamwrapper.h>
#include <rapidjson/ostreamwrapper.h>
#include <rapidjson/writer.h>
#include <rapidjson/istreamwrapper.h>

ns_Publish::Rule::Rule(std::string const& name, std::string const& rulePath, 
    std::string const& ruleRelativePath, std::string const& filesFilter) 
    : name_(name), rulePath_(rulePath), ruleRelativePath_(ruleRelativePath), 
    filesFilter_(filesFilter), debugFilesFilter_(filesFilter)
{}

bool ns_Publish::Rule::Match(std::string const& file) {
  if (!IsSubDir(ruleRelativePath_, file)) {
    //LOGI << file << " is not in  " << ruleRelativePath_ << Log::Flags::End;
    return false;
  }
  std::string fileRelativePath = std::filesystem::path(file).lexically_relative(ruleRelativePath_);
  if (fileRelativePath.empty()) {
    fileRelativePath = file;
  }
  if (!std::regex_match(fileRelativePath, filesFilter_)) {
    //LOGI << fileRelativePath << " does not match " << debugFilesFilter_ << Log::Flags::End;
    return false;
  }
  LOGI << file << " apply rule " << name_ << "/" << 
      debugFilesFilter_ << Log::Flags::End;
  return true;
}

ns_Publish::Rule* ns_Publish::Rule::Build(std::string const& action, 
    std::string const& name, std::string const& rulesPath, 
    std::string const& rulesRelativePath, std::string const& filesFilter, 
    rapidjson::Value const& parameters) {
  if (action == "GenerateMergeJSON") {
    return new RuleMergeJSON(name, rulesPath, rulesRelativePath, filesFilter, parameters);
  } else if (action == "GenerateReportVuln3") {
    return new RuleVuln3(name, rulesPath, rulesRelativePath, filesFilter, parameters);
  } else if (action == "GenerateReportPerfFromSummary") {
    return new RulePerfUseSummary(name, rulesPath, rulesRelativePath, filesFilter, parameters);
  } else if (action == "GenerateReportCampaignFromSummary") {
    return new RuleCampaignUseSummary(name, rulesPath, rulesRelativePath, filesFilter, parameters);
  } else {
    return new RuleNULL(name, rulesPath, rulesRelativePath, filesFilter, parameters);
  }
}

ns_Publish::Rule::TaskAnalysis ns_Publish::Rule::ExtractExperimentsFromFile(
    std::string const& jsonTaskFileName, std::string const& taskDataFileName) {
  std::ifstream ifs(jsonTaskFileName);
  if (!ifs.is_open()) {
    LOGE << "Failed to open JSON file: " << jsonTaskFileName << Log::Flags::End;
    throw std::runtime_error("Cannot open JSON file");
  }

  std::ostringstream oss;
  oss << ifs.rdbuf();
  ifs.close();


  try {
    return ExtractExperimentsFromBuffer(oss.str(), jsonTaskFileName, taskDataFileName);
  } catch (std::runtime_error const& e) {
    std::ostringstream oss;
    oss << e.what() << " in file " << jsonTaskFileName;
    std::string errorMsg = oss.str();
    LOGE << errorMsg << Log::Flags::End;
    throw std::runtime_error(errorMsg);
  }
}

ns_Publish::Rule::TaskAnalysis ns_Publish::Rule::ExtractExperimentsFromBuffer(
    std::string const& jsonTaskBuffer, std::filesystem::path taskInfos, 
    std::filesystem::path taskData) {
  TaskAnalysis result;

  rapidjson::Document doc;
  doc.Parse(jsonTaskBuffer.c_str());

  if (doc.HasParseError()) {
    throw std::runtime_error("Invalid JSON format");
  }

  if (!doc.HasMember("task") || !doc["task"].IsObject()) {
    LOGW << "No 'task' object found in JSON" << Log::Flags::End;
    return result;
  }

  auto const& task = doc["task"];
  if (!task.HasMember("steps") || !task["steps"].IsObject()) {
    LOGW << "No 'steps' object found in task" << Log::Flags::End;
    return result;
  }

  if (IsSubDir(rulePath_, taskInfos)) {
    taskInfos = taskInfos.lexically_relative(rulePath_);
  }
  result.task_infos = taskInfos;
  if (IsSubDir(rulePath_, taskData)) {
    taskData = taskData.lexically_relative(rulePath_);
  }
  result.task_data = taskData;

  if (task.HasMember("id") && task["id"].IsUint64()) {
    result.task_id = task["id"].GetUint64();
    result.date = ToReadableDate(result.task_id);
  }

  if (task.HasMember("name") && task["name"].IsString()) {
    result.task_name = task["name"].GetString();
  }

  if (task.HasMember("user") && task["user"].IsString()) {
    result.user = task["user"].GetString();
  }

  if (task.HasMember("args") && task["args"].IsArray()) {
    for (auto const& arg : task["args"].GetArray()) {
      if (arg.HasMember("key") && arg["key"].IsString() && arg.HasMember("value")) {
        if ((std::string(arg["key"].GetString()) == "COMMIT_ID") && arg["value"].IsString()) {
          result.commit_id = arg["value"].GetString();
        } else if ((std::string(arg["key"].GetString()) == "CAMPAIGN_ID") && arg["value"].IsString()) {
          result.campaign_id = arg["value"].GetString();
        }
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
    if ((stepName == "ExperimentWithCargo") || (stepName == "Experiment")) {
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
      exp.timeout_ms = step.HasMember("timeout") && step["timeout"].IsUint64() 
          ? (step["timeout"].GetUint64() * 1000) : 0;

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

bool ns_Publish::Rule::UpdateJSON(std::string jsonPath, rapidjson::Document& newJSON, 
    std::unordered_set<std::string>& libsManaged) {
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

  jsonPath += ".tmp";
  std::ofstream ofs(jsonPath);
  if (!ofs.is_open()) {
    LOGE << "Failed to create JSON file: " << jsonPath << Log::Flags::End;
    throw std::runtime_error("Cannot create commit JSON");
  }
  rapidjson::OStreamWrapper os(ofs);
  rapidjson::Writer<rapidjson::OStreamWrapper> writer(os);
  newJSON.Accept(writer);
  ofs.close();
  LOGI << "Generated " << jsonPath << Log::Flags::End;

  return true;
}

std::unordered_set<std::string> ns_Publish::Rule::MergeResults(
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
  if ((!newResults.HasMember("tasks")) || (!newResults["tasks"].IsArray()) || 
      (newResults["tasks"].Empty())) {
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

  uint64_t detailsID = lastResults["tasks"].Size();
  rapidjson::Value taskCopy;
  taskCopy.CopyFrom(newResults["tasks"][0], alloc);
  lastResults["tasks"].PushBack(taskCopy, alloc);

  if ((!lastResults.HasMember("libs")) || (!lastResults["libs"].IsObject())) {
    lastResults.AddMember("libs", rapidjson::Value(rapidjson::kObjectType), alloc);
  }
  rapidjson::Value::ConstObject const& newLibs = newResults["libs"].GetObject();
  rapidjson::Value::Object libs = lastResults["libs"].GetObject();
  for(auto it=newLibs.MemberBegin(); it!=newLibs.MemberEnd(); ++it) {
    if (!it->name.IsString()) {
      continue;
    }
    std::string const libName = it->name.GetString();

    auto existing = libs.FindMember(it->name);
    if (existing != libs.MemberEnd()) {
      existing->value.CopyFrom(it->value, alloc);
      existing->value["details_id"].SetUint64(detailsID);
    } else {
      rapidjson::Value key(it->name, alloc);
      rapidjson::Value val(it->value, alloc);
      val["details_id"].SetUint64(detailsID);
      libs.AddMember(key, val, alloc);
    }
    libsManaged.insert(libName);
  }

  uint totalRun = 0;
  uint succesRun = 0;
  for(auto it=libs.MemberBegin(); it!=libs.MemberEnd(); ++it) {
    if (!it->name.IsString()) {
      continue;
    }
    auto const& val = it->value;
    if (val.HasMember("status") && val["status"].IsString()) {
      std::string status = val["status"].GetString();
      if (status == "success") {
        ++totalRun;
        ++succesRun;
      } else if (status == "mixed") {
        totalRun += 2;
        ++succesRun;
      } else if (status == "fail") {
        ++totalRun;
      }
    } else if (val.HasMember("total_runs") && val["total_runs"].IsUint() &&
        val.HasMember("success_count") && val["success_count"].IsUint()) {
      totalRun += val["total_runs"].GetUint();
      succesRun += val["success_count"].GetUint();
    } else {
      ++totalRun;
    }
  }
  if (totalRun == 0) {
    lastResults["global_status"].SetString("no run", alloc);
  } else if (succesRun == totalRun) {
    lastResults["global_status"].SetString("success", alloc);
  } else if (succesRun == 0) {
    lastResults["global_status"].SetString("fail", alloc);
  } else {
    lastResults["global_status"].SetString("mixed", alloc);
  }

  return libsManaged;
}


