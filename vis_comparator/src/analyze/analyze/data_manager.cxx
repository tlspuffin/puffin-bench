#include "data_manager.hxx"
#include "../../utils/file_tgz.hxx"
#include "../../utils/compress_tar_zst.hxx"
#include "../../utils/rapidjson.hxx"
#include "../../utils/logs.hxx"
#include <vector>
#include <fstream>
#include <regex>
#include "rapidjson/document.h"
#include "rapidjson/istreamwrapper.h"

static std::regex const reIsNumber("^[0-9]+$");
static std::regex const reRunKeyFiles("^(?:.*/)?(logs/.+|artefacts/(?:[^/]+/)*[0-9]+-(?:stats\\.json|README\\.md))$");
static std::regex const reStats("^((?:.*/)?(artefacts/(?:[^/]+/)*([0-9]+))-stats\\.json)$");
static std::regex const reTypePerf("^Perf.*$");
static std::regex const reTypeVuln("^Vuln.*$");

ns_Analyze::DataManager::DataType StringToDataType(std::string const& type) {
  if (type == "int32") {
    return ns_Analyze::DataManager::DataType::INT32;
  } else if (type == "uint32") {
    return ns_Analyze::DataManager::DataType::UINT32;
  } else if (type == "int64") {
    return ns_Analyze::DataManager::DataType::INT64;
  } else if (type == "uint64") {
    return ns_Analyze::DataManager::DataType::UINT64;
  } else if (type == "double") {
    return ns_Analyze::DataManager::DataType::DOUBLE;
  } else {
    throw std::runtime_error("Unknown DataType " + type);
  }
}

size_t DataTypeToDataSize(ns_Analyze::DataManager::DataType type) {
  switch ((type)) {
    case ns_Analyze::DataManager::DataType::INT32:
      return sizeof(int32_t);
    case ns_Analyze::DataManager::DataType::UINT32:
      return sizeof(uint32_t);
    case ns_Analyze::DataManager::DataType::INT64:
      return sizeof(int64_t);
    case ns_Analyze::DataManager::DataType::UINT64:
      return sizeof(uint64_t);
    case ns_Analyze::DataManager::DataType::DOUBLE:
      return sizeof(double);
    default:
      throw std::runtime_error("Unknown DataType");
  }
}

std::string DataTypeToString(ns_Analyze::DataManager::DataType type) {
  switch ((type)) {
    case ns_Analyze::DataManager::DataType::INT32:
      return "INT32";
    case ns_Analyze::DataManager::DataType::UINT32:
      return "UINT32";
    case ns_Analyze::DataManager::DataType::INT64:
      return "INT64";
    case ns_Analyze::DataManager::DataType::UINT64:
      return "UINT64";
    case ns_Analyze::DataManager::DataType::DOUBLE:
      return "DOUBLE";
    default:
      throw std::runtime_error("Unknown DataType");
  }
}

struct ns_Analyze::DataManager::SMetricsSummary MetricsSummatries(uint64_t id, std::string const& metadataJSON) {
  struct ns_Analyze::DataManager::SMetricsSummary results {0};

  rapidjson::Document doc;
  doc.Parse(metadataJSON.c_str());
  if (doc.HasParseError()) {
    throw std::runtime_error("Wrongly formatted JSON: " + metadataJSON);
  }

  results.id_ = id;
  results.nbClient_ = Get<uint64_t>(doc, "nb_client");
  results.runTime_ = Get<uint64_t>(doc, "run_time");

  results.summary_.resize(results.nbClient_+1); // 0 global 1...N clients

