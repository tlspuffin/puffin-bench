#include "index.hxx"
#include "../../utils/rapidjson.hxx"
#include <iostream>
#include <fstream>
#include <rapidjson/document.h>
#include <rapidjson/istreamwrapper.h>
#include <rapidjson/ostreamwrapper.h>
#include <rapidjson/prettywriter.h>
#include <rapidjson/error/en.h>

ns_Publish::Index::Index(ns_Publish::Index&& other) 
    : path_(other.path_), entries_(std::move(other.entries_))
{}

ns_Publish::Index::Index(std::filesystem::path const& path) : path_(path)
{}

bool ns_Publish::Index::Load(std::filesystem::path filename) {
  std::lock_guard lock(lock_);
  entries_.clear();

  filename = path_ / filename;
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
    "resultFile(commitID)": {
      "Timestamp": {
          "file": [ XXXX ]
          "libs": [ "1", "2" ]
      }
    }
    ...
  }*/
  for (auto it=doc.MemberBegin(); it!=doc.MemberEnd(); ++it) {
    if ((!it->name.IsString()) || (!it->value.IsObject())) {
      continue;
    }
    std::string cacheEntryFile = it->name.GetString();
    auto const& timestampObjects = it->value;

    std::map<uint64_t, sEntryInfos> entry;
    for (auto itTS=timestampObjects.MemberBegin(); itTS!=timestampObjects.MemberEnd(); ++itTS) {
      if ((!itTS->name.IsString()) || (!itTS->value.IsObject())) {
        continue;
      }
      uint64_t timestamp = 0;
      try {
        timestamp = std::stoull(itTS->name.GetString());
      } catch(...) {
        continue;
      }
      auto const& entryInfos = itTS->value;
      if ((!entryInfos.HasMember("file")) || (!entryInfos["file"].IsString()) || 
          (!entryInfos.HasMember("libs")) || (!entryInfos["libs"].IsArray())) {
        continue;
      }
      sEntryInfos infos;
      infos.srcFiles = entryInfos["file"].GetString();
      for (auto itLib=entryInfos["libs"].Begin(); itLib!=entryInfos["libs"].End(); ++itLib) {
        if (!itLib->IsString()) {
          continue;
        }
        infos.libsName.insert(itLib->GetString());
      }
      entry.emplace(timestamp, std::move(infos));
    }
    entries_.emplace(std::move(cacheEntryFile), std::move(entry));
  }

  return success;
}

bool ns_Publish::Index::Save(std::filesystem::path filename) {
  std::shared_lock lock(lock_);
  filename = path_ / filename;
  rapidjson::Document doc;
  doc.SetObject();
  rapidjson::MemoryPoolAllocator<>& alloc = doc.GetAllocator();
  std::string const tmpFilename = filename.string() + ".tmp";
  std::ofstream ofs(tmpFilename);
  if (!ofs) {
    std::cerr << "Can't open for writing: " << tmpFilename << "\n";
    return false;
  }

  for(auto const& [cachedFile, timestamps]: entries_) {
    rapidjson::Value cachedFileJSON(rapidjson::kObjectType);
    for(auto const& [timestamp, infos]: timestamps) {
      rapidjson::Value infosJSON(rapidjson::kObjectType);
      infosJSON.AddMember("file", rapidjson::Value(infos.srcFiles.c_str(), alloc), alloc);
      rapidjson::Value libs(rapidjson::kArrayType);
      for(std::string const& libName: infos.libsName) {
        libs.PushBack(rapidjson::Value(libName.c_str(), alloc), alloc);
      }
      infosJSON.AddMember("libs", libs, alloc);    
      cachedFileJSON.AddMember(rapidjson::Value(std::to_string(timestamp).c_str(), alloc), infosJSON, alloc);
    }
    doc.AddMember(rapidjson::Value(cachedFile.c_str(), alloc), cachedFileJSON, alloc);
  }

  rapidjson::OStreamWrapper osw(ofs);
  rapidjson::PrettyWriter<rapidjson::OStreamWrapper> writer(osw);
  writer.SetIndent(' ', 2);
  bool saveOk = doc.Accept(writer);
  ofs.close();
  if (saveOk) {
    std::error_code ec;
    std::filesystem::rename(tmpFilename, filename, ec);
  }

  return true;
}

bool ns_Publish::Index::Add(std::string const& key, uint64_t timestamp, std::string const& file, 
    std::unordered_set<std::string>& libsManaged) {
  std::lock_guard lock(lock_);
  auto it = entries_.find(key);
  if (it == entries_.end()) {
    entries_.emplace(key, std::map<uint64_t, struct sEntryInfos>{{timestamp, { file, libsManaged }}});
  } else {
    std::map<uint64_t, struct sEntryInfos>& timestamps = it->second;
    for(auto& [timestampKey, infos]: timestamps) {
      if (timestampKey < timestamp) {
        for(auto const& lib: libsManaged) {
          infos.libsName.erase(lib);
        }
      } else if (timestampKey > timestamp) {
        for(auto const& lib: infos.libsName) {
          libsManaged.erase(lib);
        }
      }
    }
    if (libsManaged.empty()) {
      timestamps.emplace(timestamp, sEntryInfos{file, {}});
      return true;
    }

    auto it = timestamps.find(timestamp);
    if (it == timestamps.end()) {
      auto const& [_, result] = timestamps.emplace(timestamp, sEntryInfos{file, libsManaged});
      if (!result) {
        throw std::runtime_error("Fatal error map emplace failed");
      }
    } else {
      it->second = sEntryInfos{file, libsManaged};
    }
  }

  return true;
}

bool ns_Publish::Index::HaveCachedJSON(std::string const& key) {
  std::shared_lock lock(lock_);
  for(auto const& [commitID, timestamps]: entries_) {
    for(auto const& [timestamps, entry]: timestamps) {
      if (entry.srcFiles == key) {
        return std::filesystem::exists(path_ / commitID);
      }
    }
  }
  return false;
}

bool ns_Publish::Index::HaveIndexed(std::string const& key) {
  std::shared_lock lock(lock_);
  for(auto const& [_, timestamps]: entries_) {
    for(auto const& [timestamps, entry]: timestamps) {
      if (entry.srcFiles == key) {
        return std::filesystem::exists(path_ / entry.srcFiles);
      }
    }
  }
  return false;
}

std::vector<std::string> ns_Publish::Index::List() {
  std::shared_lock lock(lock_);
  std::vector<std::string> result;
  for(auto const& [commitID, _]: entries_) {
    result.push_back(commitID);
  }
  return result;
}