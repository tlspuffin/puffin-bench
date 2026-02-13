#include "publisher/publish/publish_action_perf_summary.hxx"
#include "utils/dir.hxx"
#include <iostream>

int main(int argc, char* argv[]) {
  /*ns_Publish::PublishActionPerfUseSummary object;
  object.GenerateCommitJson("/home/olivier/Desktop/analyze/Z/run/1764959043692.tgz", "/tmp");*/

  std::cout << true << '\n';

  std::cout << IsSubDir("/hello/world", "/hello") << '\n';
  std::cout << IsSubDir("/hello", "/hello/world") << '\n';
  std::cout << IsSubDir("/hello/world", "/hello/world/series") << '\n';
  std::cout << IsSubDir("/hello/world/series", "/hello/world") << '\n';

  std::cout << IsSubDir("hello/world", "hello") << '\n';
  std::cout << IsSubDir("hello", "hello/world") << '\n';
  std::cout << IsSubDir("hello/world", "hello/world/series") << '\n';
  std::cout << IsSubDir("hello/world/series", "hello/world") << '\n';

  return 0;
}
