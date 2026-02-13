#include "index.hxx"
#include "../../utils/rapidjson.hxx"
#include <iostream>
#include <fstream>
#include <rapidjson/document.h>
#include <rapidjson/istreamwrapper.h>
#include <rapidjson/ostreamwrapper.h>
#include <rapidjson/prettywriter.h>
#include <rapidjson/error/en.h>

ns_Publish::Index::Index()
{}

bool ns_Publish::Index::Load(std::string const& filename) {
  entries_.clear();

  rapidjson::Document doc;

  bool success = true;
  std::ifstream ifs(filename);
  if (!ifs) {
    success = false;
    std::cerr << "Can't open: " << filename << "\n";
  } else {
    rapidjson::IStreamWrapper isw(ifs);
    if (doc.ParseStream(isw).HasParseError()) {
      success = false;
      std::cerr << "Erreur JSON (offset "
          << doc.GetErrorOffset() << "): "
          << rapidjson::GetParseError_En(doc.GetParseError()) << "\n";
      doc.SetObject();
    }
  }
  if (!doc.IsObject()) {
    if (success) {
      success = false;
      std::cerr << "Bad JSON document " << filename << "\n";
    }
    doc.SetObject();
  }

  /*{
    "commitID": [ 
        { "file": xxx, "libs": [ "1", "2" ] } 
    ],
    ...
  }*/
  for (auto it=doc.MemberBegin(); it!=doc.MemberEnd(); ++it) {
    if ((!it->name.IsString()) || (!it->value.IsArray())) {
      continue;
    }
    std::string key = it->name.GetString();
    std::vector<struct sEntryInfos> entry;
    for (auto itHistory=it->value.Begin(); itHistory!=it->value.End(); ++itHistory) {
      rapidjson::Value const& historyElt = *itHistory;
      if ((!historyElt.HasMember("file")) || (!historyElt["file"].IsString()) || 
          (!historyElt.HasMember("libs")) || (!historyElt["libs"].IsArray())) {
        continue;
      }
      struct sEntryInfos infos;
      infos.srcFile = historyElt["file"].GetString();
      for (auto itLib=historyElt["libs"].Begin(); itLib!=historyElt["libs"].End(); ++itLib) {
        if (!itLib->IsString()) {
          continue;
        }
        infos.libsName.insert(itLib->GetString());
      }
      entry.push_back(infos);
    }
    entries_.emplace(key, entry );
  }

  return success;
}

bool ns_Publish::Index::Save(std::string const& filename) const {
  rapidjson::Document doc;
  doc.SetObject();
  rapidjson::MemoryPoolAllocator<>& alloc = doc.GetAllocator();
  std::string const tmpFilename = filename + ".tmp";
  std::ofstream ofs(tmpFilename);
  if (!ofs) {
    std::cerr << "Can't open for writing: " << tmpFilename << "\n";
    return false;
  }

  for(auto const& [key, entries]: entries_) {
    rapidjson::Value history(rapidjson::kArrayType);
    for(struct sEntryInfos const& entry: entries) {
      rapidjson::Value infos(rapidjson::kObjectType);
      rapidjson::Value libs(rapidjson::kArrayType);
      for(std::string const& libName: entry.libsName) {
        libs.PushBack(rapidjson::Value(libName.c_str(), alloc), alloc);
      }
      infos.AddMember("libs", libs, alloc);
      infos.AddMember("file", rapidjson::Value(entry.srcFile.c_str(), alloc), alloc);
      history.PushBack(infos, alloc);
    }
    doc.AddMember(rapidjson::Value(key.c_str(), alloc), history, alloc);
  }

  rapidjson::OStreamWrapper osw(ofs);
  rapidjson::PrettyWriter<rapidjson::OStreamWrapper> writer(osw);
  writer.SetIndent(' ', 2);
  if (doc.Accept(writer)) {
    std::error_code ec;
    std::filesystem::rename(tmpFilename, filename, ec);
  }

  return true;
}

bool ns_Publish::Index::Add(std::string const& key, std::string const& file, 
    std::unordered_set<std::string> const& libsManaged) {
  auto it = entries_.find(key);
  if (it == entries_.end()) {
    entries_.emplace(key, std::vector<sEntryInfos>{ { file, libsManaged } } );
  } else {
    std::vector<struct ns_Publish::Index::sEntryInfos>& infos = it->second;
    infos.push_back({ file, libsManaged });
  }
  return true;
}

bool ns_Publish::Index::Have(std::filesystem::path const& projectPath, std::string const& key) const {
  for(auto const& [commitFile, entries]: entries_) {
    for(auto const& entry: entries) {
      if (entry.srcFile == key) {
        return std::filesystem::exists(projectPath / commitFile);
      }
    }
  }
  return false;
}