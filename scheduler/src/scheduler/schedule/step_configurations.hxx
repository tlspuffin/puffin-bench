#pragma once

#include <cstdint>
#include <string>
#include <unordered_map>
#include <vector>
#include <rapidjson/document.h>

namespace ns_Schedule {

class GroupStepConfigurations {
public:
  GroupStepConfigurations() : GroupStepConfigurations(1) {};
  GroupStepConfigurations(uint32_t nb_retry) : nb_retry_({{"", nb_retry}}) {};
  void ReadFromTaskJSON(rapidjson::Value const& entry);

  uint32_t NbRetry(std::string const& configName) const;

private:
  std::unordered_map<std::string, uint32_t> nb_retry_;
};

class StepConfigurations {
public:
  struct Configuration {
    std::string id_;
    std::string executor_name_;
    uint32_t nb_cores_;
    uint32_t nb_retry_;
    uint64_t timeout_;
    std::unordered_map<std::string, std::string> args_;

    Configuration();
    Configuration(std::string id, std::string const& executor_name, 
        uint32_t nb_cores, uint32_t nb_retry, uint64_t timeout, 
        std::unordered_map<std::string, std::string> const& args);
  };

  StepConfigurations();

  void ReadFromTaskJSON(rapidjson::Value const& entry);
  Configuration MakeWithOverrides(std::string const& name,
    std::vector<rapidjson::Value const*> const& overrides) const;

  Configuration defaultConfiguration_;
  std::unordered_map<std::string, Configuration> configurations_;

private:
  static Configuration ReadEntryFromTaskJSON(std::string const& name, 
      rapidjson::Value const& entry, Configuration& defaultConfiguration);
};

};