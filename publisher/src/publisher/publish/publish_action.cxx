#include "publish_action.hxx"
#include "publish_action_perf.hxx"
#include "../../utils/logs.hxx"
#include "../../utils/time.hxx"
#include <fstream>
#include <rapidjson/document.h>
#include <rapidjson/istreamwrapper.h>

ns_Publish::PublishAction::PublishAction() 
    : name_("unnamed"), filesFilter_() {
}

ns_Publish::PublishAction::PublishAction(std::string const& name, std::string const& filesFilter) 
    : name_(name), filesFilter_(filesFilter) {
}

ns_Publish::PublishAction::TaskAnalysis ns_Publish::PublishAction::ExtractExperiments(std::string const& jsonTaskFile) {
  TaskAnalysis result;

  std::ifstream ifs(jsonTaskFile);
  if (!ifs.is_open()) {
    LOGE("Failed to open JSON file: " << jsonTaskFile);
    throw std::runtime_error("Cannot open JSON file");
  }

  rapidjson::IStreamWrapper is(ifs);

  rapidjson::Document doc;
  doc.ParseStream(is);
  ifs.close();

  if (doc.HasParseError()) {
    LOGE("JSON parse error in file: " << jsonTaskFile);
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
    if (stepName == "Experiment") {
      ExperimentResult exp;
      exp.state = step.HasMember("state") && step["state"].IsString()
          ? step["state"].GetString() : "Unknown";
      exp.id = step.HasMember("id") && step["id"].IsString()
          ? step["id"].GetString() : "";
      exp.attempt = step.HasMember("attempt_id") && step["attempt_id"].IsInt()
          ? step["attempt_id"].GetInt() : -1;
      exp.exit_code = step.HasMember("exit_code") && step["exit_code"].IsInt()
          ? step["exit_code"].GetInt() : -1;

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

ns_Publish::PublishAction* ns_Publish::PublishAction::Build(std::string const& action, 
    std::string const& name, std::string const& filesFilter) {
  if(action == "GenerateReportPerf") {
    return new PublishActionPerf(name, filesFilter);
  } else if (action == "GenerateReportVuln") {
    return new PublishAction(name, filesFilter);
  }
  return nullptr;
}