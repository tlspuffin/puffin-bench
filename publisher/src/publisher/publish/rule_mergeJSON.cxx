#include "rule_mergeJSON.hxx"
#include "zst/generate_perf_zst.hxx"
#include "../../utils/logs.hxx"
#include "../../utils/file_compressed.hxx"
#include "../../utils/rapidjson.hxx"
#include "../../utils/variables.hxx"

static bool Greater(uint64_t a, uint64_t b) {
  return a > b;
}

static bool GreaterOrEqual(uint64_t a, uint64_t b) {
  return a >= b;
}

static bool Equal(uint64_t a, uint64_t b) {
  return a == b;
}

static bool Different(uint64_t a, uint64_t b) {
  return a != b;
}

static bool Lesser(uint64_t a, uint64_t b) {
  return a < b;
}

static bool LesserOrEqual(uint64_t a, uint64_t b) {
  return a <= b;
}

ns_Publish::RuleMergeJSON::RuleMergeJSON(std::string const& name, std::string const& rulePath, 
    std::string const& ruleRelativePath, std::string const& filesFilter, 
    rapidjson::Value const& parameters) 
  : Rule(name, rulePath, ruleRelativePath, filesFilter), src_(), dst_(), keep_(), firstMerge_(), 
  merge_(), strategyComparator_(nullptr), strategyField_(), generateZST_(false)
{
  static rapidjson::Value const emptyArray(rapidjson::kArrayType);
  static rapidjson::Value const emptyObject(rapidjson::kObjectType);
  src_ = GetOrDefault<std::string>(parameters, "src", "");
  dst_ = GetOrDefault<std::string>(parameters, "dst", "");
  rapidjson::Value const& merge = GetOrDefault<rapidjson::Value const&>(parameters, "merge", emptyArray);
  rapidjson::Value const& strategy = GetOrDefault<rapidjson::Value const&>(parameters, "strategy", emptyObject);
  if (src_.empty() || dst_.empty() || merge.Empty() || strategy.ObjectEmpty()) {
    throw std::runtime_error("Error in RuleMergeJSON, missing required parameters");
  }
  std::string strategyComparator = GetOrDefault<std::string>(strategy, "comparator", "");

  if (strategyComparator == ">=") strategyComparator_ = GreaterOrEqual;
  else if (strategyComparator == ">") strategyComparator_ = Greater;
  else if (strategyComparator == "<") strategyComparator_ = Lesser;
  else if (strategyComparator == "<=") strategyComparator_ = LesserOrEqual;
  else if (strategyComparator == "==") strategyComparator_ = Equal;
  else if (strategyComparator == "!=") strategyComparator_ = Different;
  strategyField_ = GetOrDefault<std::string>(strategy, "field", "");
  if ((strategyComparator_ == nullptr) || strategyField_.empty()) {
    throw std::runtime_error("Error in RuleMergeJSON, missing strategy required fields");
  }

  firstMerge_ = merge[0].GetString();
  merge_.insert(firstMerge_);
  for(size_t i=1; i<merge.Size(); ++i) {
    merge_.insert(merge[i].GetString());
  }

  rapidjson::Value const& keep = GetOrDefault<rapidjson::Value const&>(parameters, "keep", emptyArray);
  for(size_t i=0; i<keep.Size(); ++i) {
    if (!keep[i].IsString()) {
      throw std::runtime_error("Error in RuleMergeJSON, in keep, element " + std::to_string(i) + " is not a string");
    }
    std::string key = keep[i].GetString();
    if (merge_.find(key) != merge_.end()) {
      throw std::runtime_error("Error in RuleMergeJSON, field '" + key + "' cannot be both in 'keep' and 'merge'");
    }
    keep_.insert(key);
  }

  generateZST_ = GetOrDefault<bool>(parameters, "generate_ZST", false);
  SetCampaignStatus(GetOrDefault<bool>(parameters, "campaign", false));
}

