#include "config.hxx"
#include "../utils/logs.hxx"
#include "../utils/rapidjson.hxx"
#include <iostream>
#include <rapidjson/document.h>

Config::Config() 
  : logsLevel_(logs.GetLevel()), server_(), git_()
{}

bool Config::Load(std::string const& filepath) {
  rapidjson::Document doc;
  bool success = ReadJSONFile(filepath, doc);
  if (!success) {
    doc.SetObject();
  } else {
    success = doc.IsObject();
    if (!success) {
      LOGE << "Bad JSON document " << filepath << Log::Flags::End;
      doc.SetObject();
    }
  }
  if (doc.HasMember("logs_level") && doc["logs_level"].IsUint()) {
    logsLevel_ = doc["logs_level"].GetUint();
  }
  server_.Load("server", doc);
  git_.Load("git", doc);
  return success;
}

void Config::Save(std::string const& filepath) const {
  rapidjson::Document doc;
  doc.SetObject();
  rapidjson::MemoryPoolAllocator<>& alloc = doc.GetAllocator();
  doc.AddMember("logs_level", logsLevel_, alloc);
  server_.Save("server", doc, alloc);
  git_.Save("git", doc, alloc);
  SaveJSONFile(filepath, doc, true);
}

void Config::Validate(bool forceInstall) {
  server_.Validate();
  git_.Validate(forceInstall);
  logs.SetLevel(logsLevel_);
}
