#include "config.hxx"
#include "../../utils/logs.hxx"
#include "../../utils/rapidjson.hxx"

#include "embeded/html/board/logsmanager_js.h"
#include "embeded/html/board/terminal_js.h"
#include "embeded/html/board/clipboard_js.h"
#include "embeded/html/board/board_html.h"
#include "embeded/html/board/board_css.h"
#include "embeded/html/board/board_js.h"
#include "embeded/html/board/taskcard_css.h"
#include "embeded/html/board/taskcard_js.h"
#include "embeded/html/board/launchers/launchers_css.h"
#include "embeded/html/board/launchers/launchers_js.h"
//#include "embeded/html/board/custom/header_html.h"
#include "embeded/html/board/launchers/tlspuffin/joblauncher_css.h"
#include "embeded/html/board/launchers/tlspuffin/joblauncher_js.h"
#include "embeded/html/board/launchers/config_js.h"
#include "embeded/html/board/launchers/tlspuffin/config_js.h"
#include "embeded/html/board/launchers/tlspuffin/jobsconfig_json.h"
#include "embeded/html/board/task_html.h"
#include "embeded/html/board/task_css.h"
#include "embeded/html/board/task_js.h"
#include "embeded/html/board/history_html.h"
#include "embeded/html/board/history_css.h"
#include "embeded/html/board/history_js.h"
#include "embeded/html/jobsscripts/tlspuffin/PR_campaign_json.h"
#include "embeded/html/jobsscripts/tlspuffin/PR_perf_cargo_json.h"
#include "embeded/html/jobsscripts/tlspuffin/PR_perf_full_sh.h"
#include "embeded/html/jobsscripts/tlspuffin/PR_vulnerabilities_full_sh.h"
#include "embeded/html/jobsscripts/tlspuffin/PR_vulnerabilities-groupA_cargo_json.h"
#include "embeded/html/jobsscripts/tlspuffin/PR_vulnerabilities-groupB_cargo_json.h"
#include "embeded/html/jobsscripts/tlspuffin/shell_nix.h"
#include "embeded/html/jobsscripts/tlspuffin/wolfssl_put_c_patch.h"

#include <fstream>
#include <tuple>

static ns_Server::Config defaultConfig;

ns_Server::Config::Config()
    : port_(10082), secure_(false), key_("security/site.key"), 
    cert_("security/site.pem"), CA_("security/CA.pem"), html_("html")
{}

void ns_Server::Config::Load(std::string const& name, rapidjson::Value& doc) {
  rapidjson::Value emptySrv(rapidjson::kObjectType);
  rapidjson::Value const* srv = &emptySrv;
  if (doc.HasMember(name.c_str()) && (doc[name.c_str()].IsObject())) {
    srv = &(doc[name.c_str()]);
  }

  secure_ = GetOrDefault(*srv, "secure", defaultConfig.secure_);
  if (secure_) {
    key_ = GetOrDefaultPath(*srv, "key", std::filesystem::path(defaultConfig.key_));
    cert_ = GetOrDefaultPath(*srv, "cert", std::filesystem::path(defaultConfig.cert_));
    CA_ = GetOrDefaultPath(*srv, "CA",  std::filesystem::path(defaultConfig.CA_));
  }
  port_ = GetOrDefault<uint16_t>(*srv, "port",
      static_cast<uint16_t>(secure_ ? 8443 : defaultConfig.port_));

  html_ = GetOrDefault<std::string>(*srv, "html", defaultConfig.html_);
}

void ns_Server::Config::Save(std::string const& name, rapidjson::Value& doc, 
    rapidjson::MemoryPoolAllocator<>& alloc) const {
  rapidjson::Value node(rapidjson::kObjectType);
  node.AddMember("secure", secure_, alloc);
  node.AddMember("key", rapidjson::Value(key_.c_str(), alloc), alloc);
  node.AddMember("cert", rapidjson::Value(cert_.c_str(), alloc), alloc);
  node.AddMember("CA", rapidjson::Value(CA_.c_str(), alloc), alloc);
  node.AddMember("port", port_, alloc);
  node.AddMember("html", rapidjson::Value(html_.c_str(), alloc), alloc);
  doc.AddMember(rapidjson::Value(name.c_str(), alloc), node, alloc);
}

