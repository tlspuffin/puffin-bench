#include "cache.hxx"
#include "../../utils/logs.hxx"
#include <iostream>
#include <fstream>
#include <list>
#include <rapidjson/document.h>
#include <rapidjson/stringbuffer.h>
#include <rapidjson/prettywriter.h>
#include <rapidjson/error/en.h>

ns_Cache::Cache::Cache(ns_Cache::Config const& config) 
    : config_(config), threadRunning_(false)
{
  if (!LoadData()) {
    SaveData();
  }
  threadRunning_ = true;
  thread_ = std::thread(&ns_Cache::Cache::CacheLoop, this);
}

ns_Cache::Cache::~Cache() {
  {
    std::lock_guard<std::mutex> lock(cacheThreadLock_);
    threadRunning_ = false;
  }
  cacheThreadCV_.notify_one();
  if (thread_.joinable()) {
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
  {
    std::lock_guard<std::mutex> lock(cacheThreadLock_);
    dataToAdd_.push_back(fileToStore);
  }
  cacheThreadCV_.notify_one();
  return true;
}

enum ns_Cache::Cache::GetStatus ns_Cache::Cache::Get(
    std::string const& id, std::filesystem::path& path) {
  enum ns_Cache::Cache::GetStatus status = ns_Cache::Cache::GetStatus::NO;
  std::shared_lock lock(dataLock_);
  auto const& data = data_.find(id);
  if (data != data_.end()) {
    if (data->second.full_.load()) {
      path = data->second.path_;
      return ns_Cache::Cache::GetStatus::OK;
    } else {
      return ns_Cache::Cache::GetStatus::PARTIAL;
    }
  }
  return ns_Cache::Cache::GetStatus::NO;
}

void ns_Cache::Cache::CacheLoop() {
  std::vector<struct FileToStore> dataToAdd;
  std::unique_lock lock(cacheThreadLock_);
  while(threadRunning_) {
    cacheThreadCV_.wait(lock);
    if (dataToAdd_.empty()) {
      continue;
    }
    dataToAdd.swap(dataToAdd_);
    lock.unlock();

    {
      std::lock_guard<std::shared_mutex> lock(dataLock_);
      for(auto const& it : dataToAdd) {
        struct FileInformations fileInformations;
        fileInformations.path_ = config_.storagePath_ / it.id_;
        fileInformations.md5_ = "";
        fileInformations.full_ = false;
        data_.emplace(it.id_, fileInformations);
      }
    }
    SaveData();

    for(auto const& it : dataToAdd) {
      try {
        LOGI << "[cache] copying " << it.srcPath_ << " to " << config_.storagePath_ / it.id_ << Log::Flags::End;
        std::filesystem::copy_file(it.srcPath_, config_.storagePath_ / it.id_, 
            std::filesystem::copy_options::overwrite_existing);
        {
          std::lock_guard<std::shared_mutex> lock(dataLock_);
          data_.at(it.id_).full_.store(true);
        }
        SaveCopyLog(it.id_, config_.storagePath_ / it.id_, "");
      } catch (const std::filesystem::filesystem_error& e) {
        {
          std::lock_guard<std::shared_mutex> lock(dataLock_);
          data_.erase(it.id_);
        }
        LOGE << "Error while copying: " << e.what() << Log::Flags::End;
      }
    }

    SaveData();
    DeleteCopyLog();
    dataToAdd.clear();

    lock.lock();
  }
  lock.unlock();
  threadRunning_ = false;
}


void ns_Cache::Cache::SaveData() const {
  rapidjson::Document doc;
  doc.SetObject();
  rapidjson::Document::AllocatorType& allocator = doc.GetAllocator();

  for (const auto& [id, info] : data_) {
    rapidjson::Value fileObj(rapidjson::kObjectType);
    fileObj.AddMember("path", rapidjson::Value(info.path_.c_str(), allocator), allocator);
    fileObj.AddMember("md5", rapidjson::Value(info.md5_.c_str(), allocator), allocator);
    fileObj.AddMember("full", rapidjson::Value(info.full_.load()), allocator);

    doc.AddMember(rapidjson::Value(id.c_str(), allocator), fileObj, allocator);
  }

  rapidjson::StringBuffer buffer;
  rapidjson::PrettyWriter<rapidjson::StringBuffer> writer(buffer);

  if (!doc.Accept(writer)) {
      LOGE << "Error: failed to create JSON data" << Log::Flags::End;
      return;
  }

  std::string tmpFile = config_.mappingFile_.string() + ".tmp";
  std::ofstream ofs(tmpFile, std::ios::trunc);
  if (!ofs.is_open()) {
      LOGE << "Error: unable to open writable file " << tmpFile << Log::Flags::End;
      return;
  }
  ofs << buffer.GetString();
  if (!ofs) {
      LOGE << "Error: write error in " << tmpFile << Log::Flags::End;
      std::filesystem::remove(tmpFile);
      ofs.close();
      return;
  }
  ofs.close();

  LOGI << "[cache] rename " << tmpFile << " in " << config_.mappingFile_ << Log::Flags::End;
  std::filesystem::rename(tmpFile, config_.mappingFile_);
}

void ns_Cache::Cache::SaveCopyLog(std::string const& id, std::string const& path, 
    std::string const& md5) const {
  std::string copyLogFile = config_.mappingFile_.string() + ".copy";
  std::ofstream ofs(copyLogFile, std::ios::app);
  if (!ofs.is_open()) {
      LOGE << "Error: unable to open writable file " << copyLogFile << Log::Flags::End;
      return;
  }
  ofs << id << '\n' << path << '\n' << md5 << '\n';
  ofs.close();
}

inline void ns_Cache::Cache::DeleteCopyLog() {
  LOGI << "[cache] delete copy log " << config_.mappingFile_.string() + ".copy" << Log::Flags::End;
  std::filesystem::remove(config_.mappingFile_.string() + ".copy");
}

bool ns_Cache::Cache::LoadData() {
  data_.clear();
  std::ifstream ifs(config_.mappingFile_);
  if (!ifs.is_open()) {
    LOGW << "Warning: Unable to open cache info file " << 
        config_.mappingFile_.string() << ". Cache is empty." << Log::Flags::End;
    return true;
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

  std::unordered_map<std::string, struct FileInformations> copiedFile;
  ifs.open(config_.mappingFile_.string() + ".copy");
  if (ifs.is_open()) {
    FileInformations fileInformations;
    std::string id, path, md5;
    while (std::getline(ifs, id) && std::getline(ifs, path) &&
        std::getline(ifs, md5)) {
      fileInformations.path_ = path;
      fileInformations.md5_ = md5;
      fileInformations.full_.store(true);
      copiedFile.emplace(id, fileInformations);
    }
  }

  bool noCleaning = true;
  for (auto it = doc.MemberBegin(); it != doc.MemberEnd(); ++it) {
    std::string id = it->name.GetString();
    rapidjson::Value const& fileObj = it->value;

    if (!fileObj.IsObject()) {
      throw std::runtime_error("Error: Object '" + id + "' is corrupted.");
    }
    if (!fileObj.HasMember("path") || !fileObj["path"].IsString() ||
        !fileObj.HasMember("md5")  || !fileObj["md5"].IsString()  ||
        !fileObj.HasMember("full") || !fileObj["full"].IsBool()) {
      throw std::runtime_error("Error: Object '" + id + "' have missing informations");
    }

    FileInformations info;
    info.path_ = fileObj["path"].GetString();
    info.md5_  = fileObj["md5"].GetString();
    info.full_.store(fileObj["full"].GetBool());
    std::error_code ec;
    bool exist = std::filesystem::exists(info.path_, ec);
    if (exist && info.full_) {
      LOGI << "[cache] add " << id << " as " << info.path_ << Log::Flags::End;
      data_[id] = info;
    } else if (exist && copiedFile.find(id) != copiedFile.end()) {
      LOGI << "[cache] add " << id << " as " << copiedFile[id].path_ << Log::Flags::End;
      data_[id] = copiedFile[id];
    } else {
      noCleaning = false;
      LOGI << "[cache] delete unclean file " << info.path_ << Log::Flags::End;
      std::filesystem::remove(info.path_);
    }
  }

  return noCleaning;
}
