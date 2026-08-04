#pragma once
#include <string>
#include <unordered_map>

std::string ResolveVariables(std::string const& pattern, 
    std::unordered_map<std::string, std::string> const& nameValues);