  if ((!doc.HasMember("series")) || (!doc["series"].IsObject())) {
    throw std::runtime_error("JSON data missing series array");
  }
  std::stack<std::pair<const rapidjson::Value*, std::string>> stack;
  rapidjson::Value const& value = doc["series"].GetObject();
  stack.push({&value, ""});
  while(!stack.empty()) {
    auto [current, path] = stack.top();
    stack.pop();
    for (auto it = current->MemberBegin(); it != current->MemberEnd(); ++it) {
      std::string fieldName = it->name.GetString();
      std::string fullName = path.empty() ? fieldName : path + "." + fieldName;
      const rapidjson::Value& value = it->value;
      if (value.IsObject() && (!value.HasMember("type"))) {
        stack.push({&value, fullName});
      } else {
        struct ns_Analyze::DataManager::SMetricInfos infos;
        infos.name_ = fieldName;
        infos.type_ = StringToDataType(Get<std::string>(value, "type"));
        infos.nbElement_ = Get<uint64_t>(value, "count");
        infos.file_ = Get<std::string>(value, "file");

        size_t prefixPos = fullName.find('.');
        if (prefixPos == std::string::npos) {
          throw std::runtime_error("Wrongly formatted name (no prefix): " + fullName);
        }
        std::string prefix = fullName.substr(0, prefixPos);
        std::string suffix = fullName.substr(prefixPos + 1);
        long index = 0;
        if (prefix != "global") {
          static std::regex reClientID("client_([0-9]+)");
          std::smatch match;
          if (!std::regex_match(prefix, match, reClientID)) {
            throw std::runtime_error("Wrongly formatted name (no index): " + fullName);
          }
          index = std::strtol(match[1].str().c_str(), nullptr, 10);
          if (index >= results.summary_.size()) {
            throw std::runtime_error("Wrongly formatted name (index invalid): " + fullName);
          }
        }
        results.summary_[index].emplace(suffix, infos);
      }
    }
  }

  /*std::unordered_set<std::string> clientsCommonData_;
  if (nbClient_ > 0) {
    for(auto const& [name, infos]: datasSummary_[1]) {
      bool found = true;
      for(int i=2; i<datasSummary_.size(); ++i) {
        if (datasSummary_[i].count(name) == 0) {
          found = false;
          break;
        }
      }
      if (found) {
        clientsCommonData_.insert(name);
      }
    }
  }*/

  return results;
}


ns_Analyze::DataManager::DataManager(Config const& config) : config_(config), rootpath_(config.dataPath_)
{
  std::vector<std::string> commits;
  for (auto const& entry : std::filesystem::recursive_directory_iterator(rootpath_)) {
    std::filesystem::path const& path = entry.path();
    std::string const taskID = path.stem();
    if ((!entry.is_regular_file()) || (path.extension() != ".json") ||
        (!std::regex_match(taskID, reIsNumber))) {
      continue;
    }

    std::filesystem::path relativePath = std::filesystem::relative(path, rootpath_);
    relativePath = relativePath.parent_path() / relativePath.stem();
    std::string const type = path.parent_path().stem();
    std::string const commitID = path.parent_path().parent_path().stem();
    std::string const filetgz = path.parent_path() / (taskID + ".tgz");
    if (!std::filesystem::exists(filetgz)) {
      continue;
    }
    runsResults_[type].emplace(commitID, std::move(relativePath));
  }

  std::smatch reMatches;

  std::vector<char> buffer(102400);
  for(auto const& [ type, commits ]: runsResults_) {
    for(auto const& [ commitID, taskPath ]: commits) {
      if (std::regex_match(type, reTypePerf)) {
        SummaryRunPerf(taskPath);
      } else if (std::regex_match(type, reTypeVuln)) {
        SummaryRunVuln(taskPath);
      }
    }
  }
}

std::vector<std::string> ns_Analyze::DataManager::Commits(std::string const& type) {
  if (runsResults_.count(type) == 0) {
    return {};
  }
  std::vector<std::string> result;
  result.reserve((runsResults_[type].size()));
  for(auto const& [ commitID, _ ]: runsResults_[type]) {
    result.push_back(commitID);
  }
  return result;
}

