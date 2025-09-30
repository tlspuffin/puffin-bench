#include "publish.hxx"
#include "../../embeded/publisher/index_html.h"
#include "../../embeded/publisher/index_css.h"
#include "../../embeded/publisher/index_js.h"
#include <fstream>
#include <algorithm>
#include <iostream>
#include <regex>
#include <rapidjson/document.h>
#include <rapidjson/istreamwrapper.h>
#include <rapidjson/ostreamwrapper.h>
#include <rapidjson/writer.h>

ns_Publish::Publish::Publish(Config const& config) 
    : config_(config) {
  LoadNotifiedList();
  StorageScan();
}

bool ns_Publish::Publish::Notify(
    std::string const& newPath, std::string& error) {
  error = "";
  std::error_code ec;
  std::filesystem::path path = std::filesystem::canonical(newPath, ec);
  if (path.empty()) {
    error = "Path does not exist or cannot be resolved: " + newPath;
    return false;
  }
  std::filesystem::path basePath = std::filesystem::canonical(config_.storage_, ec);
  if (basePath.empty()) {
    error = "Storage path is invalid or cannot be resolved: " + config_.storage_.string();
    return false;
  }

  std::string basePathStr = basePath.string();
  if (basePathStr.back() != '/') {
    basePathStr.push_back('/');
  }
  if ((path.string().size() < basePathStr.size()) || (path.string().find(basePathStr) != 0)) {
    error = "Path is outside the configured storage directory: " + newPath + 
        " (storage: " + config_.storage_.string() + ")";
    return false;
  }

  std::string key = std::filesystem::proximate(path, basePath).string();
  if (key.empty() || (key == ".")) {
    error = "Cannot notify the storage directory itself: " + newPath;
    return false;
  }

  bool success = Notify(key, false);
  if (!success) {
    error = "Failed to process notification for: " + key;
  }
  return success;
}

void ns_Publish::Publish::StorageScan() {
  for (auto const& commit_dir : std::filesystem::directory_iterator(config_.storage_)) {
    if (!commit_dir.is_directory()) {
      continue;
    }
    for (auto const& epoch_dir : std::filesystem::directory_iterator(commit_dir)) {
      if (!epoch_dir.is_directory()) {
        continue;
      }

      std::string key = (std::filesystem::proximate(epoch_dir, config_.storage_)).string();
      if (infos_.find(key) != infos_.end()) {
        continue;
      }
      Notify(key, IsOrphelin(epoch_dir, key));
    }
  }
  GenerateStaticHTML();
}

bool ns_Publish::Publish::Notify(std::string const& newPath, bool isOrphelin) {
  std::filesystem::path fullPath = config_.storage_ / newPath;
  infos_[newPath] = ParseReport(fullPath, newPath);

  if (!isOrphelin) {
    notifiedKeys_.insert(newPath);
    SaveNotifiedList();
  }

  bool isValid  = infos_[newPath].status_ == ReportInfos::Status::Valid;
  if (isValid) {
    infos_[newPath].origin_ = 
        isOrphelin ? ReportInfos::Origin::Orphan : ReportInfos::Origin::Normal;
  }

  GenerateStaticHTML();

  return isValid;
}

void ns_Publish::Publish::LoadNotifiedList() {
  std::error_code ec;
  std::filesystem::path notifyPath = config_.storage_ / ".publisher";
  std::filesystem::path notifyFile = notifyPath / "notified.json";
  if (!std::filesystem::exists(notifyPath)) {
    if (!std::filesystem::create_directory(notifyPath, ec)) {
      throw std::runtime_error("Cannot create .publisher directory: " + ec.message());
    }
  } else if (!std::filesystem::exists(notifyFile)) {
    return;
  }
  std::ifstream file(notifyFile);
  if (!file.is_open()) {
    return;
  }

  rapidjson::IStreamWrapper isw(file);
  rapidjson::Document doc;
  doc.ParseStream(isw);
  if (doc.HasParseError()) {
    throw std::runtime_error("Invalid JSON in notified.json");
  }
  if (!doc.IsArray()) {
    throw std::runtime_error("Expected JSON array in notified.json");
  }

  notifiedKeys_.clear();
  for (rapidjson::SizeType i=0; i<doc.Size(); ++i) {
    if (doc[i].IsString()) {
      notifiedKeys_.insert(doc[i].GetString());
    }
  }

  file.close();
}

