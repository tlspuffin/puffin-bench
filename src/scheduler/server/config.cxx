#include "config.hxx"
#include "../utils/rapidjson.hxx"

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

void ns_Server::Config::Validate() const {
  auto discard = std::filesystem::canonical(html_);
  if(secure_) {
    discard = std::filesystem::canonical(key_);
    discard = std::filesystem::canonical(cert_);
    discard = std::filesystem::canonical(CA_);
  }
}