std::vector<std::pair<std::string, uint64_t>> 
    ns_Analyze::DataManager::CommitSubjects(
    std::string const& type, std::string const& commitID) {
  std::vector<std::pair<std::string, uint64_t>> result{};

  if ((runsResults_.count(type) == 0) || 
      (runsResults_[type].count(commitID) == 0)) {
    return result;
  }
  std::string binFilename = rootpath_ / (runsResults_[type][commitID].string() + ".tar.zst");
  FileTARZST archive(binFilename);
  std::vector<char> buffer;
  archive.ExtractFile("metadata.json", buffer);
  if (buffer.empty()) {
    throw std::runtime_error("metadata.json is empty");
  }
  rapidjson::Document doc;
  doc.Parse(buffer.data());
  if (doc.HasParseError()) {
    throw std::runtime_error("metadata.json is mal formatted");
  }
  for(auto val=doc.MemberBegin(); val!=doc.MemberEnd(); ++val) {
    result.push_back({val->name.GetString(), val->value.GetInt64()});
  }
  return result;
}

struct ns_Analyze::DataManager::SMetricsSummaries
ns_Analyze::DataManager::CommitMetrics(std::string const& type, std::string const& commitID, std::string const& subject) {
  struct SMetricsSummaries result {0};
  if ((runsResults_.count(type) == 0) || 
      (runsResults_[type].count(commitID) == 0)) {
    return result;
  }

  std::string binFilename = rootpath_ / (runsResults_[type][commitID].string() + ".tar.zst");
  FileTARZST archive(binFilename);
  std::vector<std::pair<std::string, uint64_t>> metadatasFilename = 
      archive.ListFiles(std::regex("^/*artefacts/"+subject+"/[^/]+/metadata.json$"));

  for(auto const& metadataFilename : metadatasFilename) {
    static std::regex reRunID(".*/([0-9]+)-stats.json.bin/.*");
    std::smatch match;
    if (!std::regex_search(metadataFilename.first, match, reRunID)) {
      LOGW("Ignoring folder "+metadataFilename.first);
      continue;
    }
    std::vector<char> buffer;
    archive.ExtractFile(metadataFilename.first, buffer);
    buffer.push_back(0);
    ns_Analyze::DataManager::SMetricsSummary metricsSummary = 
        MetricsSummatries(std::strtol(match[1].str().c_str(), nullptr, 10), buffer.data());
    ++result.nbRun_;
    result.runSummary_.push_back(metricsSummary);
  }

  return result;
}

