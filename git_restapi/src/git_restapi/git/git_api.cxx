#include "git_api.hxx"
#include "../../utils/logs.hxx"
#include "../../utils/rapidjson.hxx"
#include <fstream>
#include <algorithm>
#include <set>
#include <regex>
#include "rapidjson/document.h"
#include "rapidjson/writer.h"
#include "rapidjson/prettywriter.h"
#include "rapidjson/stringbuffer.h"
#include <Poco/URI.h>

ns_GIT::GitAPI::GitAPI(Config const config, std::string const& name, 
    std::unordered_map<std::string, std::string> const& parameters) 
    : directory_(config.storage_ / name), scriptsPath_(config.scriptsPath_), pullRefs_(false),
    historyBufferTS_(), historyBuffer_(), apiResetTS_(0), apiRemaining_(0)
{
  std::string const& url = parameters.at("url");
  char buffer[1024]{0};
  std::string outputStr;
  std::string repoPath = directory_ / "repo";
  std::string commandLine = "export GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=echo; "
      "git -C \"" + (directory_ / "repo").string() +
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

    // GitHub repository: also fetch the head of every pull request (refs/pull/<number>/head), to tell which PR
    // a commit belongs to (Logs); every later fetch (--all) updates them
    std::string const pullCommandLine = "export GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=echo; cd \"" + repoPath + "\" && "
        "{ git config --get-all remote.origin.fetch | grep -q 'refs/pull/' || "
        "git config --add remote.origin.fetch '+refs/pull/*/head:refs/remotes/origin/pull/*'; } && "
        "git fetch origin >/dev/null 2>&1";
    int pullRet = std::system(pullCommandLine.c_str());
    pullRefs_ = WIFEXITED(pullRet) && (WEXITSTATUS(pullRet) == 0);
    if (!pullRefs_) {
      LOGW << "Unable to fetch the pull request heads of " << url << ": no PR of the commits in the logs"
           << Log::Flags::End;
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

  rapidjson::Document doc;
  doc.SetObject();
  auto& alloc = doc.GetAllocator();
  rapidjson::Value commits(rapidjson::kArrayType);
  for (size_t i=0; i<commitIDs.size(); i+=10) {
    std::string commitIDsStr;
    size_t maxIndex = (i+10) < commitIDs.size() ? (i + 10) : commitIDs.size();
    for (size_t j=i; j<maxIndex; ++j) {
      commitIDsStr += commitIDs[j] + " ";
    }
    int status = 0;
    {
      std::shared_lock lock(lock_);
      status = system(("git -C " + (directory_ / "repo").string() + " log --oneline --no-walk " + commitIDsStr + " >/dev/null 2>&1").c_str());
      if (!WIFEXITED(status)) {
        result = "git log failled";
        return false;
      }
    }
    if (WEXITSTATUS(status) != 0) {
      std::lock_guard lock(lock_);
      int status = system(("git -C " + (directory_ / "repo").string() + " fetch --all").c_str());
      if ((!WIFEXITED(status)) || (WEXITSTATUS(status) != 0)) {
        result = "git fetch --all failled";
        return false;
      }
    }
    std::string const commandLine = "git -C " + (directory_ / "repo").string() + 
        " log --oneline --no-walk --pretty=tformat:\"%H%x1F%ad%x1F%s\" --date=short " + commitIDsStr + " 2>&1";

    std::string buffer;
    buffer.resize(4096);
    int retInt = 0;
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

        AddPullRequests(commitID, commit, alloc);

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
  }
  doc.AddMember("commits", commits, alloc);
  rapidjson::StringBuffer sb;
  rapidjson::Writer<rapidjson::StringBuffer> writer(sb);
  doc.Accept(writer);
  result = sb.GetString();
  return true;
}

// Output lines of a command (without end of line); false if it could not run or failed
static bool CommandLines(std::string const& commandLine, std::vector<std::string>& lines) {
  lines.clear();
  FILE* fstdout = popen(commandLine.c_str(), "r");
  if (fstdout == nullptr) {
    return false;
  }
  std::string buffer(4096, '\0');
  while (fgets(buffer.data(), buffer.size(), fstdout) != nullptr) {
    std::string line(buffer.c_str());
    line.erase(line.find_last_not_of(" \n\r") + 1);
    if (!line.empty()) {
      lines.push_back(line);
    }
  }
  int retInt = pclose(fstdout);
  return WIFEXITED(retInt) && (WEXITSTATUS(retInt) == 0);
}

// "pulls": the pull requests the commit belongs to, newest first: [{ number, index, total }], the commit being the
// index-th of the total commits of the PR (origin/dev..<PR head>; index == total: the commit is the PR head).
// Only for commits that are not on origin/dev (those name the PR they merge in their message), and at most
// maxPulls PRs (stacked PRs contain the commits of the PRs below them).
void ns_GIT::GitAPI::AddPullRequests(std::string const& commitID, rapidjson::Value& commit,
    rapidjson::MemoryPoolAllocator<>& alloc) {
  static constexpr size_t maxPulls = 5;
  if (!pullRefs_) {
    return;
  }
  if (commit.HasMember("base") && commit["base"].IsString() && (commitID == commit["base"].GetString())) {
    return;
  }
  std::string const git = "git -C \"" + (directory_ / "repo").string() + "\" ";
  std::vector<std::string> refs;
  if (!CommandLines(git + "for-each-ref --contains " + commitID +
      " --format='%(refname:lstrip=4)' refs/remotes/origin/pull/ 2>/dev/null", refs)) {
    return;
  }
  std::vector<uint64_t> numbers;
  for (auto const& ref : refs) {
    if ((!ref.empty()) && (ref.find_first_not_of("0123456789") == std::string::npos)) {
      numbers.push_back(std::stoull(ref));
    }
  }
  std::sort(numbers.rbegin(), numbers.rend());

  rapidjson::Value pulls(rapidjson::kArrayType);
  for (uint64_t number : numbers) {
    if (pulls.Size() >= maxPulls) {
      break;
    }
    std::vector<std::string> members;
    if (!CommandLines(git + "rev-list --reverse origin/dev..refs/remotes/origin/pull/" + std::to_string(number) +
        " 2>/dev/null", members)) {
      continue;
    }
    auto it = std::find(members.begin(), members.end(), commitID);
    if (it == members.end()) {
      continue;
    }
    rapidjson::Value pull(rapidjson::kObjectType);
    pull.AddMember("number", number, alloc);
    pull.AddMember("index", static_cast<uint64_t>(it - members.begin() + 1), alloc);
    pull.AddMember("total", static_cast<uint64_t>(members.size()), alloc);
    pulls.PushBack(pull, alloc);
  }
  commit.AddMember("pulls", pulls, alloc);
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
    rapidjson::Document cacheDoc;
    if (ReadJSONFile(cacheFile, cacheDoc) && cacheDoc.IsArray()) {
      prArray.CopyFrom(cacheDoc, alloc);
      cacheSuccess = true;
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

    SaveJSONFile(cacheFile, prArray, true);
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

bool ns_GIT::GitAPI::Presets(std::string const& commitID, std::string& result, bool& notFound) {
  notFound = false;
  std::filesystem::path const cacheFile = directory_ / "presets_cache.json";
  std::lock_guard presetsLock(presetsLock_);
  if (!presetsLoaded_) {
    presetsLoaded_ = true;
    std::ifstream ifs(cacheFile);
    std::string content((std::istreambuf_iterator<char>(ifs)), {});
    rapidjson::Document doc;
    doc.Parse(content.c_str());
    if (!doc.HasParseError() && doc.IsObject()) {
      for (auto const& entry : doc.GetObject()) {
        rapidjson::StringBuffer buffer;
        rapidjson::Writer<rapidjson::StringBuffer> writer(buffer);
        entry.value.Accept(writer);
        presets_[entry.name.GetString()] = buffer.GetString();
      }
    }
  }
  // a short id may match several cached commits: the cache answers only when it names exactly one
  std::string const* cached = nullptr;
  size_t matches = 0;
  for (auto const& [commit, json] : presets_) {
    if (commit.rfind(commitID, 0) == 0) {
      cached = &json;
      ++matches;
    }
  }
  if (matches == 1) {
    result = *cached;
    return true;
  }

  std::string const commandLine = (scriptsPath_ / "tlspuffin_presets.sh").string() + " \"" +
      (directory_ / "repo").string() + "\" " + commitID + " 2>/dev/null";
  auto run = [&](std::string& output) -> int {
    std::shared_lock lock(lock_);
    output.clear();
    FILE* fstdout = popen(commandLine.c_str(), "r");
    if (fstdout == nullptr) {
      return -1;
    }
    char buffer[4096];
    size_t size = 0;
    while ((size = fread(buffer, 1, sizeof(buffer), fstdout)) > 0) {
      output.append(buffer, size);
    }
    int const status = pclose(fstdout);
    return WIFEXITED(status) ? WEXITSTATUS(status) : -1;
  };
  int status = run(result);
  if (status == 2) {
    // a commit pushed since the last fetch
    std::lock_guard lock(lock_);
    // a failed fetch leaves the commit unknown (the retry below answers so)
    if (std::system(("git -C \"" + (directory_ / "repo").string() + "\" fetch --all --quiet >/dev/null 2>&1").c_str()) != 0) {
      LOGW << "git fetch failed, looking for the presets of " << commitID << Log::Flags::End;
    }
  }
  if (status == 2) {
    status = run(result);
  }
  if (status == 2) {
    notFound = true;
    result = "Unknown commit " + commitID;
    return false;
  }
  rapidjson::Document doc;
  doc.Parse(result.c_str());
  if ((status != 0) || doc.HasParseError() || !doc.IsObject() || !doc.HasMember("commit") || !doc["commit"].IsString()) {
    result = "Error while running tlspuffin_presets.sh";
    return false;
  }
  presets_[doc["commit"].GetString()] = result;

  rapidjson::Document all;
  all.SetObject();
  for (auto const& [commit, json] : presets_) {
    rapidjson::Document one(&all.GetAllocator());
    one.Parse(json.c_str());
    all.AddMember(rapidjson::Value(commit.c_str(), all.GetAllocator()), rapidjson::Value(one, all.GetAllocator()),
        all.GetAllocator());
  }
  rapidjson::StringBuffer buffer;
  rapidjson::Writer<rapidjson::StringBuffer> writer(buffer);
  all.Accept(writer);
  SaveFile(cacheFile, buffer.GetString());
  return true;
}
