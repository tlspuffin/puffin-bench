#include "config.hxx"
#include "utils/rapidjson.hxx"

#include <fstream>
#include <iostream>
#include <rapidjson/document.h>
#include <rapidjson/istreamwrapper.h>
#include <rapidjson/prettywriter.h>
#include <rapidjson/ostreamwrapper.h>
#include <rapidjson/error/error.h>
#include <rapidjson/error/en.h>

bool Config::Load(std::string const& filepath) {
  bool sucess = true;
  rapidjson::Document doc;
  std::ifstream ifs(filepath);
  if (!ifs) {
    sucess = false;
    std::cerr << "Can't open: " << filepath << "\n";
  } else {
    rapidjson::IStreamWrapper isw(ifs);
    if (doc.ParseStream(isw).HasParseError()) {
      sucess = false;
      std::cerr << "Erreur JSON (offset "
          << doc.GetErrorOffset() << "): "
          << rapidjson::GetParseError_En(doc.GetParseError()) << "\n";
      doc.SetObject();
    }
  }
  if (!doc.IsObject()) {
    if (sucess) {
      sucess = false;
      std::cerr << "Bad JSON document " << filepath << "\n";
    }
    doc.SetObject();
  }
  server_.Load("server", doc);
  cache_.Load("cache", doc);
  return sucess;
}

void Config::Save(std::string const& filepath) const {
  rapidjson::Document doc;
  doc.SetObject();
  rapidjson::MemoryPoolAllocator<>& alloc = doc.GetAllocator();
  server_.Save("server", doc, alloc);
  cache_.Save("cache", doc, alloc);
  std::ofstream ofs(filepath);
  if (!ofs) {
    std::cerr << "Can't open for writing: " << filepath << "\n";
    return;
  }
  rapidjson::OStreamWrapper osw(ofs);
  rapidjson::PrettyWriter<rapidjson::OStreamWrapper> writer(osw);
  writer.SetIndent(' ', 2);
  doc.Accept(writer);
}

void Config::Validate() {
  server_.Validate();
  cache_.Validate();
}
