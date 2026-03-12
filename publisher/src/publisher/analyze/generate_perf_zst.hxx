#pragma once

#include <string>
#include <filesystem>

namespace ns_Analyze {

bool Generate_Perf_ZST(std::filesystem::path const& tgzFile, 
    std::filesystem::path const& zstFile, std::string const& tmpDir);

};