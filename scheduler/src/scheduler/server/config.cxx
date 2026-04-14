#include "config.hxx"
#include "../../utils/logs.hxx"
#include "../../utils/rapidjson.hxx"

#include "../../embeded/html/board/board_html.h"
#include "../../embeded/html/board/board_css.h"
#include "../../embeded/html/board/board_js.h"
#include "../../embeded/html/board/joblauncher_css.h"
#include "../../embeded/html/board/joblauncher_js.h"
#include "../../embeded/html/board/taskcard_css.h"
#include "../../embeded/html/board/taskcard_js.h"
#include "../../embeded/html/board/terminal_js.h"

#include <fstream>
#include <tuple>

static ns_Server::Config defaultConfig;

ns_Server::Config::Config()
    : port_(8080), secure_(false), key_("security/site.key"), 
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
  for(auto const& [ file, data, size ] : {
      std::tuple{ "board/board.html", Board_HTML_data, Board_HTML_size },
      std::tuple{ "board/board.css", Board_CSS_data, Board_CSS_size },
      std::tuple{ "board/board.js", Board_JS_data, Board_JS_size },
      std::tuple{ "board/joblauncher.css", JobLauncher_CSS_data, JobLauncher_CSS_size },
      std::tuple{ "board/joblauncher.js", JobLauncher_JS_data, JobLauncher_JS_size },
      std::tuple{ "board/taskcard.css", TaskCard_CSS_data, TaskCard_CSS_size },
      std::tuple{ "board/taskcard.js", TaskCard_JS_data, TaskCard_JS_size },
      std::tuple{ "board/terminal.js", Terminal_JS_data, Terminal_JS_size },
  }) {
    std::filesystem::path filePath = 
        std::filesystem::weakly_canonical(html_ / file);
    if (forceInstall || (!std::filesystem::exists(filePath))) {
      LOGE("Creating missing required file " << filePath);
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