void ns_Server::Config::Validate(bool forceInstall) const {
  auto discard = std::filesystem::canonical(html_);
  if(secure_) {
    discard = std::filesystem::canonical(key_);
    discard = std::filesystem::canonical(cert_);
    discard = std::filesystem::canonical(CA_);
  }

  std::error_code ec;
  std::filesystem::create_directory(html_/ "board", ec);
  std::filesystem::create_directory(html_/ "board" / "custom", ec);
  std::filesystem::create_directory(html_/ "board" / "launchers", ec);
  std::filesystem::create_directory(html_/ "board" / "launchers" / "tlspuffin", ec);
  std::filesystem::create_directory(html_/ "jobsscripts", ec);
  std::filesystem::create_directory(html_/ "jobsscripts" / "tlspuffin", ec);
  for(auto const& [ file, data, size ] : {
      std::tuple{ "board/logsmanager.js", LogsManager_JS_data, LogsManager_JS_size },
      std::tuple{ "board/terminal.js", Terminal_JS_data, Terminal_JS_size },
      std::tuple{ "board/clipboard.js", Clipboard_JS_data, Clipboard_JS_size },
      std::tuple{ "board/board.html", Board_HTML_data, Board_HTML_size },
      std::tuple{ "board/board.css", Board_CSS_data, Board_CSS_size },
      std::tuple{ "board/board.js", Board_JS_data, Board_JS_size },
      std::tuple{ "board/taskcard.css", TaskCard_CSS_data, TaskCard_CSS_size },
      std::tuple{ "board/taskcard.js", TaskCard_JS_data, TaskCard_JS_size },
      std::tuple{ "board/launchers/launchers.css", Launchers_CSS_data, Launchers_CSS_size },
      std::tuple{ "board/launchers/launchers.js", Launchers_JS_data, Launchers_JS_size },
      //std::tuple{ "board/custom/header.html", CustomHeader_HTML_data, CustomHeader_HTML_size },
      std::tuple{ "board/launchers/tlspuffin/joblauncher.css", TLSPuffinJobLauncher_CSS_data, TLSPuffinJobLauncher_CSS_size },
      std::tuple{ "board/launchers/tlspuffin/joblauncher.js", TLSPuffinJobLauncher_JS_data, TLSPuffinJobLauncher_JS_size },
      std::tuple{ "board/task.html", Task_HTML_data, Task_HTML_size },
      std::tuple{ "board/task.css", Task_CSS_data, Task_CSS_size },
      std::tuple{ "board/task.js", Task_JS_data, Task_JS_size },
      std::tuple{ "board/history.html", History_HTML_data, History_HTML_size },
      std::tuple{ "board/history.css", History_CSS_data, History_CSS_size },
      std::tuple{ "board/history.js", History_JS_data, History_JS_size },
      std::tuple{ "jobsscripts/tlspuffin/PR_campaign.json", PRCampaign_JSON_data, PRCampaign_JSON_size },
      std::tuple{ "jobsscripts/tlspuffin/PR_perf_cargo.json", PRPerfCargo_JSON_data, PRPerfCargo_JSON_size },
      std::tuple{ "jobsscripts/tlspuffin/PR_perf_full.sh", PRPerfFull_SH_data, PRPerfFull_SH_size },
      std::tuple{ "jobsscripts/tlspuffin/PR_vulnerabilities_full.sh", PRVulnerabilitiesFull_SH_data, PRVulnerabilitiesFull_SH_size },
      std::tuple{ "jobsscripts/tlspuffin/PR_vulnerabilities-groupA_cargo.json", PRVulnerabilitiesGroupACargo_JSON_data, PRVulnerabilitiesGroupACargo_JSON_size },
      std::tuple{ "jobsscripts/tlspuffin/PR_vulnerabilities-groupB_cargo.json", PRVulnerabilitiesGroupBCargo_JSON_data, PRVulnerabilitiesGroupBCargo_JSON_size },
      std::tuple{ "jobsscripts/tlspuffin/shell.nix", Shell_NIX_data, Shell_NIX_size },
      std::tuple{ "jobsscripts/tlspuffin/wolfssl_put.c.patch", WolfsslPutC_PATCH_data, WolfsslPutC_PATCH_size },
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
        std::filesystem::perms::group_read, 
        std::filesystem::perm_options::replace);
    }
  }
  for(auto const& [ file, data, size ] : {
      std::tuple{ "board/launchers/config.js", LaunchersConfig_JS_data, LaunchersConfig_JS_size },
      std::tuple{ "board/launchers/tlspuffin/config.js", TLSPuffinLaunchersConfig_JS_data, TLSPuffinLaunchersConfig_JS_size },
      std::tuple{ "board/launchers/tlspuffin/jobsconfig.json", JobsConfig_JSON_data, JobsConfig_JSON_size },
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
        std::filesystem::perms::group_read, 
        std::filesystem::perm_options::replace);
    }
  }
}