std::unordered_map<std::string, std::vector<struct ns_Analyze::DataManager::SMetricValues>> 
ns_Analyze::DataManager::CommitValues(
    std::string const& type, std::string const& commitID, 
    std::string const& subject, uint64_t min, uint64_t max, 
    uint64_t step, std::vector<uint64_t>& runs,
    std::vector<uint64_t> const& clients,
    std::vector<std::string> const& metrics, std::string const& aggregate) {
  std::unordered_map<std::string, std::vector<struct ns_Analyze::DataManager::SMetricValues>> result;

  struct ns_Analyze::DataManager::SMetricsSummaries metricsSummaries = CommitMetrics(type, commitID, subject);

  std::unordered_map<uint64_t, uint64_t> runsIDMap;
  bool findRun = !runs.empty();
  for(uint64_t i=0; i<metricsSummaries.nbRun_; ++i) {
    uint64_t runID = metricsSummaries.runSummary_[i].id_;
    if (findRun) {
      bool notfound = true;
      for(uint64_t wantedRunID: runs) {
        if (wantedRunID == runID) {
          notfound = false;
          break;
        }
      }
      if (notfound) {
        continue;
      }
    } else {
      runs.push_back(runID);
    }
    runsIDMap.emplace(runID, i);
  }

  std::string binFilename = rootpath_ / (runsResults_[type][commitID].string() + ".tar.zst");
  FileTARZST archive(binFilename);

  std::vector<std::pair<std::string, uint64_t>> metadatasFilename = 
      archive.ListFiles(std::regex("^/*artefacts/"+subject+"/[0-9]+-stats.json.bin/$"));

  std::unordered_map<uint64_t, std::filesystem::path> runsFolders;
  for(auto const& metadataFilename : metadatasFilename) {
    static std::regex reRunID(".*/([0-9]+)-stats.json.bin/");
    std::smatch match;
    if (!std::regex_search(metadataFilename.first, match, reRunID)) {
      LOGW("Ignoring folder "+metadataFilename.first);
      continue;
    }
    uint64_t runID = std::strtol(match[1].str().c_str(), nullptr, 10);
    if ((runsIDMap.count(runID) == 0) || (runsIDMap[runID] == ~0)) {
      continue;
    }
    runsFolders.emplace(runID, metadataFilename.first);
  }

  uint64_t nbElement = ((max - min) + step - 1) / step;
  std::vector<char> sumValues(
      nbElement * (sizeof(double) > sizeof(uint64_t) ? sizeof(double) : sizeof(uint64_t)), 0);

  std::vector<std::vector<std::vector<struct ns_Analyze::DataManager::SInterpolations>>> 
      timestamps(metricsSummaries.nbRun_);
  for(auto const& [runID, _]: runsFolders) {
    timestamps[runID].resize(metricsSummaries.runSummary_[runsIDMap[runID]].nbClient_ + 1);
  }

  for(std::string metric: metrics) {
    std::string metricFullname = metric;
    bool clientsMetric = false;
    bool allClients = false;
    std::vector<uint64_t> indexes;
    if (metric.find("global.") == 0) {
      indexes.push_back(0);
      metric = metric.substr(7);
    } else {
      clientsMetric = true;
      allClients = clients.size() == 0;
      if (!allClients) {
        indexes = clients;
      }
      size_t suffixPos = metric.find(".");
      if (suffixPos == std::string::npos) {
        throw std::runtime_error("Mal formatted metric name: "+ metric);
      }
      metric = metric.substr(suffixPos+1);
    }
    std::vector<uint64_t> savedIndexes = indexes;
    for (uint64_t runID: runs) {
      bool doAggregate = (!aggregate.empty()) && clientsMetric;
      uint64_t runIndex = runsIDMap[runID];
      if (runIndex == ~0) {
        throw std::runtime_error("Unknown run ID: " + std::to_string(runID));
      }
      auto const& itRunFolder = runsFolders.find(runID);
      if (itRunFolder == runsFolders.end()) {
        throw std::runtime_error("No folder for run ID: "+ std::to_string(runID));
      }

      if (clientsMetric) {
        uint64_t nbClients = metricsSummaries.runSummary_[runIndex].nbClient_;
        if (allClients) {
          indexes.resize(nbClients);
          for(int i=1; i<=nbClients; ++i) {
            indexes[i-1] = i;
          }
        } else {
          indexes.resize(0);
          for(uint64_t index: savedIndexes) {
            if (index <= nbClients) {
              indexes.push_back(index);
            }
          }
        }
      }

      std::filesystem::path const& runFolder = itRunFolder->second;
      if (doAggregate) {
        memset(sumValues.data(), 0, sumValues.size());
      }
      DataType dataType = metricsSummaries.runSummary_[runIndex].summary_[clientsMetric ? 1 : 0][metric].type_;
      for(uint64_t index: indexes) {
        //LOGI(metric << " " << runIndex << " (" << metricsSummaries.runSummary_[runIndex].id_ << ") " << index);
        if (dataType != metricsSummaries.runSummary_[runIndex].summary_[index][metric].type_) {
          LOGE("Fatal request error, 2 diffrent kind of data for the same serie");
          return {};
        }
        if (timestamps[runID][index].empty()) {
          timestamps[runID][index] = ExtractDataTS(archive, runFolder, metricsSummaries.runSummary_[runIndex].summary_[index]["timestamp"], min, max, step);
        }
        std::string filename = runFolder / metricsSummaries.runSummary_[runIndex].summary_[index][metric].file_;

        switch(dataType) {
          case DataType::UINT64:
            if (doAggregate) {
              auto data = ExtractData<uint64_t>(archive, filename, timestamps[runID][index]);
              uint64_t* sum = (uint64_t*)sumValues.data();
              for (size_t i=0; i<data.size(); ++i) {
                sum[i] += data[i];
              }
            } else {
              result[metricFullname].push_back(
                  {runID, index, { ExtractData<uint64_t>(archive, filename, timestamps[runID][index]) }});
            }
            break;
          case DataType::DOUBLE:
            if (doAggregate) {
              auto data = ExtractData<double>(archive, filename, timestamps[runID][index]);
              double* sum = (double*)sumValues.data();
              for (size_t i=0; i<data.size(); ++i) {
                sum[i] += data[i];
              }
            } else {
              result[metricFullname].push_back(
                  {runID, index, { ExtractData<double>(archive, filename, timestamps[runID][index]) }});
            }
            break;
          default:
            LOGE("Fatal request error, serie of data have an unmanaged kind: "+ DataTypeToString(dataType));
            return {};
            break;
        }
      }
      if (doAggregate) {
        switch(dataType) {
          case DataType::UINT64: {
              uint64_t* sum = (uint64_t*)sumValues.data();
              result[metricFullname].push_back({runID, 0, { std::vector<uint64_t>(sum, sum + nbElement) }});
            }
            break;
          case DataType::DOUBLE: {
              double* sum = (double*)sumValues.data();
              result[metricFullname].push_back({runID, 0, { std::vector<double>(sum, sum + nbElement) }});
            }
            break;
          default:
            LOGE("Fatal request error, serie of data have an unmanaged kind: "+ DataTypeToString(dataType));
            return {};
            break;
        }
      }
    }
  }

  return result;
}

