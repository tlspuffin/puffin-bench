#pragma once
#include <string>
#include <filesystem>
#include <Poco/MD5Engine.h>
#include <Poco/DigestStream.h>

std::string MD5(std::string const& data);
std::string MD5(char const* data, size_t size);
std::string MD5(std::filesystem::path const& filepath);
