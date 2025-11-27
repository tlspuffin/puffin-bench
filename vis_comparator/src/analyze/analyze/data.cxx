#include "data.hxx"
#include "../../utils/rapidjson.hxx"
#include "../../utils/logs.hxx"
#include <stack>
#include <fstream>
//#include <rapidjson/istreamwrapper.h>

ns_Analyze::Data::DataType ns_Analyze::Data::StringToDataType(std::string const& type) {
  if (type == "int32") {
    return ns_Analyze::Data::DataType::INT32;
  } else if (type == "uint32") {
    return ns_Analyze::Data::DataType::UINT32;
  } else if (type == "int64") {
    return ns_Analyze::Data::DataType::INT64;
  } else if (type == "uint64") {
    return ns_Analyze::Data::DataType::UINT64;
  } else if (type == "double") {
    return ns_Analyze::Data::DataType::DOUBLE;
  } else {
    throw std::runtime_error("Unknown DataType " + type);
  }
}

size_t ns_Analyze::Data::DataTypeToDataSize(ns_Analyze::Data::DataType type) {
  switch ((type)) {
    case ns_Analyze::Data::DataType::INT32:
      return sizeof(int32_t);
    case ns_Analyze::Data::DataType::UINT32:
      return sizeof(uint32_t);
    case ns_Analyze::Data::DataType::INT64:      
      return sizeof(int64_t);
    case ns_Analyze::Data::DataType::UINT64:      
      return sizeof(uint64_t);
    case ns_Analyze::Data::DataType::DOUBLE:      
      return sizeof(double);
    default:
      throw std::runtime_error("Unknown DataType");
  }
}

ns_Analyze::Data::Data(std::filesystem::path baseDir, std::string const& metadataJSON) 
{
  Constructor(baseDir, metadataJSON);
}

ns_Analyze::Data::Data(std::filesystem::path const& metadataFilename) {
  std::ifstream ifs("data.bin", std::ios::binary);
  ifs.seekg(0, std::ios::end);
  std::string metadataJSON;  
  metadataJSON.resize(ifs.tellg());
  ifs.seekg(0, std::ios::beg);
  ifs.read(metadataJSON.data(), metadataJSON.size());
  ifs.close();

  try  {
    Constructor(metadataFilename.parent_path(), metadataJSON);
  } catch(std::runtime_error const& e) {
    throw std::runtime_error(std::string(e.what()) + " in file " + metadataFilename.string());
  }
}

void ns_Analyze::Data::Metrics(struct ns_Analyze::Data::MetricsInfo& metricsInfo) {
  metricsInfo.nbClient_ = nbClient_;
  metricsInfo.runTime_ = runTime_;
  metricsInfo.metricsNames_ = valuesNames_;
}

void ns_Analyze::Data::ExtractTimestampAxis(struct ns_Analyze::Data::StrDataMappingRange& data) {
  auto const& infos = datas_[data.file_];
  std::ifstream ifsXAxis(baseDir_ / infos.file_);
  if (!ifsXAxis.is_open()) {
    throw std::runtime_error("Unable to open: " + 
        (baseDir_ / infos.file_).string());
  }
  data.startElement_ += data.nbElement_;
  ifsXAxis.seekg(data.startElement_ * sizeof(uint64_t));

  std::vector<uint64_t> timestamps(data.windowSize_);
  size_t readSize = sizeof(uint64_t) * data.windowSize_;  
  ifsXAxis.read((char*)timestamps.data(), readSize);
  if ((!ifsXAxis) && (!ifsXAxis.eof())) {
    throw std::runtime_error("Failed to read " + std::to_string(readSize) + 
        " bytes from: " + data.file_);
  }

  if (data.base_ == nullptr) {
    uint64_t nbValue = 0;
    for(size_t i=0; i<data.windowSize_; i+=data.sampling_, ++nbValue) {
      timestamps[nbValue] = timestamps[i];
    }
    timestamps.resize(nbValue);
    data.timestamps_.swap(timestamps);
    data.nbElement_ = nbValue;
    data.elements_.reserve(0);
    return;
  }

  readSize -= sizeof(uint64_t);
  uint64_t currentOffset = 0;
  uint64_t min = data.base_->timestamps_.front();
  auto it = std::lower_bound(timestamps.begin(), timestamps.end(), min);
  while(it == timestamps.end()) {
    timestamps.front() = timestamps.back();
    ifsXAxis.read((char*)timestamps.data()+sizeof(uint64_t), readSize);
    if ((!ifsXAxis) && (!ifsXAxis.eof())) {
      throw std::runtime_error("Failed to read " + std::to_string(readSize) + 
          " bytes from: " + data.file_);
    }
    currentOffset += readSize;
    it = std::lower_bound(timestamps.begin()+1, timestamps.end(), min);
  }
  std::cout << '\n';
  std::cout << std::distance(timestamps.begin(), it) << ':' << *it << '/' << min << '\n';
  uint64_t nbElements = std::distance(it, timestamps.end());
  if ((*it == min) || (it == timestamps.begin())) {
    std::copy(it, timestamps.end(), timestamps.begin());
  } else {
    std::copy(it-1, timestamps.end(), timestamps.begin());
    ++nbElements;
  }
  timestamps.resize(nbElements);
  currentOffset += (data.windowSize_ - nbElements);
  uint64_t startOffset = currentOffset;

  std::vector<uint64_t> const& referenceTS = data.base_->timestamps_;
  data.elements_.reserve(data.base_->timestamps_.size());
  uint64_t maxOffset = currentOffset;
  it = timestamps.begin();
  for(uint64_t i=0; i<referenceTS.size(); ++i) {
    it = std::lower_bound(it, timestamps.end(), referenceTS[i]);
    while (it == timestamps.end()) {
      timestamps.front() = timestamps.back();
      ifsXAxis.read((char*)timestamps.data()+sizeof(uint64_t), readSize);
      if ((!ifsXAxis) && (!ifsXAxis.eof())) {
        throw std::runtime_error("Failed to read " + std::to_string(readSize) + 
            " bytes from: " + data.file_);
      }
      currentOffset += readSize;
      it = timestamps.begin();
      it = std::lower_bound(it, timestamps.end(), referenceTS[i]);
    }
    uint64_t offset = (currentOffset + std::distance(timestamps.begin(), it)) - startOffset;
    if (*it == referenceTS[i]) {
      data.elements_.push_back({offset, offset, 1.0, 0.0});
      std::cout << referenceTS[i] << " = " << *it << " : " << offset << '\n';
      ++it;
    } else if (it == timestamps.begin()) {
      data.elements_.push_back({offset, offset, 0.0, 0.0});
      std::cout << referenceTS[i] << " = novalue, have " << *it << " : " << offset << '\n';
    } else {
      double diff1 = referenceTS[i] - *(it - 1);
      double diff2 = *it - referenceTS[i];
      double diff = diff1 + diff2;
      data.elements_.push_back({offset - 1, offset, 1.0 - (diff1 / diff), 1.0 - (diff2 / diff)});
      std::cout << referenceTS[i] << " lower " << *(it - 1) << " / " << *it << " : " << offset - 1 << " / " << offset << ' ' << 1.0 - (diff1 / diff) << '/' << 1.0 - (diff2 / diff) << '\n';
    }
    maxOffset = offset;
  }
  std::cout << currentOffset << " : " << maxOffset << '\n';

  data.timestamps_.reserve(0);
  data.nbElement_ = (maxOffset - startOffset) / sizeof(uint64_t);
  if (data.nbElement_ > 0) {
    --data.nbElement_;
  }

  return;
}

