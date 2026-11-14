#include "benchmarks_api.hxx"
#include "../../utils/logs.hxx"
#include "rapidjson/error/en.h"
#include "rapidjson/prettywriter.h"
#include "rapidjson/stringbuffer.h"
#include "rapidjson/writer.h"
#include <chrono>
#include <fstream>
#include <regex>
#include <sstream>

ns_API::BenchmarksAPI::BenchmarksAPI(std::filesystem::path const& storagePath)
    : file_(storagePath / "benchmarks.json"), doc_(rapidjson::kObjectType)
{
  std::ifstream in(file_);
  if (!in.is_open()) {
    return;  // none saved yet
  }
  std::stringstream buffer;
  buffer << in.rdbuf();
  in.close();
  rapidjson::Document read;
  read.Parse(buffer.str().c_str());
  if (read.HasParseError() || !read.IsObject()) {
    // kept aside for whoever wants it back; the board starts without saved benchmarks
    std::filesystem::path const aside = file_.string() + ".unreadable";
    std::error_code ec;
    std::filesystem::rename(file_, aside, ec);
    LOGE << "saved benchmarks: " << file_ << " is not a JSON object ("
         << (read.HasParseError() ? rapidjson::GetParseError_En(read.GetParseError()) : "another JSON value")
         << "), moved to " << aside << Log::Flags::End;
    return;
  }
  doc_.Swap(read);
}

bool ns_API::BenchmarksAPI::ValidProject(std::string const& project) {
  static std::regex const pattern(R"([A-Za-z0-9_-]{1,64})");
  return std::regex_match(project, pattern);
}

bool ns_API::BenchmarksAPI::ValidName(std::string const& name) {
  static std::regex const pattern(R"([A-Za-z0-9-]{1,24})");
  return std::regex_match(name, pattern);
}

std::string ns_API::BenchmarksAPI::List(std::string const& project) {
  std::lock_guard guard(lock_);
  rapidjson::StringBuffer buffer;
  rapidjson::Writer<rapidjson::StringBuffer> writer(buffer);
  auto it = doc_.FindMember(project.c_str());
  if (it == doc_.MemberEnd() || !it->value.IsObject()) {
    return "{}";
  }
  it->value.Accept(writer);
  return buffer.GetString();
}

bool ns_API::BenchmarksAPI::Save(std::string const& project, std::string const& name, std::string const& definitionJSON,
    std::string& error) {
  if (!ValidProject(project) || !ValidName(name)) {
    error = "a project is letters, digits, '_' and '-'; a benchmark name letters, digits and '-' (at most 24)";
    return false;
  }
  if (definitionJSON.size() > kMaxDefinitionSize) {
    error = "the definition is over " + std::to_string(kMaxDefinitionSize / 1024) + " KiB";
    return false;
  }
  rapidjson::Document definition;
  definition.Parse(definitionJSON.c_str());
  if (definition.HasParseError() || !definition.IsObject()) {
    error = "the definition is not a JSON object";
    return false;
  }
  auto named = definition.FindMember("name");
  if (named != definition.MemberEnd() && (!named->value.IsString() || name != named->value.GetString())) {
    error = "the definition's name is not the benchmark's name";
    return false;
  }

  std::lock_guard guard(lock_);
  auto& alloc = doc_.GetAllocator();
  if (!doc_.HasMember(project.c_str()) || !doc_[project.c_str()].IsObject()) {
    doc_.RemoveMember(project.c_str());
    doc_.AddMember(rapidjson::Value(project.c_str(), alloc), rapidjson::Value(rapidjson::kObjectType), alloc);
  }
  rapidjson::Value& saved = doc_[project.c_str()];
  saved.RemoveMember(name.c_str());
  rapidjson::Value entry(rapidjson::kObjectType);
  int64_t const now = std::chrono::duration_cast<std::chrono::milliseconds>(
      std::chrono::system_clock::now().time_since_epoch()).count();
  entry.AddMember("saved_at", now, alloc);
  entry.AddMember("definition", rapidjson::Value(definition, alloc), alloc);
  saved.AddMember(rapidjson::Value(name.c_str(), alloc), entry, alloc);
  Write();
  return true;
}

bool ns_API::BenchmarksAPI::Delete(std::string const& project, std::string const& name) {
  std::lock_guard guard(lock_);
  auto it = doc_.FindMember(project.c_str());
  if (it == doc_.MemberEnd() || !it->value.IsObject() || !it->value.RemoveMember(name.c_str())) {
    return false;
  }
  Write();
  return true;
}

// with lock_ held
void ns_API::BenchmarksAPI::Write() {
  rapidjson::StringBuffer buffer;
  rapidjson::PrettyWriter<rapidjson::StringBuffer> writer(buffer);
  doc_.Accept(writer);
  std::filesystem::path const tmp = file_.string() + ".tmp";
  {
    std::ofstream out(tmp, std::ios::trunc);
    out << buffer.GetString() << '\n';
    out.close();
    if (!out) {
      throw std::runtime_error("cannot write " + tmp.string());
    }
  }
  std::filesystem::rename(tmp, file_);
}
