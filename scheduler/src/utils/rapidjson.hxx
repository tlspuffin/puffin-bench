#pragma once
#include <string>
#include <filesystem>
#include <rapidjson/document.h>

void ReadJSONFile(std::string const& file, rapidjson::Document& doc);

template<typename T> T const GetOrDefault(rapidjson::Value const& obj,
    char const* name, T const defaultValue);
std::filesystem::path GetOrDefaultPath(
    rapidjson::Value const& obj, char const* name,
    std::filesystem::path const defaultValue);
template<typename T> T Get(rapidjson::Value const& obj,
    char const* name);
std::filesystem::path GetPath(rapidjson::Value const& obj, 
    char const* name);

uint64_t ParseDurationToSeconds(const std::string& str);
uint64_t ParseDurationToMilliSeconds(const std::string& str);

template<typename T> inline T const GetOrDefault(rapidjson::Value const& obj,
    char const* name, T const defaultValue) {
  auto it = obj.FindMember(name);
  if (it != obj.MemberEnd()) {
    rapidjson::Value const& value = it->value;
    if constexpr (std::is_same_v<T, bool>) {
      if (value.IsBool()) return value.GetBool();
    } else if constexpr (std::is_integral_v<T>) {
      if (value.IsInt()) return static_cast<T>(value.GetInt());
      if (value.IsUint()) return static_cast<T>(value.GetUint());
      if (value.IsInt64()) return static_cast<T>(value.GetInt64());
      if (value.IsUint64()) return static_cast<T>(value.GetUint64());
    } else if constexpr (std::is_floating_point_v<T>) {
      if (value.IsDouble()) return static_cast<T>(value.GetDouble());
    } else if constexpr (std::is_same_v<T, std::string>) {
      if (value.IsString()) return std::string(value.GetString());
    } else if constexpr (std::is_same_v<T, rapidjson::Value::ConstObject>) {
      if (value.IsObject()) return value.GetObj();
    } else if constexpr (std::is_same_v<T, rapidjson::Value::ConstArray>) {
      if (value.IsArray()) return value.GetArray();
    }
  }
  return defaultValue;
}

inline std::filesystem::path GetOrDefaultPath(
    rapidjson::Value const& obj, char const* name,
    std::filesystem::path const defaultValue) {
  std::string value = GetOrDefault<std::string>(obj, name, defaultValue.string());
  return std::filesystem::weakly_canonical(std::filesystem::path(value));
}

template<typename T> inline T Get(rapidjson::Value const& obj,
    char const* name) {
  auto it = obj.FindMember(name);
  if (it != obj.MemberEnd()) {
    rapidjson::Value const& value = it->value;
    if constexpr (std::is_same_v<T, bool>) {
      if (value.IsBool()) return value.GetBool();
    } else if constexpr (std::is_integral_v<T>) {
      if (value.IsInt()) return static_cast<T>(value.GetInt());
      if (value.IsUint()) return static_cast<T>(value.GetUint());
      if (value.IsInt64()) return static_cast<T>(value.GetInt64());
      if (value.IsUint64()) return static_cast<T>(value.GetUint64());
    } else if constexpr (std::is_floating_point_v<T>) {
      if (value.IsDouble()) return static_cast<T>(value.GetDouble());
    } else if constexpr (std::is_same_v<T, std::string>) {
      if (value.IsString()) return std::string(value.GetString());
    } else if constexpr (std::is_same_v<T, rapidjson::Value::ConstObject>) {
      if (value.IsObject()) return value.GetObj();
    } else if constexpr (std::is_same_v<T, rapidjson::Value::ConstArray>) {
      if (value.IsArray()) return value.GetArray();
    }
  }
  throw std::runtime_error(std::string("Missing field ") + name + " in JSON data");
}

inline std::filesystem::path GetPath(
    rapidjson::Value const& obj, char const* name) {
  return std::filesystem::weakly_canonical(
      std::filesystem::path(Get<std::string>(obj, name)));
}
