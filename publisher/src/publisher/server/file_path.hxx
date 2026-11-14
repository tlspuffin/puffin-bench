#pragma once
#include <string>

// The file a GET of the publisher names under one of its prefixes (/html/, /files/): the path of the URL, without its
// query (bugs.html?commit=<sha>: the page reads it) nor fragment, after the prefix. Without this, a page with a query
// was looked for as a file named with it (404).
inline std::string FilePathOf(std::string const& uri, std::string const& prefix) {
  std::string const path = uri.substr(0, uri.find_first_of("?#"));
  return path.size() >= prefix.size() ? path.substr(prefix.size()) : std::string();
}