void ns_Analyze::DataManager::SummaryRunPerf(std::filesystem::path const& taskPath) {
  std::unordered_map<std::string, uint64_t> details;
  std::filesystem::path workingDir = taskPath.parent_path();
  std::string const& fileStem = taskPath.stem();

  std::string filebin = rootpath_ / workingDir / (fileStem + ".tar.zst");
  if (std::filesystem::exists(filebin)) {
    return;
  }

  std::string tempDir = rootpath_ / workingDir / "TMP";
  std::filesystem::create_directory(tempDir);

  std::string filetgz = rootpath_ / workingDir / (fileStem + ".tgz");
  FileTGZ tgz(filetgz);
  std::filesystem::path artefactsPath = "artefacts";
  std::smatch reMatches;
  auto const files = tgz.ListFiles(&reRunKeyFiles);
  for(auto const& [ file, _ ] : files) {
    std::regex_match(file, reMatches, reRunKeyFiles);
    std::filesystem::path dstFile(reMatches[1]);
    std::string uncompressedFilePath = tempDir / dstFile.parent_path();
    std::filesystem::create_directories(uncompressedFilePath);
    std::string uncompressedFile = tempDir / dstFile;
    tgz.ExtractFile(file, uncompressedFile);
    if (!std::regex_match(file, reMatches, reStats)) {
      continue;
    }

    ++details[dstFile.parent_path().filename()];

    //std::string command = "/home/olivier/Desktop/restsrv_analyse.only/build/analyze_results --path " + artefactTempPath;
    std::string command = config_.analyzeTools_.string() + " --path " + uncompressedFilePath;
    system(command.c_str());
    std::filesystem::remove(uncompressedFile);
  }
  tgz.StopExtractFileData();

  std::ofstream ofs(tempDir+"/metadata.json");
  if (!ofs.is_open()) {
    throw std::runtime_error("Unable to create file " + tempDir + "/metadata.json");
  }
  ofs << "{\n";
  bool notFirst = false;
  for (auto const& [ name, count ] : details) {
    if (notFirst)  {
      ofs << ",\n";
    }
    notFirst = true;
    ofs << "\"" << name << "\":" << count;
  }
  ofs << "\n}";
  ofs.close();
  try {
    CompressTARZSTD(tempDir, filebin, true, 4*1024*1024, 10);
  } catch(std::exception const& e) {
    LOGE("Failed to compress " << filebin << ": " << e.what());
    std::error_code ec;
    std::filesystem::remove(filebin, ec);
  } catch(...) {
    LOGE("Failed to compress " << filebin << ": unknown error");
    std::error_code ec;
    std::filesystem::remove(filebin, ec);
  }

  std::filesystem::remove_all(tempDir);
}

