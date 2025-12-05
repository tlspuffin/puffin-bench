#include "publish_action_vuln2.hxx"
#include "../../utils/logs.hxx"
#include <fstream>
#include <rapidjson/document.h>
#include <rapidjson/ostreamwrapper.h>
#include <rapidjson/writer.h>

ns_Publish::PublishActionVuln2::TaskAnalysis ns_Publish::PublishActionVuln2::Analyze(std::string jsonTaskFile) {
  TaskAnalysis experiments = ExtractExperimentsFromFile(jsonTaskFile);
  LOGI("Found " << experiments.experiments.size() << " Experiment steps");
  bool haveSuccess = false;
  bool haveFail = false;
  bool requireCPut = true;
  LOGI("  task_id=" << experiments.date
      << "  task_name=" << experiments.task_name
      << "  commit=" << experiments.commit_id
  );
  for (auto const& exp : experiments.experiments) {
    if ((exp.exit_code == 0) && (exp.state == "Done")) {
      haveSuccess = true;
      experiments.libs_summary[exp.id].success_count++;
      experiments.libs_summary[exp.id].total_runs++;
      experiments.libs_summary[exp.id].success_durations_ms.push_back(exp.duration_ms);
    } else {
      experiments.libs_summary[exp.id].total_runs++;
      experiments.libs_summary[exp.id].fail_durations_ms.push_back(exp.duration_ms);
      haveFail = true;
      LOGI("  Experiment ID=" << exp.id
          << " attempt=" << exp.attempt
          << " state=" << exp.state
          << " exit_code=" << exp.exit_code
          << " duration=" << (exp.duration_ms / 1000 / 60)
      );
    }

    if (requireCPut && (!exp.user_run_state.empty())) {
      rapidjson::Document doc;
      doc.Parse(exp.user_run_state.c_str());
      if (doc.HasParseError()) {
        LOGW("JSON Parse error in (" << jsonTaskFile << " " << 
            exp.id << ":" << exp.attempt << ") " << exp.user_run_state);
        continue;
      }
      if (doc.HasMember("cputs") && doc["cputs"].IsBool()) {
        experiments.libs_summary[exp.id].cputs = doc["cputs"].GetBool() ? 1 : -1;
        requireCPut = false;
      } else {
        LOGE("Error, missing required field cputs in " << jsonTaskFile << 
            " " << exp.id << ":" << exp.attempt);
      }
    }
  }
  if (experiments.experiments.size() == 0) {
    experiments.global_status = "no run";
  } else if (!haveFail) {
    experiments.global_status = "success";
  } else if (!haveSuccess) {
    experiments.global_status = "fail";
  } else {
    experiments.global_status = "mixed";
  }
  return experiments;
}

bool ns_Publish::PublishActionVuln2::GenerateCommitJson(
    ns_Publish::PublishAction::TaskAnalysis const& analysis,
    std::filesystem::path const& outputPath) {

  std::filesystem::create_directories(outputPath / "Vuln");
  std::filesystem::path jsonPath = outputPath / "Vuln" / (analysis.commit_id + ".json");

  rapidjson::Document doc;
  doc.SetObject();
  auto& allocator = doc.GetAllocator();

  doc.AddMember("commit_id",
    rapidjson::Value(analysis.commit_id.c_str(), allocator), allocator);
  doc.AddMember("date",
    rapidjson::Value(analysis.date.c_str(), allocator), allocator);
  doc.AddMember("task_id", analysis.task_id, allocator);
  doc.AddMember("task_name",
    rapidjson::Value(analysis.task_name.c_str(), allocator), allocator);
  doc.AddMember("global_status",
    rapidjson::Value(analysis.global_status.c_str(), allocator), allocator);

  rapidjson::Value libsObj(rapidjson::kObjectType);
  for (auto const& [libName, libSum] : analysis.libs_summary) {
    rapidjson::Value libData(rapidjson::kObjectType);
    libData.AddMember("success_count", libSum.success_count, allocator);
    libData.AddMember("total_runs", libSum.total_runs, allocator);

    rapidjson::Value successDurations(rapidjson::kArrayType);
    for (auto duration : libSum.success_durations_ms) {
      successDurations.PushBack(((uint64_t)((double)duration / 1000.0)), allocator);
    }
    libData.AddMember("success_durations_s", successDurations, allocator);

    rapidjson::Value failDurations(rapidjson::kArrayType);
    for (auto duration : libSum.fail_durations_ms) {
      failDurations.PushBack(((uint64_t)((double)duration / 1000.0)), allocator);
    }
    libData.AddMember("fail_durations_s", failDurations, allocator);

    libData.AddMember("cputs", libSum.cputs, allocator);

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
