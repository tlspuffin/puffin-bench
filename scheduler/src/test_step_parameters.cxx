// testStepParameters [<functions.sh>]: the arguments of a step reach its function as given. The executor writes them
// (ShellAssignments, as local.cxx does) and functions.sh evaluates them (SetupEnv, run by bash here): values with
// double quotes (a custom benchmark's oracle as JSON), apostrophes, '$', backquotes, backslashes, runs of spaces,
// glob characters and new lines; a name the shell cannot assign is skipped and reported.
#include "utils/shell.hxx"
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <map>
#include <string>
#include <vector>
#include <unistd.h>

#ifndef FUNCTIONS_SH
#define FUNCTIONS_SH "scripts/functions.sh"
#endif

int failures = 0;

void Check(std::string const& label, bool cond) {
  std::cerr << (cond ? "OK   " : "FAIL ") << label << '\n';
  if (!cond) ++failures;
}

int main(int argc, char** argv) {
  std::string const functions = argc > 1 ? argv[1] : FUNCTIONS_SH;
  std::map<std::string, std::string> const args = {
    { "target_oracle", R"({"kind":"claim","violation":"Negotiated cipher is not in agent's configured ciphers list"})" },
    { "target_bug", "CVE-2024-5814" },
    { "vendor", "wolfssl:wolfssl552-asan-only-CVE-2024-5814" },
    { "features", "" },
    { "extra_flags", "'--put-use-clear' '--other'" },
    { "dollar", "$HOME ${PATH} $(echo no) `echo no` $" },
    { "backslash", R"(a\b\\c\'d\)" },
    { "spaces", "  two  spaces  " },
    { "glob", "* ? [a-z] ~" },
    { "newline", "line 1\nline 2\n" },
    { "apostrophes", "'''" },
  };
  std::vector<std::string> skipped;
  std::map<std::string, std::string> withBadNames = { args.begin(), args.end() };
  withBadNames["bad-name"] = "x";
  withBadNames["1x"] = "x";
  withBadNames[""] = "x";
  std::string const assignments = ShellAssignments(withBadNames, [&](std::string const& n) { skipped.push_back(n); });
  Check("names the shell cannot assign are skipped and reported", skipped.size() == 3);

  char dirTemplate[] = "/tmp/testStepParameters.XXXXXX";
  if (mkdtemp(dirTemplate) == nullptr) { std::cerr << "mkdtemp failed\n"; return 1; }
  std::filesystem::path const dir = dirTemplate;
  std::ofstream(dir / "parameters", std::ios::trunc) << assignments;
  std::ofstream(dir / "config", std::ios::trunc) << "";

  // SetupEnv of functions.sh runs when it is sourced; then each variable, NUL-terminated
  std::string script = "THEJOB_SH_CONFIG_FILE='" + (dir / "config").string() + "'; THEJOB_ENV_PATH='" +
      (dir / "none").string() + "'; THEJOB_PARAMETERS_PATH='" + (dir / "parameters").string() + "'; source " +
      ShellQuote(functions) + " || exit 3; for n in";
  for (auto const& [name, value] : args) script += " " + name;
  script += "; do printf '%s\\0' \"${!n}\"; done; [ -z \"${bad_name+x}\" ] || exit 4";
  std::ofstream(dir / "run.sh", std::ios::trunc) << script;
  std::string const command = "bash " + ShellQuote((dir / "run.sh").string()) + " 2> " +
      ShellQuote((dir / "stderr").string());
  FILE* out = popen(command.c_str(), "r");
  if (out == nullptr) { std::cerr << "popen failed\n"; return 1; }
  std::string output;
  char buffer[4096];
  for (std::size_t n; (n = fread(buffer, 1, sizeof buffer, out)) > 0;) output.append(buffer, n);
  int const status = pclose(out);
  Check("functions.sh evaluates the parameters without an error", status == 0);
  std::string errors;
  {
    std::ifstream in(dir / "stderr");
    errors.assign(std::istreambuf_iterator<char>(in), std::istreambuf_iterator<char>());
  }
  Check("nothing on stderr" + (errors.empty() ? std::string() : ": " + errors), errors.empty());

  std::vector<std::string> values;
  for (std::size_t start = 0, end; (end = output.find('\0', start)) != std::string::npos; start = end + 1) {
    values.push_back(output.substr(start, end - start));
  }
  Check("one value per argument", values.size() == args.size());
  std::size_t i = 0;
  for (auto const& [name, value] : args) {
    Check(name + " arrives as given", i < values.size() && values[i] == value);
    ++i;
  }
  std::filesystem::remove_all(dir);
  std::cerr << (failures ? "FAILED" : "PASSED") << '\n';
  return failures ? 1 : 0;
}
