// testBenchmarksAPI: the saved benchmarks of the board (api/benchmarks_api.hxx): saved, listed, replaced, deleted, kept
// across a restart of the scheduler; names, definitions and sizes it refuses; an unreadable file set aside.
#include "scheduler/api/benchmarks_api.hxx"
#include "rapidjson/document.h"
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <string>

int failures = 0;

void Check(std::string const& label, bool cond) {
  std::cerr << (cond ? "OK   " : "FAIL ") << label << '\n';
  if (!cond) ++failures;
}

rapidjson::Document Parse(std::string const& json) {
  rapidjson::Document doc;
  doc.Parse(json.c_str());
  return doc;
}

int main() {
  char dirTemplate[] = "/tmp/testBenchmarksAPI.XXXXXX";
  if (mkdtemp(dirTemplate) == nullptr) { std::cerr << "mkdtemp failed\n"; return 1; }
  std::filesystem::path const dir = dirTemplate;
  std::string const vulnc = R"({"name": "VulnC", "description": "BUF and HEAP, \"quoted\"", "attempts": 5,
    "experiments": [{"bug": "CVE-2022-39173", "oracle": {"kind": "crash", "asan": "stack-buffer-overflow"}}]})";
  std::string error;
  {
    ns_API::BenchmarksAPI api(dir);
    Check("none saved at first", api.List("tlspuffin") == "{}");
    Check("a definition is saved", api.Save("tlspuffin", "VulnC", vulnc, error));
    Check("one without a name is saved too", api.Save("tlspuffin", "Other-1", R"({"attempts": 1})", error));
    rapidjson::Document list = Parse(api.List("tlspuffin"));
    Check("the list is a JSON object of both", list.IsObject() && list.MemberCount() == 2 && list.HasMember("VulnC"));
    Check("each with its definition and when it was saved", list["VulnC"]["definition"]["experiments"][0]["bug"] == "CVE-2022-39173"
          && list["VulnC"]["saved_at"].IsInt64() && list["VulnC"]["saved_at"].GetInt64() > 0);
    Check("another project sees none of them", api.List("other") == "{}");

    Check("a name with another character is refused", !api.Save("tlspuffin", "Vuln_C", vulnc, error));
    Check("a name over 24 characters is refused", !api.Save("tlspuffin", std::string(25, 'a'), R"({})", error));
    Check("a definition that is not a JSON object is refused", !api.Save("tlspuffin", "Bad", "[1, 2]", error));
    Check("invalid JSON is refused", !api.Save("tlspuffin", "Bad", R"({"name": )", error));
    Check("a definition named otherwise is refused", !api.Save("tlspuffin", "Bad", R"({"name": "VulnC"})", error)
          && error.find("name") != std::string::npos);
    Check("a definition over the limit is refused", !api.Save("tlspuffin", "Big",
          R"({"x": ")" + std::string(ns_API::BenchmarksAPI::kMaxDefinitionSize, 'x') + R"("})", error));
    Check("nothing refused was kept", Parse(api.List("tlspuffin")).MemberCount() == 2);

    Check("saving again under a name replaces it", api.Save("tlspuffin", "VulnC", R"({"name": "VulnC", "attempts": 9})", error)
          && Parse(api.List("tlspuffin"))["VulnC"]["definition"]["attempts"] == 9);
  }
  {
    ns_API::BenchmarksAPI api(dir);
    rapidjson::Document list = Parse(api.List("tlspuffin"));
    Check("kept across a restart", list.MemberCount() == 2 && list["VulnC"]["definition"]["attempts"] == 9);
    Check("deleting one", api.Delete("tlspuffin", "Other-1") && !Parse(api.List("tlspuffin")).HasMember("Other-1"));
    Check("deleting it again: none", !api.Delete("tlspuffin", "Other-1"));
    Check("deleting in another project: none", !api.Delete("other", "VulnC"));
  }
  {
    ns_API::BenchmarksAPI api(dir);
    Check("a deletion is kept across a restart", Parse(api.List("tlspuffin")).MemberCount() == 1);
  }
  {
    std::ofstream(dir / "benchmarks.json", std::ios::trunc) << "{ not json";
    ns_API::BenchmarksAPI api(dir);
    Check("an unreadable file: none saved", api.List("tlspuffin") == "{}");
    Check("and the file is set aside, not overwritten", std::filesystem::exists(dir / "benchmarks.json.unreadable")
          && !std::filesystem::exists(dir / "benchmarks.json"));
    Check("saving again starts a new file", api.Save("tlspuffin", "VulnC", vulnc, error)
          && std::filesystem::exists(dir / "benchmarks.json"));
  }
  std::filesystem::remove_all(dir);
  std::cerr << (failures ? "FAILED" : "PASSED") << '\n';
  return failures ? 1 : 0;
}
