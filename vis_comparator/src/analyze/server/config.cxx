#include "config.hxx"
#include "../../utils/rapidjson.hxx"
#include "embeded/vis_comparator/embedded_file.h"
#include "embeded/vis_comparator/webassets_all.h"
#include "embeded/vis_comparator/templates/templates_all.h"
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

  // Writes data to filePath only when it is missing; forceInstall (--force) reinstalls
  // everything. Mirrors the previous per-file behaviour for every embedded file.
  auto install = [forceInstall](std::filesystem::path const& filePath,
                                char const* data, size_t size) {
    if (forceInstall || (!std::filesystem::exists(filePath))) {
      std::cout << "Creating missing required file " << filePath << std::endl;
      std::ofstream ofs(filePath, std::ios::binary);
      ofs.write(data, size);
      ofs.close();
      std::filesystem::permissions(filePath,
        std::filesystem::perms::owner_read | std::filesystem::perms::owner_write |
        std::filesystem::perms::group_read | std::filesystem::perms::others_read,
        std::filesystem::perm_options::replace);
    }
  };

  std::error_code ec;
  bool wasCreated = std::filesystem::create_directory(userdata_ / "templates", ec);
  if ((!wasCreated) && ec) {
    throw std::runtime_error("Unable to create userdata directory \"" +
        (userdata_ / "templates").string() + "\": " + ec.message());
  }
  for (size_t i = 0; i < VisComparator_Templates_count; ++i) {
    EmbeddedFile const& f = VisComparator_Templates[i];
    install(std::filesystem::weakly_canonical(userdata_ / "templates" / f.name),
            f.data, f.size);
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

  // Web assets (html/css/js): directories are derived from each file's relative path.
  for (size_t i = 0; i < VisComparator_WebAssets_count; ++i) {
    EmbeddedFile const& f = VisComparator_WebAssets[i];
    std::filesystem::path filePath =
        std::filesystem::weakly_canonical(html_ / "vis_comparator" / f.name);
    std::filesystem::create_directories(filePath.parent_path(), ec);
    install(filePath, f.data, f.size);
  }

  // Plotly: binary blob embedded via xxd, kept separate from the globbed assets.
  std::filesystem::create_directories(html_ / "third-party" / "plotly", ec);
  install(std::filesystem::weakly_canonical(html_ / "third-party" / "plotly" / "plotly-3.3.0.min.js"),
          reinterpret_cast<char const*>(VisComparator_HTML_Ploty_JS),
          static_cast<size_t>(VisComparator_HTML_Ploty_JS_len));
}
