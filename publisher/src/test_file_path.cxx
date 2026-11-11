// testFilePath: the file a URL of the publisher names (server/file_path.hxx): its query and fragment are not part of it.
#include "publisher/server/file_path.hxx"
#include <iostream>

int failures = 0;
void Check(std::string const& label, std::string const& got, std::string const& want) {
  bool const ok = got == want;
  std::cerr << (ok ? "OK   " : "FAIL ") << label << (ok ? "" : " (got '" + got + "', want '" + want + "')") << '\n';
  if (!ok) ++failures;
}

int main() {
  Check("a page", FilePathOf("/html/publisher/bugs.html", "/html/"), "publisher/bugs.html");
  Check("a page with a query", FilePathOf("/html/publisher/bugs.html?commit=b1d572b94052db08f752a1bb7e37b96814878855", "/html/"),
        "publisher/bugs.html");
  Check("a page with a fragment", FilePathOf("/html/objectives/1791790469349.html#bug-B", "/html/"), "objectives/1791790469349.html");
  Check("a query and a fragment", FilePathOf("/html/publisher/bugs.html?commit=abc#CVE-2023-6936", "/html/"), "publisher/bugs.html");
  Check("a file of /files/", FilePathOf("/files/tlspuffin/PR/x/Vuln/1.zip?download=1", "/files/"), "tlspuffin/PR/x/Vuln/1.zip");
  Check("the prefix alone", FilePathOf("/html/?x", "/html/"), "");
  std::cerr << (failures ? "FAILED" : "PASSED") << '\n';
  return failures ? 1 : 0;
}
