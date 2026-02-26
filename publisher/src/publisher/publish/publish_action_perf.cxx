#include "publish_action_perf.hxx"
#include "../../utils/logs.hxx"
#include <fstream>
#include <rapidjson/document.h>
#include <rapidjson/ostreamwrapper.h>
#include <rapidjson/writer.h>

bool ns_Publish::PublishActionPerf::Analyze(
    std::vector<std::filesystem::path>& inputFiles, 
    TaskAnalysis& experiments, 
    std::unordered_map<std::string, struct LibSummary>& libSummaries) {
  experiments = ExtractExperimentsFromFile(inputFiles);
  LOGI("Found " << experiments.experiments.size() << " Experiment steps");
  std::unordered_set<std::string> libs;
  bool haveSuccess = false;
  bool haveFail = false;
  LOGI("  task_id=" << experiments.date
      << "  task_name=" << experiments.task_name
      << "  commit=" << experiments.commit_id
  );
  for (auto const& exp : experiments.experiments) {
    libs.insert(exp.id);
    if (exp.exit_code == 512) {
      haveSuccess = true;
      libSummaries[exp.id].success_count++;
      libSummaries[exp.id].total_runs++;
      libSummaries[exp.id].success_durations_ms.push_back(exp.duration_ms);
    } else {
      libSummaries[exp.id].total_runs++;
      libSummaries[exp.id].fail_durations_ms.push_back(exp.duration_ms);
      haveFail = true;
      LOGI("  Experiment ID=" << exp.id
          << " attempt=" << exp.attempt
          << " state=" << exp.state
          << " exit_code=" << exp.exit_code
          << " duration=" << (exp.duration_ms / 1000 / 60)
      );
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
  return true;
}

bool ns_Publish::PublishActionPerf::GenerateCommitJson(
    PublishAction::TaskAnalysis const& analysis,
    std::unordered_map<std::string, struct LibSummary> const& libSummaries, 
    std::filesystem::path const& outputPath, std::string& outFile, 
    std::unordered_set<std::string>& libsManaged) {

  std::filesystem::create_directories(outputPath / "Perf");
  std::filesystem::path jsonRelativePath = std::filesystem::path("Perf") / (analysis.commit_id + ".json");
  std::filesystem::path jsonPath = outputPath / jsonRelativePath;

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
  for (auto const& [libName, libSum] : libSummaries) {
    rapidjson::Value libData(rapidjson::kObjectType);
    libData.AddMember("success_count", libSum.success_count, allocator);
    libData.AddMember("total_runs", libSum.total_runs, allocator);

    rapidjson::Value successDurations(rapidjson::kArrayType);
    for (auto duration : libSum.success_durations_ms) {
      successDurations.PushBack(duration, allocator);
    }
    libData.AddMember("success_durations_ms", successDurations, allocator);

    rapidjson::Value failDurations(rapidjson::kArrayType);
    for (auto duration : libSum.fail_durations_ms) {
      failDurations.PushBack(duration, allocator);
    }
    libData.AddMember("fail_durations_ms", failDurations, allocator);

    libsObj.AddMember(rapidjson::Value(libName.c_str(), allocator),
        libData, allocator);

    libsManaged.insert(libName);
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
  outFile = jsonRelativePath;
  return true;
}
