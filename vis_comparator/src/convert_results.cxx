#include <iostream>
#include <filesystem>
#include <string>
#include <unordered_map>
#include <fstream>
#include <regex>
#include "utils/file_tgz.hxx"
#include "utils/compress_tar_zst.hxx"

static std::regex const reRunKeyFiles("^(?:.*/)?(logs/.+|artefacts/(?:[^/]+/)*[0-9]+-(?:stats\\.json|README\\.md))$");
static std::regex const reStats("^((?:.*/)?(artefacts/(?:[^/]+/)*([0-9]+))-stats\\.json)$");

int main(int argc, char* argv[]) {
  std::filesystem::path tgzFile;
  std::filesystem::path outFile;
  std::filesystem::path analyzeTools;

  std::map<std::string, int> argsKey {
    { "tgz", 0 }, { "out", 1 }, { "tool", 2 }
  };

  int argKey = -1;
  for (int i = 1; i < argc; ++i) {
    std::string arg = argv[i];
    if (argKey == -1) {
      if (arg.find("--") != 0) {
        std::cerr << "Missing argument parameter" << std::endl;
        return 1;
      }
      arg = arg.substr(2);
      auto const itArg = argsKey.find(arg);
      if (itArg == argsKey.end()) {
        std::cerr << "Unknown argument: " << arg << std::endl;
        return 1;
      }
      argKey = itArg->second;
    } else {
      switch (argKey) {
        case 0: tgzFile      = argv[i]; break;
        case 1: outFile      = argv[i]; break;
        case 2: analyzeTools = argv[i]; break;
      }
      argKey = -1;
    }
  }

  if (tgzFile.empty() || outFile.empty() || analyzeTools.empty()) {
    std::cerr << "Usage: convert_results --tgz <file.tgz> --out <file.tar.zst> --tool <analyze_results>" << std::endl;
    return 1;
  }
  if (!std::filesystem::exists(tgzFile)) {
    std::cerr << "tgz file not found: " << tgzFile << std::endl;
    return 1;
  }
  if (std::filesystem::exists(outFile)) {
    std::cout << "Output already exists, skipping: " << outFile << std::endl;
    return 0;
  }
  if (!std::filesystem::exists(analyzeTools)) {
    std::cout << "tool not found: " << analyzeTools << std::endl;
    return 0;
  }

  std::filesystem::path tempDir = outFile.parent_path() / "TMP";
  std::filesystem::create_directories(tempDir);

  std::unordered_map<std::string, uint64_t> details;

  FileTGZ tgz(tgzFile.string());
  std::smatch reMatches;
  auto const files = tgz.ListFiles(&reRunKeyFiles);

  for (auto const& [file, _] : files) {
    std::regex_match(file, reMatches, reRunKeyFiles);
    std::filesystem::path dstFile(reMatches[1].str());
    std::string uncompressedDir  = tempDir / dstFile.parent_path();
    std::string uncompressedFile = tempDir / dstFile;

    std::filesystem::create_directories(uncompressedDir);
    tgz.ExtractFile(file, uncompressedFile);

    if (!std::regex_match(file, reMatches, reStats)) {
      continue;
    }

    ++details[dstFile.parent_path().filename().string()];

    std::string command = analyzeTools.string() + " --path " + uncompressedDir;
    std::cout << "Running: " << command << std::endl;
    system(command.c_str());
    std::filesystem::remove(uncompressedFile);
  }
  tgz.StopExtractFileData();

  {
    std::ofstream ofs(tempDir / "metadata.json");
    if (!ofs.is_open()) {
      std::cerr << "Cannot create metadata.json" << std::endl;
      std::filesystem::remove_all(tempDir);
      return 1;
    }
    ofs << "{\n";
    bool notFirst = false;
    for (auto const& [name, count] : details) {
      if (notFirst) ofs << ",\n";
      notFirst = true;
      ofs << "\"" << name << "\":" << count;
    }
    ofs << "\n}";
  }

  try {
    CompressTARZSTD(tempDir.string(), outFile.string(), true, 4 * 1024 * 1024, 10);
  } catch (std::exception const& e) {
    std::cerr << "Compression failed: " << e.what() << std::endl;
    std::filesystem::remove(outFile);
    std::filesystem::remove_all(tempDir);
    return 1;
  }

  std::filesystem::remove_all(tempDir);
  std::cout << "Created: " << outFile << std::endl;
  return 0;
}
