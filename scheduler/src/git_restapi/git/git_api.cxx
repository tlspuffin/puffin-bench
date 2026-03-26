#include "git_api.hxx"
#include <fstream>
#include "rapidjson/document.h"
#include "rapidjson/writer.h"
#include "rapidjson/stringbuffer.h"

ns_GIT::GitAPI::GitAPI(Config const config, std::string const& name, std::string const& url) 
    : directory_(config.storage_ / name), scriptsPath_(config.scriptsPath_)
{
  char buffer[1024]{0};
  std::string repoPath = directory_ / "repo";
  std::string commandLine = "git -C \"" + (directory_ / "repo").string() + 
      "\" fetch --all >/dev/null 2>&1 || git clone --filter=blob:none " + 
      url + " \"" + repoPath + "\" 2>&1 1>/dev/null";
  FILE* stdout = popen(commandLine.c_str(), "r");
  if (stdout == nullptr) {
    throw std::runtime_error("Unable to fetch/clone " + url + " in " + repoPath);
  }
  size_t retSize = fread(buffer, 1, 1024, stdout);
  if (ferror(stdout)) {
    throw std::runtime_error("Error while fetch/clone " + url + ": " + 
        (retSize == 0 ? "unknown error" : buffer));
  }
  int retInt = pclose(stdout);
  if ((!WIFEXITED(retInt)) || (WEXITSTATUS(retInt) != 0)) {
    throw std::runtime_error("Error while fetch/clone " + url + ": " + 
        (retSize == 0 ? "unknown error" : buffer));
  }
}

bool ns_GIT::GitAPI::History(std::string& result) {
  std::filesystem::path outFile = directory_ / ("git_cache.json");
  std::string const commandLine = 
      (scriptsPath_ / "tlspuffin_history.sh").string() + " " + 
      outFile.string() + " --no-standalone \"" + (directory_ / "repo").string() + 
      "\" 1>/dev/null";

  int retInt = 0;
  {
    std::lock_guard lock(lock_);
    retInt = std::system(commandLine.c_str());
  }

  if ((!WIFEXITED(retInt)) || (WEXITSTATUS(retInt) != 0)) {
    result = "Error while running tlspuffin_history.sh";
    return false;
  }
  std::ifstream ifs(outFile);
  if (!ifs.is_open()) {
    result = "Error while opening " + outFile.string();
    return false;
  }
  result = std::string(std::istreambuf_iterator<char>(ifs), {});
  if (ifs.fail()) {
    result = "Error while reading " + outFile.string();
    return false;
  }
  return true;
}

bool ns_GIT::GitAPI::Logs(std::vector<std::string> commitIDs, std::string& result) {
  result.clear();
  if (commitIDs.empty()) {
    return true;
  }
  std::string commitIDsStr;
  for (std::string const& commit: commitIDs) {
    commitIDsStr += commit + " ";
  }
  std::string const commandLine = "git -C " + (directory_ / "repo").string() + 
      " log --oneline --no-walk --pretty=format:\"%h§%ad§%s\" --date=short " + commitIDsStr + " 2>&1";
  
  std::string buffer;
  buffer.resize(4096);
  int retInt = 0;
  rapidjson::Document doc;
  doc.SetObject();
  auto& alloc = doc.GetAllocator();
  rapidjson::Value commits(rapidjson::kArrayType);
  {
    std::lock_guard lock(lock_);
    FILE* stdout = popen(commandLine.c_str(), "r");
    if (stdout == nullptr) {
      result = "Unable to launch git process";
      return false;
    }
    while(fgets(buffer.data(), 4096, stdout) != nullptr) {
      size_t endIndex = buffer.find('\0');
      if (endIndex == std::string::npos) {
        result = "No end of line in command result";
        return false;
      }
      size_t dateIndex = buffer.find("§");
      if (dateIndex == std::string::npos) {
        result = buffer.substr(0, endIndex - 1);
        return false;
      }
      size_t commentIndex = buffer.find("§", dateIndex+1);
      if (commentIndex == std::string::npos) {
        result = buffer.substr(0, endIndex - 1);
        return false;
      }
      rapidjson::Value commit(rapidjson::kObjectType);
      commit.AddMember("id", rapidjson::Value(buffer.substr(0, dateIndex).c_str(), alloc), alloc);
      commit.AddMember("date", rapidjson::Value(buffer.substr(dateIndex + 2, commentIndex - dateIndex - 2).c_str(), alloc), alloc);
      commit.AddMember("comment", rapidjson::Value(buffer.substr(commentIndex + 2, endIndex - commentIndex - 2).c_str(), alloc), alloc);
      commits.PushBack(commit, alloc);
    }
    if (ferror(stdout)) {
      result = "Error while processing output";
      return false;
    }
    retInt = pclose(stdout);
  }
  if ((!WIFEXITED(retInt)) || (WEXITSTATUS(retInt) != 0)) {
    if (result.empty()) {
    result = "Unknown error";
    }
    return false;
  }
  doc.AddMember("commits", commits, alloc);
  rapidjson::StringBuffer sb;
  rapidjson::Writer<rapidjson::StringBuffer> writer(sb);
  doc.Accept(writer);
  result = sb.GetString();
  return true;
}