void ns_Analyze::DataManager::SummaryRunVuln(std::filesystem::path const& taskPath) {
  std::unordered_map<std::string, uint64_t> details;
  std::filesystem::path workingDir = taskPath.parent_path();
  std::string const& fileStem = taskPath.stem();

  std::string filebin = rootpath_ / workingDir / (fileStem + ".tar.zst");
  if (std::filesystem::exists(filebin)) {
    return;
  }

  std::string tempDir = rootpath_ / workingDir / "TMP";
  std::filesystem::create_directory(tempDir);

  std::string filetgz = rootpath_ / workingDir / (fileStem + ".tgz");
  FileTGZ tgz(filetgz);

  std::filesystem::path artefactsPath = "artefacts";
  auto const files = tgz.ListFiles(&reRunKeyFiles);
  std::smatch reMatches;
  for(auto const& [ file, _ ] : files) {
    std::regex_match(file, reMatches, reRunKeyFiles);
    std::filesystem::path dstFile(reMatches[1]);
    std::filesystem::create_directories(tempDir / dstFile.parent_path());
    std::string uncompressedFile = tempDir / dstFile;
    tgz.ExtractFile(file, uncompressedFile);
    if (!std::regex_match(file, reMatches, reStats)) {
      continue;
    }

    ++details[dstFile.parent_path().filename()];

    std::ifstream jsonFile(uncompressedFile);
    if (!jsonFile.is_open()) {
      LOGE("Can not open " << uncompressedFile);
    }
    std::cout << "Parsing " << uncompressedFile << std::endl;
    rapidjson::IStreamWrapper isw(jsonFile);
    while (true) {
      rapidjson::Document doc;
      doc.ParseStream<rapidjson::kParseStopWhenDoneFlag>(isw);
      if (doc.HasParseError()) {
        LOGE("json parse error in " << uncompressedFile);
        break;
      }
      std::string type = Get<std::string>(doc, "type");
      if (type != "global") {
        continue;
      }
      uint64_t objectifSize = Get<uint64_t>(doc, "objective_size");
      if (objectifSize > 0) {
        continue;
      }
      std::filesystem::path errorFile = std::filesystem::path(reMatches[2].str() + "-log") / "error.log";
      uncompressedFile = std::filesystem::path(tempDir) / (reMatches[3].str() + "-error.log");
      tgz.ExtractFile(errorFile, uncompressedFile);
      break;
    }
  }
  tgz.StopExtractFileData();

  std::ofstream ofs(tempDir+"/metadata.json");
  if (!ofs.is_open()) {
    throw std::runtime_error("Unable to create file " + tempDir + "/metadata.json");
  }
  ofs << "{\n";
  bool notFirst = false;
  for (auto const& [ name, count ] : details) {
    if (notFirst)  {
      ofs << ",\n";
    }
    notFirst = true;
    ofs << "\"" << name << "\":" << count;
  }
  ofs << "\n}";
  ofs.close();
  try {
    CompressTARZSTD(tempDir, filebin, true, 4*1024*1024, 10);
  } catch(std::exception const& e) {
    LOGE("Failed to compress " << filebin << ": " << e.what());
    std::error_code ec;
    std::filesystem::remove(filebin, ec);
  } catch(...) {
    LOGE("Failed to compress " << filebin << ": unknown error");
    std::error_code ec;
    std::filesystem::remove(filebin, ec);
  }
  std::filesystem::remove_all(tempDir);
}

