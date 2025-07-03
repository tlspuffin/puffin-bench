#include "cache.hxx"
#include <iostream>
#include <fstream>
#include <rapidjson/document.h>
#include <rapidjson/stringbuffer.h>
#include <rapidjson/prettywriter.h>
#include <rapidjson/error/en.h>

ns_Cache::Cache::Cache(ns_Cache::Config const& config) 
    : config_(config)
{
  LoadData();
  thread_ = std::thread(&ns_Cache::Cache::CacheLoop, this);
}

ns_Cache::Cache::~Cache() {
  if (thread_.joinable()) {
    threadRunning_ = false;
    cacheThreadCV_.notify_one();
    thread_.join();
  }
}

bool ns_Cache::Cache::Put(std::filesystem::path const& path, 
    std::string const& id, bool force, bool computeMD5) {
  std::error_code ec;
  if (!std::filesystem::exists(path, ec)) {
    throw std::runtime_error("File not found: " + path.string());
  }
  std::filesystem::path pathInStore;
  enum ns_Cache::Cache::GetStatus status = Get(id, pathInStore);
  if (!force) {
    if (status != ns_Cache::Cache::GetStatus::NO) {
      throw std::runtime_error("File already exist: " + id);
    }
  }
  struct FileToStore fileToStore;
  fileToStore.id_ = id;
  fileToStore.srcPath_ = path;
  fileToStore.md5_ = computeMD5;
  cacheThreadLock_.lock();
  dataToAdd_.push(fileToStore);
  cacheThreadLock_.unlock();
  cacheThreadCV_.notify_one();
  return true;
}

enum ns_Cache::Cache::GetStatus ns_Cache::Cache::Get(
    std::string const& id, std::filesystem::path& path) {
  enum ns_Cache::Cache::GetStatus status = ns_Cache::Cache::GetStatus::NO;
  dataLock_.lock();
  auto const& data = data_.find(id);
  if (data != data_.end()) {
    if (data->second.full_) {
      path = data->second.path_;
      status = ns_Cache::Cache::GetStatus::OK;
    } else {
      status = ns_Cache::Cache::GetStatus::PARTIAL;
    }
  }
  dataLock_.unlock();
  return status;
}

void ns_Cache::Cache::CacheLoop() {
  threadRunning_ = true;
  std::queue<struct FileToStore> dataToCopy;
  std::unique_lock lock(cacheThreadLock_);
  while(threadRunning_) {
    cacheThreadCV_.wait(lock);
    dataLock_.lock();
    while(dataToAdd_.size() > 0) {
      struct FileToStore fileToStore = dataToAdd_.front();
      dataToAdd_.pop();
      struct FileInformations fileInformations;
      fileInformations.path_ = config_.storagePath_ / fileToStore.id_;
      fileInformations.md5_ = 0;
      fileInformations.full_ = false;
      data_.insert(std::make_pair<>(fileToStore.id_, fileInformations));
      dataToCopy.push(fileToStore);
    }
    dataLock_.unlock();
    SaveData();
    while(dataToCopy.size() > 0) {
      struct FileToStore fileToStore = dataToCopy.front();
      dataToCopy.pop();
      try {
        std::filesystem::copy_file(
            fileToStore.srcPath_, config_.storagePath_ / fileToStore.id_, 
            std::filesystem::copy_options::overwrite_existing);
        auto const& data = data_.find(fileToStore.id_);            
        data->second.full_ = true;
      } catch (const std::filesystem::filesystem_error& e) {
        data_.erase(fileToStore.id_);
        std::cerr << "Error while copying: " << e.what() << std::endl;
      }
      SaveData();
    }
  }
  lock.unlock();
  threadRunning_ = false;
}


void ns_Cache::Cache::SaveData() {
  rapidjson::Document doc;
  doc.SetObject();
  rapidjson::Document::AllocatorType& allocator = doc.GetAllocator();

  for (const auto& [id, info] : data_) {
    rapidjson::Value fileObj(rapidjson::kObjectType);
    fileObj.AddMember("path", rapidjson::Value(info.path_.c_str(), allocator), allocator);
    fileObj.AddMember("md5", rapidjson::Value(info.md5_), allocator);
    fileObj.AddMember("full", rapidjson::Value(info.full_), allocator);

    doc.AddMember(rapidjson::Value(id.c_str(), allocator), fileObj, allocator);
  }

  rapidjson::StringBuffer buffer;
  rapidjson::PrettyWriter<rapidjson::StringBuffer> writer(buffer);

  if (!doc.Accept(writer)) {
      std::cerr << "Error: failed to create JSON data" << std::endl;
      return;
  }

  std::ofstream ofs(config_.mappingFile_);
  if (!ofs.is_open()) {
      std::cerr << "Error: unable to open writable file " << config_.mappingFile_ << std::endl;
      return;
  }
  ofs << buffer.GetString();
  if (!ofs) {
      std::cerr << "Error: write error in " << config_.mappingFile_ << std::endl;
      std::filesystem::remove(config_.mappingFile_);
  }
  ofs.close();
}


void ns_Cache::Cache::LoadData() {
  data_.clear();
  std::ifstream ifs(config_.mappingFile_);
  if (!ifs.is_open()) {
    /*throw std::runtime_error("Error: Unable to open cache info file " + 
        config_.mappingFile_.string());*/
    std::cerr << "Error: Unable to open cache info file " << 
        config_.mappingFile_.string() << ". Cache is empty." << std::endl;
    return;
  }

  std::stringstream buffer;
  buffer << ifs.rdbuf();
  std::string json = buffer.str();

  rapidjson::Document doc;
  if (doc.Parse(json.c_str()).HasParseError()) {
    throw std::runtime_error("Erreur de parsing JSON dans " + 
        config_.mappingFile_.string() + " (offset " + 
        std::to_string(doc.GetErrorOffset()) + "): " + 
        rapidjson::GetParseError_En(doc.GetParseError()));
  }

  if (!doc.IsObject()) {
    throw std::runtime_error("Error: Corrupted cache info file " + 
        config_.mappingFile_.string());
  }

  for (auto it = doc.MemberBegin(); it != doc.MemberEnd(); ++it) {
    std::string id = it->name.GetString();
    rapidjson::Value const& fileObj = it->value;

    if (!fileObj.IsObject()) {
      throw std::runtime_error("Error: Object '" + id + "' is corrupted.");
    }
    if (!fileObj.HasMember("path") || !fileObj["path"].IsString() ||
        !fileObj.HasMember("md5")  || !fileObj["md5"].IsUint64()  ||
        !fileObj.HasMember("full") || !fileObj["full"].IsBool()) {
      throw std::runtime_error("Error: Object '" + id + "' have missing informations");
    }

    FileInformations info;
    info.path_ = fileObj["path"].GetString();
    info.md5_  = fileObj["md5"].GetUint64();
    info.full_ = fileObj["full"].GetBool();
    if (info.full_) {
      data_[id] = info;
    } else {
      std::filesystem::remove(info.path_);
    }
  }
}