bool ns_Publish::RuleMergeJSON::Apply(std::string const& file, std::filesystem::path const& outPath, 
      uint64_t& timestamp, std::string& outFile, std::unordered_set<std::string>& libsManaged, 
      bool generateArtefact) {
  std::string taskID;
  try {
    taskID = std::filesystem::path(file).stem();
    timestamp = std::stoull(taskID);
  } catch(...) {
    LOGE << "Unable to get timestamp from filename " << file << Log::Flags::End;
    return false;
  }

  try {
    std::unordered_map<std::string, std::string> variables;
    std::filesystem::path relativePath = std::filesystem::path(file).lexically_relative(rulePath_);
    size_t pathIndex = 0;
    for (auto const& element : relativePath) {
      variables.emplace("FILE_RELATIVE_PATH_" + std::to_string(pathIndex), element);
      ++pathIndex;
    }
    variables.emplace("FILENAME", relativePath.stem());
    std::string src = std::filesystem::path(ResolveVariables(src_, variables)).lexically_normal();
    std::string dst = std::filesystem::path(ResolveVariables(dst_, variables)).lexically_normal();

    FileCompressed srcArchive(file);
    uint64_t fileSize = 0;
    int64_t readSize = -1;
    std::string buffer;  
    srcArchive.ExtractFileData(src, 0, nullptr, &fileSize);
    if (fileSize > 0) {
      buffer.resize(fileSize);
      readSize = srcArchive.ExtractFileData(src, fileSize, buffer.data(), nullptr);
    }
    srcArchive.StopExtractFileData();
    if (readSize != fileSize) {
      throw std::runtime_error("unable to read the src full json file");
    }
    rapidjson::Document docSrc;
    docSrc.Parse(buffer.c_str());
    if (docSrc.HasParseError()) {
      throw std::runtime_error("the src json file have parse error");
    }
    uint64_t strategySrcValue = Get<uint64_t>(docSrc, strategyField_.c_str());

    for (std::string const& key: keep_) {
      if (docSrc.FindMember(key.c_str()) == docSrc.MemberEnd()) {
        throw std::runtime_error("the src json miss required field " + key);
      }
    }

    std::unordered_map<std::string, std::unordered_set<std::string>> mergedElementDst;
    std::unordered_map<std::string, std::unordered_set<std::string>> mergedElementSrc;
    ListMergedKeys(docSrc, mergedElementSrc);

    std::unordered_map<std::string, std::unordered_set<std::string>> toMerge;
    rapidjson::Document docDst;
    rapidjson::MemoryPoolAllocator<>& alloc = docDst.GetAllocator();
    bool requireMerge = ReadJSONFile(outPath/dst, docDst);
    if (requireMerge) {
      rapidjson::Value::ConstObject dataField = Get<rapidjson::Value::ConstObject>(docDst, "data");
      rapidjson::Value::ConstObject indexField = Get<rapidjson::Value::ConstObject>(docDst, "index");
      rapidjson::Value::ConstArray files = Get<rapidjson::Value::ConstArray>(indexField, "files");
      rapidjson::Value::ConstObject references = Get<rapidjson::Value::ConstObject>(indexField, "references");
      if (files.Empty() || references.ObjectEmpty()) {
        throw std::runtime_error("the dst json index has empty files or references");
      }

      for (auto const& [key, keyValues] : mergedElementSrc) {
        auto const& itKey = references.FindMember(key.c_str());
        if (itKey == references.MemberEnd()) {
          throw std::runtime_error("the dst json index is missing references for merged key '" + key + "'");
        }
        for (std::string const& value : keyValues) {
          auto const& it = itKey->value.FindMember(value.c_str());
          bool mergeThisValue = true;
          if (it != itKey->value.MemberEnd()) {
            if (!it->value.IsUint64()) {
              throw std::runtime_error("the dst json reference for '" + key + "." + value + "' is not a valid file index");
            }
            uint64_t index = it->value.GetUint64();
            if (index >= files.Size()) {
              throw std::runtime_error("the dst json reference for '" + key + "." + value + "' points to an out-of-range file index");
            }
            auto const& itMergeField = files[index].FindMember("merge_field");
            if (itMergeField == files[index].MemberEnd() || (!itMergeField->value.IsUint64())) {
              throw std::runtime_error("the dst json file entry " + std::to_string(index) + " has a missing or invalid 'merge_field'");
            }
            mergeThisValue = strategyComparator_(strategySrcValue, itMergeField->value.GetUint64());
          }
          if (mergeThisValue) {
            toMerge[key].insert(value);
          }
        }
      }

      for (std::string const& key: keep_) {
        auto const& fieldSrc = docSrc.FindMember(key.c_str());
        auto const& fieldDst = dataField.FindMember(key.c_str());
        if ((fieldSrc == docSrc.MemberEnd()) || (fieldDst == dataField.MemberEnd()) || 
            (fieldSrc->value != fieldDst->value)) {
          throw std::runtime_error("the src json field '" + key + "' is missing or does not match the value already stored in dst");
        }
      }
      ListMergedKeys(dataField, mergedElementDst);
    } else {
      docDst.SetObject();

      for (auto const& [key, keyValues] : mergedElementSrc) {
        for (std::string const& value : keyValues) {
          toMerge[key].insert(value);
        }
      }

      rapidjson::Value data(rapidjson::kObjectType);
      for (std::string const& key: keep_) {
        data.AddMember(rapidjson::Value(key.c_str(), alloc), docSrc.FindMember(key.c_str())->value, alloc);
      }
      for (std::string const& key: merge_) {
        rapidjson::Value newKey(rapidjson::kObjectType);
        data.AddMember(rapidjson::Value(key.c_str(), alloc), newKey, alloc);
      }
      docDst.AddMember("data", data, alloc);

      rapidjson::Value index(rapidjson::kObjectType);
      index.AddMember("files", rapidjson::Value(rapidjson::kArrayType), alloc);
      rapidjson::Value references(rapidjson::kObjectType);
      for (std::string const& key: merge_) {
        references.AddMember(rapidjson::Value(key.c_str(), alloc), rapidjson::Value(rapidjson::kObjectType), alloc);
      }
      index.AddMember("references", references, alloc);
      docDst.AddMember("index", index, alloc);
    }

    if (requireMerge && toMerge.empty()) {
      libsManaged.clear();
      outFile = dst;
      return true;
    }

    auto& data = docDst.FindMember("data")->value;
    for (auto const& [key, selectedFields]: toMerge) {
      rapidjson::Value::Object values = data.FindMember(key.c_str())->value.GetObject();
      rapidjson::Value& dataSrc = docSrc[key.c_str()];
      std::unordered_set<std::string> const* mergedElementDstFields = nullptr;
      auto const& itObj = mergedElementDst.find(key);
      if (itObj != mergedElementDst.end()) {
        mergedElementDstFields = &(itObj->second);
      }
      for (std::string const& field: selectedFields) {
        if ((mergedElementDstFields != nullptr) && (mergedElementDstFields->find(field) != mergedElementDstFields->end())) {
          values[field.c_str()] = dataSrc[field.c_str()];
        } else {
          values.AddMember(rapidjson::Value(field.c_str(), alloc), dataSrc[field.c_str()], alloc);
        }
      }
    }

    auto& index = docDst.FindMember("index")->value;
    auto& files = index.FindMember("files")->value;
    uint64_t lastFiles = files.Size();
    for (uint64_t i=0; i<files.Size(); ++i) {
      if (file == Get<std::string>(files[i], "file")) {
        lastFiles = i;
        break;
      }
    }
    if (lastFiles == files.Size()) {
      rapidjson::Value fileElement(rapidjson::kObjectType);
      fileElement.AddMember("file", rapidjson::Value(file.c_str(), alloc), alloc);
      fileElement.AddMember("task_id", rapidjson::Value(taskID.c_str(), alloc), alloc);
      fileElement.AddMember("merge_field", strategySrcValue, alloc);
      files.PushBack(fileElement, alloc);
    }

    auto& reference = index.FindMember("references")->value;
    for (auto const& [key, selectedFields] : toMerge) {
      auto& keyValue = reference.FindMember(key.c_str())->value;
      for (std::string const& field: selectedFields) {
        auto it = keyValue.FindMember(field.c_str());
        if (it == keyValue.MemberEnd()) {
          keyValue.AddMember(rapidjson::Value(field.c_str(), alloc), rapidjson::Value(lastFiles), alloc);
        } else {
          it->value = rapidjson::Value(lastFiles);
        }
      }
    }

    std::string fullOutPath = outPath / dst;
    std::string fullOutDir = std::filesystem::path(fullOutPath).parent_path();
    std::error_code ec;
    std::filesystem::create_directories(fullOutDir, ec);
    if (ec) {
      throw std::runtime_error("Unable to create directories " + fullOutDir);
    }
    if (!SaveJSONFile(fullOutPath + ".tmp", docDst, true)) {
      throw std::runtime_error("Unable to save " + fullOutPath + ".tmp");
    }

    if (generateZST_ && generateArtefact) {
      std::filesystem::path zstdFile = file;
      zstdFile.replace_extension(".zst");
      if (!ns_Analyze::Generate_Perf_ZST(file, zstdFile, "")) {
        std::error_code ec;
        std::filesystem::remove(fullOutPath + ".tmp", ec);
        throw std::runtime_error("Unable to move " + fullOutPath + ".tmp to " + fullOutPath);
      }
    }

    std::filesystem::rename(fullOutPath + ".tmp", fullOutPath, ec);
    if (ec) {
      std::filesystem::remove(fullOutPath + ".tmp", ec);
      throw std::runtime_error("Unable to move " + fullOutPath + ".tmp to " + fullOutPath);
    }
    libsManaged = toMerge[firstMerge_];
    outFile = dst;
    return true;
  } catch(std::runtime_error const& e) {
    LOGE << "RuleMergeJSON::Apply on " << file << ", error: " << e.what() << Log::Flags::End;
  } catch(...) {
    LOGE << "RuleMergeJSON::Apply on " << file << ", error: unknown" << Log::Flags::End;
  }

  return false;
}

template<typename T>
void ns_Publish::RuleMergeJSON::ListMergedKeys(T const& doc, 
    std::unordered_map<std::string, std::unordered_set<std::string>>& result) {
  result.clear();
  for(std::string const& key : merge_) {
    rapidjson::Value::ConstObject keyValues = Get<rapidjson::Value::ConstObject>(doc, key.c_str());
    for(auto it=keyValues.MemberBegin(); it!=keyValues.MemberEnd(); ++it) {
      result[key].insert(it->name.GetString());
    }
  }
}
