#pragma once

#include <string>
#include <filesystem>

namespace ns_Analyze {

bool Generate_Perf_ZST(std::filesystem::path const& inFile, 
    std::filesystem::path const& zstFile, std::string const& tmpDir);

};