void ns_Analyze::Data::AlignData(std::vector<std::string> yAxis, uint64_t windowDataSize, uint64_t sampling, 
      std::vector<struct StrDataMappingRange>& dataMappingRange) {
  
  std::unordered_set<uint64_t> clientsID;
  for(std::string const& field: yAxis) {
    if (field.find("global.") == 0) {
      continue;
    } else if (field.find("client_") == 0) {
      size_t dotPos = field.find('.');
      if (dotPos == std::string::npos) {
        throw std::runtime_error("bad name for y-axis: " + field);  
      }
      clientsID.insert(std::stoull(field.substr(7, dotPos - 7)));
    } else if (field.find("cumul_client.") == 0) {
      for(uint64_t i=1; i<=nbClient_; ++i) {
        clientsID.insert(i);
      }
      break;
    } else {
      throw std::runtime_error("unknown y-axis: " + field);
    }
  }

  dataMappingRange.reserve(1 + clientsID.size());
  dataMappingRange.push_back({"global", windowDataSize, sampling});
  struct StrDataMappingRange& reference = dataMappingRange.back();
  ExtractTimestampAxis(reference);

  for(uint64_t clientID: clientsID) {
    dataMappingRange.push_back({"client_"+std::to_string(clientID), windowDataSize, sampling, &reference});
    ExtractTimestampAxis(dataMappingRange.back());
  }
}

void ns_Analyze::Data::Constructor(std::filesystem::path baseDir, std::string const& metadataJSON) {
  baseDir_ = baseDir;

  rapidjson::Document doc;
  doc.Parse(metadataJSON.c_str());

  nbClient_ = Get<uint64_t>(doc, "nb_client");
  runTime_ = Get<uint64_t>(doc, "run_time");

  if ((!doc.HasMember("series")) || (!doc["series"].IsObject())) {
    throw std::runtime_error("JSON data missing series array");
  }
  std::stack<std::pair<const rapidjson::Value*, std::string>> stack;
  rapidjson::Value& value = doc["series"].GetObj();
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
        struct Data::StrInfos infos;
        infos.name_ = fieldName;
        infos.type_ = StringToDataType(Get<std::string>(value, "type"));
        infos.nbElement_ = Get<uint64_t>(value, "count");
        infos.file_ = Get<std::string>(value, "file");
        datas_.emplace(fullName, infos);

        if (fullName.find("client_") == 0) {
          size_t dotPos = fullName.find('.');
          if (dotPos == std::string::npos) {
            throw std::runtime_error("Wrongly formatted name: " + fullName);
          }
          fullName = "client" + fullName.substr(dotPos);
        }
        valuesNames_.insert(fullName);
      }
    }
  }

  /*LOGI("************** PATH **************");
  for(auto const& path: valuesNames_) {
    LOGI(path);
  }
  LOGI("************** DATA **************");
  for(auto const& [key, _]: datas_) {
    LOGI(key);
  }*/
}