void ns_Publish::Publish::SaveNotifiedList() {
  std::error_code ec;
  std::filesystem::path notifyPath = config_.storage_ / ".publisher";
  std::filesystem::path notifyFile = notifyPath / "notified.json";

  if (!std::filesystem::exists(notifyPath)) {
    if (!std::filesystem::create_directory(notifyPath, ec)) {
      throw std::runtime_error("Cannot create .publisher directory: " + ec.message());
    }
  }

  rapidjson::Document doc;
  doc.SetArray();
  rapidjson::Document::AllocatorType& allocator = doc.GetAllocator();

  for (const std::string& key : notifiedKeys_) {
      rapidjson::Value keyValue;
      keyValue.SetString(key.c_str(), key.length(), allocator);
      doc.PushBack(keyValue, allocator);
  }

  std::ofstream file(notifyFile);
  if (!file.is_open()) {
    throw std::runtime_error("Cannot open notified.json for writing");
  }

  rapidjson::OStreamWrapper osw(file);
  rapidjson::Writer<rapidjson::OStreamWrapper> writer(osw);
  doc.Accept(writer);

  file.close();
}

ns_Publish::Publish::ReportInfos ns_Publish::Publish::ParseReport(
    std::filesystem::path const& fullPath, std::string const& key) const { 
  ReportInfos info;

  std::filesystem::path keyPath(key);
  auto it = keyPath.begin();
  if (it != keyPath.end()) {
    info.commit_id_ = it->string();
    ++it;
    if (it != keyPath.end()) {
      info.epoch_ = std::stoull(it->string());
    } else {
      info.status_ = ReportInfos::Status::ParseError;
      info.error_message_ = "Missing epoch in key";
      return info;
    }
  } else {
    info.status_ = ReportInfos::Status::ParseError;
    info.error_message_ = "Missing git commit id in key";
    return info;
  }

  info.report_path_ = fullPath / "report" / "output" / "index.html";
  info.steps_json_path_ = fullPath / ".process_logs" / ".steps.json";

  if (!std::filesystem::exists(info.steps_json_path_)) {
    info.status_ = ReportInfos::Status::ParseError;
    info.error_message_ = "Missing .steps.json file";
    return info;
  }

  try {
    std::ifstream file(info.steps_json_path_);
    if (!file.is_open()) {
      info.status_ = ReportInfos::Status::ParseError;
      info.error_message_ = "Cannot open .steps.json";
      return info;
    }

    uint64_t first_timestamp = 0, last_timestamp = 0;
    std::string line;
    while (std::getline(file, line)) {
      rapidjson::Document stepDoc;
      stepDoc.Parse(line.c_str());
      if (stepDoc.HasParseError()) {
        continue;
      }

      StepInfo stepInfo;
      stepInfo.name_ = stepDoc["name"].GetString();
      stepInfo.status_ = stepDoc["state"].GetString();
      stepInfo.exit_code_ = stepDoc["exit_code"].GetInt();

      if (stepDoc.HasMember("time_points_ms") && stepDoc["time_points_ms"].IsArray()) {
        auto timePoints = stepDoc["time_points_ms"].GetArray();
        if (timePoints.Size() >= 2) {
          uint64_t start = timePoints[0].GetUint64();
          uint64_t end = timePoints[1].GetUint64();
          stepInfo.duration_ms_ = end - start;

          if (first_timestamp == 0) {
            first_timestamp = start;
          }
          last_timestamp = end;
        }
      }

      if (info.task_id_.empty() && stepDoc.HasMember("task")) {
        info.task_id_ = std::to_string(stepDoc["task"]["id"].GetUint64());
      }

      if (stepDoc.HasMember("stdout")) {
        stepInfo.stdout_path_ = stepDoc["stdout"].GetString();
      }
      if (stepDoc.HasMember("stderr")) {
        stepInfo.stderr_path_ = stepDoc["stderr"].GetString();
      }

      if (stepDoc.HasMember("executor_data") && 
          stepDoc["executor_data"].HasMember("cores") &&
          stepDoc["executor_data"]["cores"].IsArray()) {
        auto coresArray = stepDoc["executor_data"]["cores"].GetArray();
        for (auto& core : coresArray) {
          stepInfo.cores_used_.push_back(core.GetInt());
        }
      }

      if (stepDoc.HasMember("args") && stepDoc["args"].IsObject()) {
        StepInfo::RunInfo runInfo;
        runInfo.rank_id_ = stepDoc.HasMember("rank_id") ? stepDoc["rank_id"].GetInt() : 0;
        runInfo.status_ = stepInfo.status_;
        runInfo.exit_code_ = stepInfo.exit_code_;
        runInfo.duration_ms_ = stepInfo.duration_ms_;
        for (auto& arg : stepDoc["args"].GetObject()) {
          runInfo.args_[arg.name.GetString()] = arg.value.GetString();
        }

        stepInfo.runs_.push_back(runInfo);
      }

      info.steps_.push_back(stepInfo);
    }

    file.close();

    info.total_duration_ms_ = last_timestamp - first_timestamp;

    info.status_ = ReportInfos::Status::Valid;

  } catch (const std::exception& e) {
    info.status_ = ReportInfos::Status::ParseError;
    info.error_message_ = "JSON parsing error: " + std::string(e.what());
  }

  return info;
}

