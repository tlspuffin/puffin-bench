#include "git_api.hxx"
#include "../../utils/logs.hxx"
#include <fstream>
#include <set>
#include <regex>
#include "rapidjson/document.h"
#include "rapidjson/writer.h"
#include "rapidjson/prettywriter.h"
#include "rapidjson/stringbuffer.h"
#include <Poco/URI.h>

ns_GIT::GitAPI::GitAPI(Config const config, std::string const& name, 
    std::unordered_map<std::string, std::string> const& parameters) 
    : directory_(config.storage_ / name), scriptsPath_(config.scriptsPath_), 
    historyBufferTS_(), historyBuffer_(), apiResetTS_(0), apiRemaining_(0)
{
  std::string const& url = parameters.at("url");
  char buffer[1024]{0};
  std::string outputStr;
  std::string repoPath = directory_ / "repo";
  std::string commandLine = "git -C \"" + (directory_ / "repo").string() + 
      "\" fetch --all >/dev/null 2>&1 || git clone --filter=blob:none " + 
      url + " \"" + repoPath + "\" 2>&1 1>/dev/null";
  FILE* output = popen(commandLine.c_str(), "r");
  if (output == nullptr) {
    throw std::runtime_error("Unable to fetch/clone " + url + " in " + repoPath);
  }
  size_t bytesRead = 0;
  while((bytesRead = fread(buffer, 1, 1024, output)) > 0) {
    outputStr.append(buffer, bytesRead);
  }
  if (ferror(output)) {
    throw std::runtime_error("Error while fetch/clone " + url + ": " + 
        (outputStr.empty() ? "unknown error" : outputStr));
  }
  int retInt = pclose(output);
  if ((!WIFEXITED(retInt)) || (WEXITSTATUS(retInt) != 0)) {
    throw std::runtime_error("Error while fetch/clone " + url + ": " + 
        (outputStr.empty() ? "unknown error" : outputStr));
  }

  auto const& urlPRIT = parameters.find("url_pr");
  if (urlPRIT != parameters.end()) {
    Poco::URI uri(urlPRIT->second);
    prClient_.Remote(uri.getHost() + ":" + std::to_string(uri.getPort()));
    prURLPath_ = uri.getPathAndQuery();
    std::ifstream ifs(directory_ / "pr_infos_cache.json");
    if (ifs.is_open()) {
      ifs >> apiResetTS_ >> apiRemaining_;
    }
  }

  std::filesystem::path outFile = directory_ / ("git_cache.json");
  if (!std::filesystem::exists(outFile)) {
    return;
  }

  std::ifstream ifs(outFile);
  if (!ifs.is_open()) {
    std::filesystem::remove(outFile);
    return;
  }
  historyBuffer_ = std::string(std::istreambuf_iterator<char>(ifs), {});
  rapidjson::Document doc;
  if (!ifs.fail()) {
    doc.Parse(historyBuffer_.c_str());
  }
  if (ifs.fail() || doc.HasParseError()) {
    std::filesystem::remove(outFile);
    historyBuffer_ = "";
    return;
  }

  std::filesystem::file_time_type fileTime = std::filesystem::last_write_time(outFile);
  std::chrono::nanoseconds age = std::filesystem::file_time_type::clock::now() - fileTime;
  historyBufferTS_ = std::chrono::steady_clock::now() - age;
}

bool ns_GIT::GitAPI::History(std::string& result, enum ns_GIT::GitAPI::ERefresh refresh) {
  auto now = std::chrono::steady_clock::now();
  if (refresh == ns_GIT::GitAPI::ERefresh::None) {
    std::shared_lock lock(lock_);
    if ((!historyBuffer_.empty()) && (now - historyBufferTS_) < std::chrono::hours(24)) {
      result = historyBuffer_;
      return true;
    }
  }

  std::filesystem::path outFile = directory_ / "tlspuffin_history_cache.json";
  std::string const commandLine = 
      (scriptsPath_ / "tlspuffin_history.sh").string() + " " + 
      outFile.string() + " --no-standalone \"" + (directory_ / "repo").string() + 
      "\" 1>/dev/null";

  std::lock_guard lock(lock_);

  int retInt = 0;
  retInt = std::system(commandLine.c_str());

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

  rapidjson::Document tlspuffinhistoryJSON;
  tlspuffinhistoryJSON.Parse(result.c_str());
  if (tlspuffinhistoryJSON.HasParseError()) {
    result = "Internal command produced invalid JSON";
    return false;
  }

  if (!prURLPath_.empty()) {
    if (!ManageExternalPR(tlspuffinhistoryJSON, result, refresh)) {
      return false;
    }
  }

  std::string cacheFile = directory_ / "git_cache.json";
  SaveFile(cacheFile, result);

  historyBuffer_ = result;
  historyBufferTS_ = now;
  return true;
}

