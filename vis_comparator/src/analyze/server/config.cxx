#include "config.hxx"
#include "../../utils/rapidjson.hxx"
#include "embeded/vis_comparator/index_html.h"
#include "embeded/vis_comparator/css/index_css.h"
#include "embeded/vis_comparator/js/apirest_js.h"
#include "embeded/vis_comparator/js/commithelp_js.h"
#include "embeded/vis_comparator/js/constants_js.h"
#include "embeded/vis_comparator/js/dialogs_js.h"
#include "embeded/vis_comparator/js/error_js.h"
#include "embeded/vis_comparator/js/graphmanager_js.h"
#include "embeded/vis_comparator/js/help_js.h"
#include "embeded/vis_comparator/js/index_js.h"
#include "embeded/vis_comparator/js/jsonhelp_js.h"
#include "embeded/vis_comparator/js/sidebar_js.h"
#include "embeded/vis_comparator/js/state_js.h"
#include "embeded/vis_comparator/js/ui_js.h"
#include "embeded/vis_comparator/templates/SingleTaskTemplate_json.h"
#include "embeded/vis_comparator/templates/TwoTasksTemplate_json.h"
#include <fstream>
#include <iostream>
#include "Poco/Exception.h"
#include "Poco/URI.h"
#include "plotly_3_3_0_min_js.h"

static ns_Server::Config defaultConfig;

ns_Server::Config::Config()
    : port_(8080), secure_(false), key_("security/site.key"),
    cert_("security/site.pem"), CA_("security/CA.pem"), html_("html"),
    userdata_("users_data/vis_comparator"), git_history_url_("")
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
  userdata_ = GetOrDefault<std::string>(*srv, "userdata", defaultConfig.userdata_);
  git_history_url_ = GetOrDefault<std::string>(*srv, "git_history_url", "");
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
  node.AddMember("userdata", rapidjson::Value(userdata_.c_str(), alloc), alloc);
  node.AddMember("git_history_url", rapidjson::Value(git_history_url_.c_str(), alloc), alloc);
  doc.AddMember(rapidjson::Value(name.c_str(), alloc), node, alloc);
}

void ns_Server::Config::Validate(bool forceInstall) const {
  auto discard = std::filesystem::canonical(html_);
  discard = std::filesystem::canonical(userdata_);
  if(secure_) {
    discard = std::filesystem::canonical(key_);
    discard = std::filesystem::canonical(cert_);
    discard = std::filesystem::canonical(CA_);
  }

  std::error_code ec;
  bool wasCreated = std::filesystem::create_directory(userdata_ / "templates", ec);
  if ((!wasCreated) && ec) {
    throw std::runtime_error("Unable to create userdata directory \"" + 
        (userdata_ / "templates").string() + "\": " + ec.message());
  }
  for(auto const& [ file, data, size ] : {
        std::tuple{ "templates/SingleTaskTemplate.json", VisComparator_Template_SingleTask_data, VisComparator_Template_SingleTask_size },
        std::tuple{ "templates/TwoTasksTemplate.json", VisComparator_Template_TwoTasks_data, VisComparator_Template_TwoTasks_size }
  }) {
    std::filesystem::path filePath = 
        std::filesystem::weakly_canonical(userdata_ / file);
    if (forceInstall || (!std::filesystem::exists(filePath))) {
      std::cout << "Creating missing required file " << filePath << std::endl;
      std::ofstream ofs(filePath, std::ios::binary);
      ofs.write(data, size);
      ofs.close();
      std::filesystem::permissions(filePath,
        std::filesystem::perms::owner_read | std::filesystem::perms::owner_write | 
        std::filesystem::perms::group_read, 
        std::filesystem::perm_options::replace);
    }
  }

  if (!git_history_url_.empty()) {
    try {
      const Poco::URI uri(git_history_url_);
      const std::string& scheme = uri.getScheme();
      if (scheme != "http" && scheme != "https")
        throw std::runtime_error("git_history_url must use http or https scheme");
    } catch (Poco::SyntaxException const& e) {
      throw std::runtime_error(std::string("git_history_url is not a valid URL: ") + e.what());
    }
  }

  std::filesystem::create_directory(html_/ "vis_comparator", ec);
  std::filesystem::create_directory(html_/ "vis_comparator" / "css", ec);
  std::filesystem::create_directory(html_/ "vis_comparator" / "js", ec);
  std::filesystem::create_directory(html_/ "vis_comparator" / "js", ec);
  std::filesystem::create_directory(html_/ "third-party", ec);
  std::filesystem::create_directory(html_/ "third-party" / "plotly", ec);
  for(auto const& [ file, data, size ] : {
      std::tuple{ "vis_comparator/index.html", VisComparator_HTML_Index_HTML_data, VisComparator_HTML_Index_HTML_size },
      std::tuple{ "vis_comparator/css/index.css", VisComparator_HTML_Index_CSS_data, VisComparator_HTML_Index_CSS_size },
      std::tuple{ "vis_comparator/js/apirest.js", VisComparator_HTML_APIRest_JS_data, VisComparator_HTML_APIRest_JS_size },
      std::tuple{ "vis_comparator/js/commithelp.js", VisComparator_HTML_CommitHelp_JS_data, VisComparator_HTML_CommitHelp_JS_size },
      std::tuple{ "vis_comparator/js/constants.js", VisComparator_HTML_Constants_JS_data, VisComparator_HTML_Constants_JS_size },
      std::tuple{ "vis_comparator/js/dialogs.js", VisComparator_HTML_Dialogs_JS_data, VisComparator_HTML_Dialogs_JS_size },
      std::tuple{ "vis_comparator/js/error.js", VisComparator_HTML_Error_JS_data, VisComparator_HTML_Error_JS_size },
      std::tuple{ "vis_comparator/js/graphmanager.js", VisComparator_HTML_GraphManager_JS_data, VisComparator_HTML_GraphManager_JS_size },
      std::tuple{ "vis_comparator/js/help.js", VisComparator_HTML_Help_JS_data, VisComparator_HTML_Help_JS_size },
      std::tuple{ "vis_comparator/js/index.js", VisComparator_HTML_Index_JS_data, VisComparator_HTML_Index_JS_size },
      std::tuple{ "vis_comparator/js/jsonhelp.js", VisComparator_HTML_JSONHelp_JS_data, VisComparator_HTML_JSONHelp_JS_size },
      std::tuple{ "vis_comparator/js/sidebar.js", VisComparator_HTML_Sidebar_JS_data, VisComparator_HTML_Sidebar_JS_size },
      std::tuple{ "vis_comparator/js/state.js", VisComparator_HTML_State_JS_data, VisComparator_HTML_State_JS_size },
      std::tuple{ "vis_comparator/js/ui.js", VisComparator_HTML_UI_JS_data, VisComparator_HTML_UI_JS_size },
      std::tuple{ "third-party/plotly/plotly-3.3.0.min.js", reinterpret_cast<char const*>(VisComparator_HTML_Ploty_JS), static_cast<size_t const>(VisComparator_HTML_Ploty_JS_len) },
  }) {
    std::filesystem::path filePath = 
        std::filesystem::weakly_canonical(html_ / file);
    if (forceInstall || (!std::filesystem::exists(filePath))) {
      std::cout << "Creating missing required file " << filePath << std::endl;
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
