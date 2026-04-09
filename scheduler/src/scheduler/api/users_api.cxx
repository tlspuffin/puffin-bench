#include "users_api.hxx"
#include "../schedule/task.hxx"
#include "rapidjson/filewritestream.h"
#include "rapidjson/prettywriter.h"
#include "rapidjson/error/en.h"

ns_API::UsersAPI::UsersAPI(ns_Schedule::Config const& config) 
    : storagePath_(config.exportPath_), doc_(rapidjson::kObjectType), alloc_(doc_.GetAllocator())
{
  std::string filename = (storagePath_ / "users.json").string();
  std::ifstream statusFile(filename);
  if (!statusFile.is_open()) {
    std::cerr << "Warning: Unable to open users db file " << 
        filename << ". Users DB is empty start stateless." << std::endl;
    return;
  }
  std::stringstream buffer;
  buffer << statusFile.rdbuf();
  doc_.Parse(buffer.str().c_str());
  if (doc_.HasParseError()) {
    throw std::runtime_error(std::string("Error while parsing JSON file '") +
        filename + "' : " + rapidjson::GetParseError_En(doc_.GetParseError()) +
        " (offset: " + std::to_string(doc_.GetErrorOffset()) + ")");
  }
}

bool ns_API::UsersAPI::Add(ns_Schedule::Task* task, bool running) {
  {
    std::unique_lock lock(lockDB_);
    {
      rapidjson::Value valueEmpty(rapidjson::kObjectType);
      if (!doc_.HasMember(task->user_.c_str())) {
        doc_.AddMember(rapidjson::Value(task->user_.c_str(), alloc_), valueEmpty, alloc_);
      }
    }
    rapidjson::Value& user = doc_[task->user_.c_str()];
    if (!user.IsObject()) {
      throw std::runtime_error("users JSON fatal error, " + task->user_ + " is not an object");
    }
    {
      rapidjson::Value valueEmpty(rapidjson::kObjectType);
      if (!user.HasMember(task->job_type_.c_str())) {
        user.AddMember(rapidjson::Value(task->job_type_.c_str(), alloc_), valueEmpty, alloc_);
      }
    }
    rapidjson::Value& jobType = user[task->job_type_.c_str()];
    if (!jobType.IsObject()) {
      throw std::runtime_error("users JSON fatal error, " + task->user_ + "." + task->job_type_ + " is not an object");
    }

    rapidjson::Value valueEmpty(rapidjson::kObjectType);
    rapidjson::Value& value = valueEmpty;
    std::string taskID = std::to_string(task->id_);
    if (jobType.HasMember(taskID.c_str())) {
      value = jobType[taskID.c_str()];
    } else {
      jobType.AddMember(rapidjson::Value(taskID.c_str(), alloc_), value, alloc_);
    }
    value.AddMember("name", rapidjson::Value(task->name_.c_str(), alloc_), alloc_);
    value.AddMember("running", running, alloc_);
    value.AddMember("cancelled", task->request_cancel_, alloc_);
  }
  return Save();
}

std::vector<std::string> ns_API::UsersAPI::Users() {
  std::shared_lock lock(lockDB_);
  std::vector<std::string> result;
  for(auto it = doc_.MemberBegin(); it != doc_.MemberEnd(); ++it) {
    if (!it->name.IsString()) {
      throw std::runtime_error("users JSON fatal error, one of the users entries is not an object");
    }
    result.push_back(it->name.GetString());
  }
  return result;
}

bool ns_API::UsersAPI::UserJobTypes(std::string const& user, std::vector<std::string>& result) {
  std::shared_lock lock(lockDB_);
  if (!doc_.HasMember(user.c_str())) {
    return false;
  }
  rapidjson::Value const& userJSON = doc_[user.c_str()];
  if (!userJSON.IsObject()) {
    throw std::runtime_error("users JSON fatal error, entry " + user + " is not an object");
  }
  for(auto it = userJSON.MemberBegin(); it != userJSON.MemberEnd(); ++it) {
    if (!it->name.IsString()) {
      throw std::runtime_error("users JSON fatal error, one of the users entries is not an object");
    }
    result.push_back(it->name.GetString());
  }
  return true;
}

bool ns_API::UsersAPI::UserTasks(std::string const& user, std::string const& jobType, 
    std::vector<struct ns_API::UsersAPI::TaskInfos>& result) {
  std::shared_lock lock(lockDB_);
  if (!doc_.HasMember(user.c_str())) {
    return false;
  }
  rapidjson::Value const& userJSON = doc_[user.c_str()];
  if (!userJSON.IsObject()) {
    throw std::runtime_error("users JSON fatal error, entry " + user + " is not an object");
  }
  if (!userJSON.HasMember(jobType.c_str())) {
    return false;
  }
  rapidjson::Value const& jobTypeJSON = userJSON[jobType.c_str()];
  if (!jobTypeJSON.IsObject()) {
    throw std::runtime_error("users JSON fatal error, entry " + user + "." + jobType + " is not an object");
  }
  for(auto it=jobTypeJSON.MemberBegin(); it!=jobTypeJSON.MemberEnd(); ++it) {
    if (!it->name.IsString()) {
      throw std::runtime_error(
          "users JSON fatal error, entry " + user + "." + jobType + " name is not a string");
    }
    std::string id = it->name.GetString();
    rapidjson::Value const& value = it->value;
    if((!value.HasMember("name")) || (!value["name"].IsString())) {
      throw std::runtime_error(
          "users JSON fatal error, entry " + user + "." + jobType + "." + id + ".name have issue");
    }
    for(std::string field: std::vector<std::string>{"running", "cancelled"}) {
      char const* fieldC = field.c_str();
      if((!value.HasMember(fieldC)) || (!value[fieldC].IsBool())) {
        throw std::runtime_error(
            "users JSON fatal error, entry " + user + "." + jobType + "." + id + "." + field + " have issue");
        }
    }
    result.emplace_back(ns_API::UsersAPI::TaskInfos{
        std::strtoull(id.c_str(), nullptr, 10), value["name"].GetString(), value["running"].GetBool(), value["cancelled"].GetBool()
    });
  }
  return true;
}

bool ns_API::UsersAPI::Save() {
  std::unique_lock lock(lockDB_);
  std::string filename = (storagePath_ / "users.json").string();
  FILE* fp = std::fopen((filename + "tmp").c_str(), "w");
  if (!fp) {
    throw std::system_error(errno, std::generic_category(), "Unable to open " + filename);
  }
  char buffer[65536];
  rapidjson::FileWriteStream os(fp, buffer, sizeof(buffer));
  rapidjson::PrettyWriter<rapidjson::FileWriteStream> writer(os);
  doc_.Accept(writer);
  std::fclose(fp);

  std::filesystem::rename((filename + "tmp"), filename);

  return true;
}