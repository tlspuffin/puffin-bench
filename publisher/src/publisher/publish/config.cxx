#include "config.hxx"
#include "../../utils/logs.hxx"
#include "../../utils/rapidjson.hxx"
#include <fstream>
#include <tuple>

#include "embeded/publisher/summary_PR_config_js.h"
#include "embeded/publisher/summary_PR_html.h"
#include "embeded/publisher/summary_PR_css.h"
#include "embeded/publisher/summary_PR_js.h"
#include "embeded/publisher/summary_PR_metrics_js.h"
#include "embeded/publisher/summary_PR_metricscampaign_js.h"
#include "embeded/publisher/summary_PR_managegraphs_js.h"
#include "embeded/publisher/summary_PR_graphoverview_js.h"
#include "embeded/publisher/summary_PR_graphoverview_css.h"
#include "embeded/publisher/summary_PR_graphcompare_js.h"
#include "embeded/publisher/summary_PR_graphmetrics_js.h"
#include "embeded/publisher/summary_PR_graphmetrics_css.h"
#include "plotly_3_3_0_min_js.h"

static ns_Publish::Config defaultConfig;

ns_Publish::Config::Config() 
    : storage_("data"), html_("html"), orphanScanInterval_(3600)  
{}

void ns_Publish::Config::Load(std::string const& name, rapidjson::Value& doc) {
  rapidjson::Value emptyConfig(rapidjson::kObjectType);
  rapidjson::Value const* config = &emptyConfig;
  if (doc.HasMember(name.c_str()) && (doc[name.c_str()].IsObject())) {
    config = &doc[name.c_str()];
  }
  storage_ = std::filesystem::weakly_canonical(
      GetOrDefault<std::string>(*config, "storagePath", defaultConfig.storage_));
  html_ = std::filesystem::weakly_canonical(
      GetOrDefault<std::string>(*config, "htmlPath", defaultConfig.html_));
  orphanScanInterval_ = 
      GetOrDefault<uint64_t>(*config, "orphanScanInterval", defaultConfig.orphanScanInterval_);
}

void ns_Publish::Config::Save(std::string const& name, rapidjson::Value& doc, 
    rapidjson::MemoryPoolAllocator<>& alloc) const {
  rapidjson::Value node(rapidjson::kObjectType);
  node.AddMember("storagePath", rapidjson::Value(storage_.c_str(), alloc), alloc);
  node.AddMember("htmlPath", rapidjson::Value(html_.c_str(), alloc), alloc);
  node.AddMember("orphanScanInterval", orphanScanInterval_, alloc);
  doc.AddMember(rapidjson::Value(name.c_str(), alloc), node, alloc);
}

void ns_Publish::Config::Validate(bool forceInstall) const {
  auto discard = std::filesystem::canonical(storage_);
  discard = std::filesystem::canonical(html_);

  std::error_code ec;
  std::filesystem::create_directory(html_/ "publisher", ec);
  std::filesystem::create_directory(html_/ "third-party", ec);
  std::filesystem::create_directory(html_/ "third-party" / "plotly", ec);
  for(auto const& [ file, data, size ] : {
      std::tuple{ "publisher/summary_PR.html", Publisher_HTML_SummaryPR_HTML_data, Publisher_HTML_SummaryPR_HTML_size },
      std::tuple{ "publisher/summary_PR.css", Publisher_HTML_SummaryPR_CSS_data, Publisher_HTML_SummaryPR_CSS_size },
      std::tuple{ "publisher/summary_PR.js", Publisher_HTML_SummaryPR_JS_data, Publisher_HTML_SummaryPR_JS_size },
      std::tuple{ "publisher/summary_PR_metrics.js", Publisher_HTML_SummaryPRMetrics_JS_data, Publisher_HTML_SummaryPRMetrics_JS_size },
      std::tuple{ "publisher/summary_PR_metricscampaign.js", Publisher_HTML_SummaryPRMetricsCampaign_JS_data, Publisher_HTML_SummaryPRMetricsCampaign_JS_size },
      std::tuple{ "publisher/summary_PR_managegraphs.js", Publisher_HTML_SummaryPRManageGraphs_JS_data, Publisher_HTML_SummaryPRManageGraphs_JS_size },
      std::tuple{ "publisher/summary_PR_graphoverview.js", Publisher_HTML_SummaryPRGraphOverview_JS_data, Publisher_HTML_SummaryPRGraphOverview_JS_size },
      std::tuple{ "publisher/summary_PR_graphoverview.css", Publisher_HTML_SummaryPRGraphOverview_CSS_data, Publisher_HTML_SummaryPRGraphOverview_CSS_size },
      std::tuple{ "publisher/summary_PR_graphcompare.js", Publisher_HTML_SummaryPRGraphCompare_JS_data, Publisher_HTML_SummaryPRGraphCompare_JS_size },
      std::tuple{ "publisher/summary_PR_graphmetrics.js", Publisher_HTML_SummaryPRGraphMetrics_JS_data, Publisher_HTML_SummaryPRGraphMetrics_JS_size },
      std::tuple{ "publisher/summary_PR_graphmetrics.css", Publisher_HTML_SummaryPRGraphMetrics_CSS_data, Publisher_HTML_SummaryPRGraphMetrics_CSS_size },
      std::tuple{ "third-party/plotly/plotly-3.3.0.min.js", reinterpret_cast<char const*>(Publisher_HTML_Ploty_JS), static_cast<size_t const>(Publisher_HTML_Ploty_JS_len) },
  }) {
    std::filesystem::path filePath = 
        std::filesystem::weakly_canonical(html_ / file);
    if (forceInstall || (!std::filesystem::exists(filePath))) {
      LOGI << "Creating missing required file " << filePath << Log::Flags::End;
      std::ofstream ofs(filePath, std::ios::binary);
      ofs.write(data, size);
      ofs.close();
      std::filesystem::permissions(filePath,
        std::filesystem::perms::owner_read | std::filesystem::perms::owner_write | 
        std::filesystem::perms::group_read | std::filesystem::perms::others_read, 
        std::filesystem::perm_options::replace);
    }
  }
  for(auto const& [ file, data, size ] : {
      std::tuple{ "publisher/summary_PR_config.js", Publisher_HTML_SummaryPRConfig_JS_data, Publisher_HTML_SummaryPRConfig_JS_size },
  }) {
    std::filesystem::path filePath = 
        std::filesystem::weakly_canonical(html_ / file);
    if (!std::filesystem::exists(filePath)) {
      LOGI << "Creating missing required file " << filePath << Log::Flags::End;
      std::ofstream ofs(filePath, std::ios::binary);
      ofs.write(data, size);
      ofs.close();
      std::filesystem::permissions(filePath,
        std::filesystem::perms::owner_read | std::filesystem::perms::owner_write | 
        std::filesystem::perms::group_read | std::filesystem::perms::others_read, 
        std::filesystem::perm_options::replace);
    }
  }
};