bool ns_GIT::GitAPI::Logs(std::vector<std::string> commitIDs, std::string& result) {
  result.clear();
  if (commitIDs.empty()) {
    result = "{\"commits\":[]}";
    return true;
  }
  std::string commitIDsStr;
  for (std::string const& commit: commitIDs) {
    commitIDsStr += commit + " ";
  }
  std::string const commandLine = "git -C " + (directory_ / "repo").string() + 
      " log --oneline --no-walk --pretty=tformat:\"%H%x1F%ad%x1F%s\" --date=short " + commitIDsStr + " 2>&1";
  
  std::string buffer;
  buffer.resize(4096);
  int retInt = 0;
  rapidjson::Document doc;
  doc.SetObject();
  auto& alloc = doc.GetAllocator();
  rapidjson::Value commits(rapidjson::kArrayType);
  {
    std::shared_lock lock(lock_);
    FILE* fstdout = popen(commandLine.c_str(), "r");
    if (fstdout == nullptr) {
      result = "Unable to launch git process";
      return false;
    }
    while(fgets(buffer.data(), 4096, fstdout) != nullptr) {
      if (strchr(buffer.data(), '\n') == nullptr) {
        pclose(fstdout);
        result = "No end of line in command result";
        return false;
      }
      char* datePrt = strchr(buffer.data(), '\x1F');
      if (datePrt == nullptr) {
        pclose(fstdout);
        result = buffer.c_str();
        return false;
      }
      size_t dateIndex = datePrt - buffer.data();
      size_t commentIndex = buffer.find("\x1F", dateIndex+1);
      if (commentIndex == std::string::npos) {
        pclose(fstdout);
        result = buffer.c_str();
        return false;
      }
      rapidjson::Value commit(rapidjson::kObjectType);
      std::string commitID = buffer.substr(0, dateIndex);
      std::string comment(buffer.substr(commentIndex + 1));
      comment.erase(comment.find_last_not_of(" \n\r") + 1);
      commit.AddMember("id", rapidjson::Value(commitID.c_str(), alloc), alloc);
      commit.AddMember("date", rapidjson::Value(buffer.substr(dateIndex + 1, commentIndex - dateIndex - 1).c_str(), alloc), alloc);
      commit.AddMember("comment", rapidjson::Value(comment.c_str(), alloc), alloc);

      {
        std::string const commandLine = "git -C " + (directory_ / "repo").string() + " merge-base " + commitID + " origin/dev 2>&1";
        FILE* fstdoutBranchInfo = popen(commandLine.c_str(), "r");
        if (fstdoutBranchInfo != nullptr) {
          if (fgets(buffer.data(), 4096, fstdoutBranchInfo) != nullptr) {
            if (strchr(buffer.data(), '\n') != nullptr) {
              std::string baseHash(buffer.data());
              baseHash.erase(baseHash.find_last_not_of(" \n\r") + 1);
              commit.AddMember("base", rapidjson::Value(baseHash.c_str(), alloc), alloc);
            }
          }
          pclose(fstdoutBranchInfo);
        }
      }

      commits.PushBack(commit, alloc);
    }
    if (ferror(fstdout)) {
      pclose(fstdout);
      result = "Error while processing output";
      return false;
    }
    retInt = pclose(fstdout);
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

bool ns_GIT::GitAPI::SaveFile(std::string const& file, std::string const& content) {
  std::ofstream ofs(file, std::ios::trunc);
  if (!ofs.is_open()) {
    LOGW << "Unable to create " << file << Log::Flags::End;
    return false;
  }
  ofs << content;
  if (ofs.fail()) {
    LOGW << "Error while writing " << file << Log::Flags::End;
    ofs.close();
    return false;
  }
  ofs.close();
  return true;
}

bool ns_GIT::GitAPI::ManageExternalPR(rapidjson::Document& json, std::string& result, 
    enum ns_GIT::GitAPI::ERefresh refresh) {
  std::string cacheFile = directory_ / "pr_cache.json";

  rapidjson::MemoryPoolAllocator<>& alloc = json.GetAllocator();
  rapidjson::Value prArray(rapidjson::kArrayType);

  bool cacheSuccess = false;
  uint64_t nowSec = std::chrono::duration_cast<std::chrono::seconds>(
      std::chrono::system_clock::now().time_since_epoch()).count();
  if ((refresh != ns_GIT::GitAPI::ERefresh::All) || 
      ((apiResetTS_ > nowSec) && (apiRemaining_ == 0))) {
    std::ifstream ifs(cacheFile);
    if (ifs.is_open()) {
      std::string cacheContent(std::istreambuf_iterator<char>(ifs), {});
      if (!ifs.fail()) {
        rapidjson::Document cacheDoc;
        cacheDoc.Parse(cacheContent.c_str());
        if (!cacheDoc.HasParseError() && cacheDoc.IsArray()) {
          prArray.CopyFrom(cacheDoc, alloc);
          cacheSuccess = true;
        }
      }
    }
  }
  if (!cacheSuccess) {
    static std::regex const re(R"(<([^>]+)>\s*;\s*rel="next")");
    std::unordered_map<std::string, std::string> headers {
          {"link", ""}, 
          {"x-ratelimit-reset", ""},
          {"x-ratelimit-remaining", ""}
      };
    std::string path = prURLPath_;
    std::string cacheInfoFile = directory_ / "pr_infos_cache.json";
    while(!path.empty()) {
      std::string prJSON;
      headers["link"] = "";
      bool prClientSuccess = prClient_.Get(path, prJSON, headers);
      if (!headers["x-ratelimit-reset"].empty()) {
        apiResetTS_ = std::stoull(headers["x-ratelimit-reset"]);
      }
      if (!headers["x-ratelimit-remaining"].empty()) {
        apiRemaining_ = std::stoull(headers["x-ratelimit-remaining"]);
      }
      if (!prClientSuccess) {
        if (apiResetTS_ != 0) {
          SaveFile(cacheInfoFile, std::to_string(apiResetTS_) + " " + std::to_string(apiRemaining_));
        }
        bool firstFail = path == prURLPath_;
        if (!firstFail) {
          result = "External PR command does not completed";
        }
        return firstFail;
      }

      rapidjson::Document docPR;
      docPR.Parse(prJSON.c_str());
      if (docPR.HasParseError() || (!docPR.IsArray())) {
        result = "External PR command produced invalid JSON";
        return false;
      }

      static std::set<std::string> keep 
          { "title", "number", "id", "created_at", "updated_at", "head", "base", "state" };
      rapidjson::MemoryPoolAllocator<>& docPRAlloc = docPR.GetAllocator();
       for (auto & pr: docPR.GetArray()) {
        if (!pr.IsObject()) {
          continue;
        }
        if (!pr.HasMember("head")) {
          continue;
        }
        if ((!pr["head"].IsObject()) || (!pr["head"].HasMember("sha"))) {
          continue;
        }

        auto it = pr.MemberBegin();
        while (it != pr.MemberEnd()) {
          std::string name = it->name.GetString();
          if (keep.find(name) == keep.end()) {
            it = pr.EraseMember(it);
          } else {
            ++it;
          }
        }
        if (pr.HasMember("id")) {
          rapidjson::Value& id = pr["id"];
          pr.AddMember("idPR", id, docPRAlloc);
          pr.RemoveMember("id");
        }
        if (pr.HasMember("title")) {
          rapidjson::Value& title = pr["title"];
          pr.AddMember("comment", title, docPRAlloc);
          pr.RemoveMember("title");
        }
        if (pr.HasMember("created_at") && pr["created_at"].IsString()) {
          std::string date = pr["created_at"].GetString();
          date = date.substr(0, date.find('T'));
          pr.AddMember("date", rapidjson::Value(date.c_str(), docPRAlloc), docPRAlloc);
        }
        pr.AddMember("id", pr["head"]["sha"], docPRAlloc);
        if (pr["head"].HasMember("ref")) {
          pr.AddMember("branch", pr["head"]["ref"], docPRAlloc);
        }
        pr.RemoveMember("head");
        if (pr.HasMember("base")) {
          rapidjson::Value& prBase = pr["base"];
          std::string base;
          if (prBase.HasMember("sha") && prBase["sha"].IsString()) {
            base = prBase["sha"].GetString();
          }
          if (prBase.HasMember("ref")) {
            pr.AddMember("base_ref", prBase["ref"], docPRAlloc);
          }
          pr.RemoveMember("base");
          if (!base.empty()) {
            pr.AddMember("base", rapidjson::Value(base.c_str(), docPRAlloc), docPRAlloc);
          }
        }

        prArray.PushBack(rapidjson::Value().CopyFrom(pr, alloc), alloc);
      }

      std::smatch m;
      if (std::regex_search(headers["link"], m, re)) {
        path = Poco::URI(m[1].str()).getPathAndQuery();
      } else {
        path = "";
      }
    }

    if (apiResetTS_ != 0) {
      SaveFile(cacheInfoFile, std::to_string(apiResetTS_) + " " + std::to_string(apiRemaining_));
    }

    rapidjson::StringBuffer sb;
    rapidjson::PrettyWriter<rapidjson::StringBuffer> writerCache(sb);
    prArray.Accept(writerCache);
    SaveFile(cacheFile, sb.GetString());
  }

  rapidjson::Value prAPIInfos(rapidjson::kObjectType);
  prAPIInfos.AddMember("apiResetTS", apiResetTS_, alloc);
  prAPIInfos.AddMember("apiRemaining", apiRemaining_, alloc);
  json.AddMember("PR_API_Infos", prAPIInfos, alloc);
  json.AddMember("PR", prArray, alloc);

  rapidjson::StringBuffer sb;
  rapidjson::PrettyWriter<rapidjson::StringBuffer> writerResult(sb);
  json.Accept(writerResult);
  result = sb.GetString();

  return true;
}
