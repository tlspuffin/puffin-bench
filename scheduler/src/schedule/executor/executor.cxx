#include "executor.hxx"
#include "local.hxx"

#include <stdexcept>

ns_Executor::Executor* ns_Executor::Executor::Build(enum Type type, 
    std::string const& name, 
    std::unordered_map<std::string, ns_Executor::Config*> configs) {
  auto const& config = configs.find(name);
  switch(type) {
    case Type::LOCAL: {
        if (config == configs.end()) {
          throw std::runtime_error("Local Executor '" + 
              name + "' requires a configuration");
        }
        LocalConfig* iConfig = 
            dynamic_cast<ns_Executor::LocalConfig*>(config->second);
        if (iConfig == nullptr) {
          throw std::runtime_error("Local Executor '" + 
              name + "' got an inccorect configuration");
        }
        return new Local(name, *iConfig);
      }
    default:
      throw std::runtime_error("Unknown executor type");
  }
}