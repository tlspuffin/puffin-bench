#pragma once

#include <filesystem>
#include <mutex>
#include <string>
#include "rapidjson/document.h"

namespace ns_API {

// Saved benchmarks: named definitions a project's launcher keeps for later (the custom Vuln benchmarks of tlspuffin:
// their bugs, versions and settings), shared by every user of the board. One file, <exportPath>/benchmarks.json:
//   { "<project>": { "<name>": { "saved_at": <ms since the epoch>, "definition": { ... } } } }
// written whole on each change (a temporary file, then renamed). The scheduler does not read a definition: the
// launcher that saved it does.
class BenchmarksAPI {
public:
  static constexpr std::size_t kMaxDefinitionSize = 256 * 1024;

  explicit BenchmarksAPI(std::filesystem::path const& storagePath);

  // the saved benchmarks of a project, as a JSON object (empty when none)
  std::string List(std::string const& project);
  // saves (or replaces) one; error: why it is refused
  bool Save(std::string const& project, std::string const& name, std::string const& definitionJSON, std::string& error);
  // false: no such saved benchmark
  bool Delete(std::string const& project, std::string const& name);

  // what the routes accept: a project as the board names it, a benchmark name as the launcher allows it
  static bool ValidProject(std::string const& project);
  static bool ValidName(std::string const& name);

private:
  void Write();
  std::filesystem::path const file_;
  rapidjson::Document doc_;
  std::mutex lock_;
};

};
