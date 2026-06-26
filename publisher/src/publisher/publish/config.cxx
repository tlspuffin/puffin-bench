#include "config.hxx"
#include "../../utils/logs.hxx"
#include "../../utils/rapidjson.hxx"
#include "embeded/publisher/html/summary_config_js.h"
#include "embeded/publisher/html/summary_html.h"
#include "embeded/publisher/html/summary_css.h"
#include "embeded/publisher/html/summary_js.h"
#include "embeded/publisher/html/summary_render_js.h"
#include "embeded/publisher/html/summary_data_js.h"
#include "embeded/publisher/html/summary_metrics_js.h"
#include "embeded/publisher/html/summary_metricscampaign_js.h"
#include "embeded/publisher/html/summary_graph_js.h"
#include "embeded/publisher/html/summary_managegraphs_js.h"
#include "embeded/publisher/html/summary_graphoverview_js.h"
#include "embeded/publisher/html/summary_graphoverview_css.h"
#include "embeded/publisher/html/summary_graphcompare_js.h"
#include "embeded/publisher/html/summary_graphmetrics_js.h"
#include "embeded/publisher/html/summary_graphmetrics_css.h"
#include "embeded/publisher/html/third-party/plotly/plotly_3_3_0_min_js.h"
#include <fstream>
#include <tuple>

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
      std::tuple{ "publisher/summary.html", Publisher_HTML_Summary_HTML_data, Publisher_HTML_Summary_HTML_size },
      std::tuple{ "publisher/summary.css", Publisher_HTML_Summary_CSS_data, Publisher_HTML_Summary_CSS_size },
      std::tuple{ "publisher/summary.js", Publisher_HTML_Summary_JS_data, Publisher_HTML_Summary_JS_size },
      std::tuple{ "publisher/summary_render.js", Publisher_HTML_SummaryRender_JS_data, Publisher_HTML_SummaryRender_JS_size },
      std::tuple{ "publisher/summary_data.js", Publisher_HTML_SummaryData_JS_data, Publisher_HTML_SummaryData_JS_size },
      std::tuple{ "publisher/summary_metrics.js", Publisher_HTML_SummaryMetrics_JS_data, Publisher_HTML_SummaryMetrics_JS_size },
      std::tuple{ "publisher/summary_metricscampaign.js", Publisher_HTML_SummaryMetricsCampaign_JS_data, Publisher_HTML_SummaryMetricsCampaign_JS_size },
      std::tuple{ "publisher/summary_graph.js", Publisher_HTML_SummaryGraph_JS_data, Publisher_HTML_SummaryGraph_JS_size },
      std::tuple{ "publisher/summary_managegraphs.js", Publisher_HTML_SummaryManageGraphs_JS_data, Publisher_HTML_SummaryManageGraphs_JS_size },
      std::tuple{ "publisher/summary_graphoverview.js", Publisher_HTML_SummaryGraphOverview_JS_data, Publisher_HTML_SummaryGraphOverview_JS_size },
      std::tuple{ "publisher/summary_graphoverview.css", Publisher_HTML_SummaryGraphOverview_CSS_data, Publisher_HTML_SummaryGraphOverview_CSS_size },
      std::tuple{ "publisher/summary_graphcompare.js", Publisher_HTML_SummaryGraphCompare_JS_data, Publisher_HTML_SummaryGraphCompare_JS_size },
      std::tuple{ "publisher/summary_graphmetrics.js", Publisher_HTML_SummaryGraphMetrics_JS_data, Publisher_HTML_SummaryGraphMetrics_JS_size },
      std::tuple{ "publisher/summary_graphmetrics.css", Publisher_HTML_SummaryGraphMetrics_CSS_data, Publisher_HTML_SummaryGraphMetrics_CSS_size },
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
      std::tuple{ "publisher/summary_config.js", Publisher_HTML_SummaryConfig_JS_data, Publisher_HTML_SummaryConfig_JS_size },
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
