#include "config.hxx"
#include "../utils/logs.hxx"
#include "../utils/rapidjson.hxx"

#include <fstream>
#include <iostream>
#include <rapidjson/document.h>
#include <rapidjson/istreamwrapper.h>
#include <rapidjson/prettywriter.h>
#include <rapidjson/ostreamwrapper.h>
#include <rapidjson/error/error.h>
#include <rapidjson/error/en.h>

Config::Config() : logsLevel_(logs.GetLevel()), server_(), schedule_(), cache_() {}

bool Config::Load(std::string const& filepath) {
  bool sucess = true;
  rapidjson::Document doc;
  std::ifstream ifs(filepath);
  if (!ifs) {
    sucess = false;
    LOGW << "Can't open: " << filepath << Log::Flags::End;
  } else {
    rapidjson::IStreamWrapper isw(ifs);
    if (doc.ParseStream(isw).HasParseError()) {
      sucess = false;
      LOGE << "Erreur JSON (offset "
          << doc.GetErrorOffset() << "): "
          << rapidjson::GetParseError_En(doc.GetParseError()) << Log::Flags::End;
      doc.SetObject();
    }
  }
  if (!doc.IsObject()) {
    if (sucess) {
      sucess = false;
      LOGE << "Bad JSON document " << filepath << Log::Flags::End;
    }
    doc.SetObject();
  }
  if (doc.HasMember("logs_level") && doc["logs_level"].IsUint()) {
    logsLevel_ = doc["logs_level"].GetUint();
  }
  server_.Load("server", doc);
  schedule_.Load("schedule", doc);
  cache_.Load("cache", doc);
  return sucess;
}

void Config::Save(std::string const& filepath) const {
  rapidjson::Document doc;
  doc.SetObject();
  rapidjson::MemoryPoolAllocator<>& alloc = doc.GetAllocator();
  doc.AddMember("logs_level", logsLevel_, alloc);
  server_.Save("server", doc, alloc);
  schedule_.Save("schedule", doc, alloc);
  cache_.Save("cache", doc, alloc);
  std::ofstream ofs(filepath);
  if (!ofs) {
    LOGE << "Can't open for writing: " << filepath << Log::Flags::End;
    return;
  }
  rapidjson::OStreamWrapper osw(ofs);
  rapidjson::PrettyWriter<rapidjson::OStreamWrapper> writer(osw);
  writer.SetIndent(' ', 2);
  doc.Accept(writer);
}

void Config::Validate(bool forceInstall) {
  server_.Validate(forceInstall);
  schedule_.Validate(forceInstall);
  cache_.Validate();
  logs.SetLevel(logsLevel_);
}
