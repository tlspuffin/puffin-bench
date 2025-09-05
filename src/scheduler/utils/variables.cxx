#include "variables.hxx"

std::string ResolveVariables(std::string const& pattern, 
    std::unordered_map<std::string, std::string> const& taskVariables) {
  std::string result = pattern;
  size_t pos = 0;
  while ((pos = result.find("${", pos)) != std::string::npos) {
    size_t end = result.find('}', pos);
    if (end == std::string::npos) {
      break;
    }
    std::string variableName = result.substr(pos + 2, end - pos - 2);
    auto const& it = taskVariables.find(variableName);
    if (it != taskVariables.end()) {
      result.replace(pos, end - pos + 1, it->second);
      pos += it->second.length();
    } else {
      pos = end + 1;
    }
  }

  return result;
}