void ns_Publish::Publish::GenerateStaticHTML() const {

  if (!std::filesystem::exists(config_.weboutput_)) {
    throw std::runtime_error("");
  }

  std::ofstream js(config_.weboutput_ / "index.js");
  js << Publisher_JS_data;
  js.close();

  std::ofstream css(config_.weboutput_ / "index.css");
  css << Publisher_CSS_data;
  css.close();

  std::ofstream html(config_.weboutput_ / "index.html");
  if (!html) {
    throw std::runtime_error("");
  }

  html << Publisher_Index_data;

  std::unordered_map<std::string, std::vector<std::pair<std::string, const ReportInfos*>>> commitGroups;
  for (const auto& [key, info] : infos_) {
    commitGroups[info.commit_id_].emplace_back(key, &info);
  }

  for (const auto& [commit_id, reports] : commitGroups) {
    html << R"(<div class="commit-group" data-commit=")" << commit_id << R"(">)";
    html << R"(<div class="commit-header">)";
    html << R"(<h2>Commit: <span class="commit-id">)" << commit_id.substr(0, 12) << "...</span></h2>";
    html << R"(<div class="commit-stats">)" << reports.size() << " expérimentation(s)</div>";
    html << R"(</div>)";

    html << R"(<div class="reports-list">)";

    auto sortedReports = reports;
    std::sort(sortedReports.begin(), sortedReports.end(), 
        [](const auto& a, const auto& b) { return a.second->epoch_ > b.second->epoch_; });

    for (const auto& [key, info] : sortedReports) {
      std::string safeKey = std::regex_replace(key, std::regex("/"), "-");
      GenerateReportCard(html, safeKey, *info);
    }

    html << R"(</div></div>)";
  }

  html << R"(    </div>
    <script src="index.js"></script>
</body>
</html>)";

  html.close();
}

