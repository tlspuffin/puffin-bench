#include "server/server.hxx"
#include "api/api.hxx"
#include "analyze/data.hxx"
#include "../utils/file_tar_zst.hxx"

#include <iostream>

#include <archive.h>
#include <archive_entry.h>
#include <vector>
#include <string>
#include <regex>

#define SEC_PATH "../security"
#define USR_PATH "../users_data"
#define SCRIPT_PATH "../scripts"
#define RUN_PATH "../runs"
#define EXPORT_PATH "../users_data"

class Config {
public:
  ns_Server::Config server_;
  ns_Analyze::Config analyze_;
};

int main(int argc, char *argv[]) {

  /*FileTARZST file("/home/olivier/Desktop/analyze/tlspuffin/PR/2dad52a3c/Perf/1761243981423.tar.zst");
  auto list = file.ListFiles();
  uint64_t fileSize;
  std::vector<char> buffer(2048);
  file.ExtractFileData("1761243981423/logs/stderr.2-1-1.txt", 2048, 0, buffer.data(), &fileSize);
  buffer[fileSize] = 0;
  std::cerr << buffer.data() << std::endl;*/

  /*FileTGZ tgz("/home/olivier/Desktop/analyze/1760975795951.tgz");
  //auto list = tgz.ListFiles("logs/");
  uint64_t filesize;
  std::vector<char> buffer(1024*5);
  int64_t succcess = tgz.ExtractFileData("logs/stderr.1-3-0.txt", buffer.size(), buffer.data(), &filesize);
  succcess = tgz.ExtractFileData("logs/stderr.1-3-0.txt", buffer.size(), buffer.data(), &filesize);
  succcess = tgz.ExtractFileData("logs/stderr.1-3-0.txt", buffer.size(), buffer.data(), &filesize);*/

  /*ns_Analyze::Data data0("/home/olivier/Desktop/analyze/BINOUT/1-stats.json.bin/metadata.json");
  std::vector<struct ns_Analyze::Data::StrDataMappingRange> axisMapping;
  data0.AlignData({"client_1.exec_per_sec", "client_2.exec_per_sec", "cumul_client.coverage.max"}, 1024, 1, axisMapping);*/

  Config config;

  /*std::string configFile = "analyze-config.json";
  if (argc == 2) {
    configFile = argv[1];
  }
  if (!config.Load(configFile)) {
    config.Save(configFile);
  }
  config.Validate();*/

  config.server_.html_ = "../html";
  std::cout << "Initializing dataset manager with path: "
      << config.analyze_.dataPath_ << std::endl;

  struct ns_API::APIS apis(config.analyze_);

  ns_Server::MyServerApp app(config.server_, apis);
  try {
    return app.run(argc, argv);
  } catch(std::runtime_error const& e) {
    std::cerr << e.what() << std::endl;
    return 1;
  }
}