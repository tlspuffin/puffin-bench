#pragma once

#include <string>

namespace ns_Executor {

class Executor;

class ExecutorsProvider {
public:
  virtual ~ExecutorsProvider();
  virtual Executor* GetExecutor(std::string const& name) const = 0;
};

inline ExecutorsProvider::~ExecutorsProvider() {}

};