void ns_Publish::Publish::GenerateReportCard(std::ofstream& html, 
    std::string const& key, ReportInfos const& info) const {

  std::time_t timestamp = info.epoch_ / 1000;
  std::tm* tm = std::localtime(&timestamp);
  char dateStr[100];
  std::strftime(dateStr, sizeof(dateStr), "%Y-%m-%d %H:%M:%S", tm);

  std::string statusClass = "report-valid";
  std::string statusText = "✓ Succès";

  if (info.status_ == ReportInfos::Status::ParseError) {
    statusClass = "report-error";
    statusText = "❌ Erreur";
  } else if (info.origin_ == ReportInfos::Origin::Orphan) {
    statusClass = "report-orphan";
    statusText = "🔍 Orphelin";
  }

  html << R"(<div class="report-card )" << statusClass << R"(" data-epoch=")" << info.epoch_ 
      << R"(" data-status=")" << (info.status_ == ReportInfos::Status::Valid ? "valid" : "error")
      << R"(" data-origin=")" << (info.origin_ == ReportInfos::Origin::Orphan ? "orphan" : "normal") << R"(">)";

  html << R"(<div class="report-header">)";
  html << R"(<div class="report-date">)" << dateStr << "</div>";
  html << R"(<div class="report-status">)" << statusText << "</div>";
  html << R"(</div>)";

  if (info.status_ == ReportInfos::Status::Valid) {
    html << R"(<div class="report-meta">)";
    html << R"(<div class="meta-item"><span class="label">Task ID:</span> )" << info.task_id_ << "</div>";
    html << R"(<div class="meta-item"><span class="label">Durée:</span> )" 
        << (info.total_duration_ms_ / 1000) << "s</div>";
    html << R"(<div class="meta-item"><span class="label">Steps:</span> )" << info.steps_.size() << "</div>";
    html << R"(</div>)";

    html << R"(<div class="configurations">)";
    for (const auto& step : info.steps_) {
      if (step.name_ == "Experiment" && !step.runs_.empty()) {
        html << R"(<div class="config-list">)";
        for (const auto& run : step.runs_) {
          std::string configClass = "config-success";
          if (run.status_ == "TimedOut") {
            configClass = "config-timeout";
          }
          else if (run.exit_code_ != 0) {
            configClass = "config-error";
          }
          std::string configName = "Config " + std::to_string(run.rank_id_);
          auto featuresIt = run.args_.find("features");
          if (featuresIt != run.args_.end()) {
            configName = featuresIt->second;
          }

          html << R"(<span class="config-tag )" << configClass << R"(">)" 
              << configName << "</span>";
        }
        html << R"(</div>)";
      }
    }
    html << R"(</div>)";

    html << R"(<div class="report-actions">)";

    if (std::filesystem::exists(info.report_path_)) {
      std::filesystem::path relativePath = std::filesystem::proximate(info.report_path_, config_.weboutput_);
      html << R"(<a href=")" << relativePath.string() << R"(" target="_blank" class="btn btn-primary">)";
      html << R"(📊 Rapport Quarto</a>)";
    }

    html << R"raw(<button class="btn btn-secondary" onclick="ToggleDetails(')raw" << key << R"raw(')">)raw";
    html << R"(📋 Détails</button>)";
    html << R"(</div>)";

    html << R"(<div class="report-details" id="details-)" << key << R"(" style="display:none;">)";
    GenerateStepDetails(html, info.steps_);
    html << R"(</div>)";

  } else {
    html << R"(<div class="error-message">)" << info.error_message_ << "</div>";
  }

  html << R"(</div>)";
}

void ns_Publish::Publish::GenerateStepDetails(std::ofstream& html, 
    const std::vector<StepInfo>& steps) const {
  html << R"(<div class="steps-detail">)";
  html << R"(<h4>Détails des étapes</h4>)";

  for (const auto& step : steps) {
    html << R"(<div class="step-item">)";
    html << R"(<div class="step-header">)";
    html << R"(<span class="step-name">)" << step.name_ << "</span>";
    html << R"(<span class="step-status )" << (step.status_ == "Done" ? "status-done" : "status-error") 
        << R"(">)" << step.status_ << "</span>";
    html << R"(<span class="step-duration">)" << step.duration_ms_ << "ms</span>";
    html << R"(</div>)";

    if (!step.runs_.empty()) {
      html << R"(<div class="runs-list">)";
      for (const auto& run : step.runs_) {
        html << R"(<div class="run-item">)";
        html << R"(<span class="run-rank">Run )" << run.rank_id_ << "</span>";
        html << R"(<span class="run-status">)" << run.status_ << " ()" << run.exit_code_ << ")</span>";
        html << R"(<span class="run-duration">)" << run.duration_ms_ << "ms</span>";
        html << R"(</div>)";
      }
      html << R"(</div>)";
    }

    html << R"(</div>)";
  }

  html << R"(</div>)";
}