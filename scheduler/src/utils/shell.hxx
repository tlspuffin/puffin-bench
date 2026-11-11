#pragma once
#include <string>

// The arguments of a step reach its function as shell variables: the executor writes them to the step's parameters
// file as assignments, which functions.sh (SetupEnv) evaluates. A value is written single-quoted, so it reaches the
// step exactly as given: quotes, spaces, '$', backquotes, backslashes and new lines included (a custom benchmark
// passes its oracle as JSON).

// a name the shell can assign: a letter or '_', then letters, digits and '_'
inline bool IsShellName(std::string const& name) {
  if (name.empty()) return false;
  for (std::size_t i = 0; i < name.size(); ++i) {
    char const c = name[i];
    bool const letter = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '_';
    bool const digit = c >= '0' && c <= '9';
    if (!letter && !(digit && i > 0)) return false;
  }
  return true;
}

// the value as one single-quoted shell word: each ' becomes '\'' (close, an escaped quote, reopen)
inline std::string ShellQuote(std::string const& value) {
  std::string quoted = "'";
  for (char const c : value) {
    if (c == '\'') quoted += "'\\''";
    else quoted += c;
  }
  return quoted + "'";
}

// "<name>='<value>' " for each argument whose name the shell can assign; the others are given to skipped
template <typename Map, typename Skipped>
std::string ShellAssignments(Map const& args, Skipped&& skipped) {
  std::string out;
  for (auto const& [name, value] : args) {
    if (!IsShellName(name)) {
      skipped(name);
      continue;
    }
    out += name + "=" + ShellQuote(value) + " ";
  }
  return out;
}