std::vector<struct ns_Analyze::DataManager::SInterpolations> 
ns_Analyze::DataManager::ExtractDataTS(FileTARZST& archive, std::filesystem::path const& prefixPath, 
    struct SMetricInfos const& metricInfos, uint64_t min, uint64_t max, 
    uint64_t step) {
  std::vector<struct ns_Analyze::DataManager::SInterpolations> result;
  std::string filename = prefixPath / metricInfos.file_;
  uint64_t filesize = archive.FileSize(filename);
  if ((filesize == 0) || ((filesize % sizeof(uint64_t)) != 0)) {
    return result;
  }

  result.reserve(((max - min) + step - 1) / step);

  uint64_t timestampMaxIndex = (filesize / sizeof(uint64_t)) - 1;

  uint64_t minOffset = 0;
  uint64_t value;
  archive.ExtractFileData(filename, sizeof(uint64_t), 0, (char*)&value, nullptr);
  if (value < min) {
    minOffset = ~0;
    size_t low = 0;
    size_t high = timestampMaxIndex;
    while (low <= high) {
      size_t mid = low + (high - low) / 2;
      archive.ExtractFileData(filename, sizeof(uint64_t), mid * sizeof(uint64_t), (char*)&value, nullptr);
      if (value <= min) {
        minOffset = mid;
        if (mid == timestampMaxIndex) {
          for(uint64_t time=min; time<max; time+=step) {
            result.push_back({{0.0, 0.0},{timestampMaxIndex, timestampMaxIndex}});
          }
          return result;
        }
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
  } else if (value >= max) {
    for(uint64_t time=min; time<max; time+=step) {
      result.push_back({{0.0, 0.0},{0, 0}});
    }
    return result;
  } else if (value > min) {
    uint64_t newMin = (min + (((value - min) / step) * step)) + step;
    for(uint64_t time=min; time<newMin; time+=step) {
      result.push_back({{0.0, 0.0},{0, 0}});
    }
    min = newMin;
  }

  size_t fileOffset = minOffset;
  size_t currentFileOffset = fileOffset * sizeof(uint64_t);
  size_t currentOffset = 0;
  std::vector<uint64_t> values(4*1024*1024);
  uint64_t nbElementToRead = values.size();
  int64_t nbElementRead = archive.ExtractFileData(filename, nbElementToRead * sizeof(uint64_t), 
    fileOffset * sizeof(uint64_t), (char*)values.data(), nullptr) / sizeof(uint64_t);
  fileOffset += nbElementRead;
  if (nbElementRead != nbElementToRead) {
    values.resize(nbElementRead);
  }

  --nbElementToRead;

  for(uint64_t time=min; time<max; time+=step) {
    while(values[currentOffset] < time) {
      ++currentOffset;

      if (currentOffset >= values.size()) {
        values[0] = values.back();
        currentFileOffset = fileOffset * sizeof(uint64_t);
        nbElementRead = archive.ExtractFileData(filename, nbElementToRead * sizeof(uint64_t), 
          fileOffset * sizeof(uint64_t), (char*)(values.data()+1), nullptr) / sizeof(uint64_t);
        fileOffset += nbElementRead;
        currentOffset = 0;
        if (nbElementRead == 0) {
          break;
        }
        if (nbElementRead != nbElementToRead) {
          values.resize(nbElementRead + 1);
        }
      }
    }
    if (nbElementRead == 0) {
      break;
    }
    uint64_t offset = (currentFileOffset / sizeof(uint64_t)) + currentOffset;
    if (values[currentOffset] == time) {
      //LOGE(values[currentOffset] << " == " << time);
      result.push_back({{1.0, 0.0},{offset, offset}});
    } else {
      //LOGE(values[currentOffset-1] << " < " << time << " < " << values[currentOffset]);
      double diff1 = time - values[currentOffset-1];
      double diff2 = values[currentOffset] - time;
      double diff = diff1 + diff2;
      result.push_back({
          {1.0 - (diff1 / diff), 1.0 - (diff2 / diff)}, {offset - 1, offset}
      });
    }
  }

  uint64_t nbMissingElement = result.capacity() - result.size();
  if (nbMissingElement != 0) {
    struct ns_Analyze::DataManager::SInterpolations value = result.back();
    value.ratios = { 0.0, 0.0 };
    /*for(uint64_t i=0; i<nbMissingElement; ++i) {
      result.push_back(value);
    }*/
    result.insert(result.end(), nbMissingElement, value);
  }

  return result;
}
