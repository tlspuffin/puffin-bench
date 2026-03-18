#include "executor.hxx"
#include "local.hxx"

#include <stdexcept>

ns_Executor::Executor* ns_Executor::Executor::Build(ns_Executor::Config* config, 
    uint16_t cachePort, ns_System::Linux& os) {
  switch(config->type_) {
    case Config::Type::Local: {
        LocalConfig* cConfig = 
            dynamic_cast<ns_Executor::LocalConfig*>(config);
        if (cConfig == nullptr) {
          throw std::runtime_error("Local Executor '" + 
              cConfig->name_ + "' got an inccorect configuration");
        }
        return new Local(cConfig->name_, *cConfig, cachePort, os);
      }
    default:
      throw std::runtime_error("Unknown executor type");
  }
}