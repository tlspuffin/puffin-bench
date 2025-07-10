#pragma once

#include "config.hxx"
#include <string>
#include <list>
#include <unordered_map>
#include <rapidjson/document.h>

namespace ns_Schedule {
  class Step;
}

namespace ns_Executor {

class ExecutorData {
public:
  virtual ~ExecutorData();
  virtual void ToJSON(rapidjson::Value& out, 
    rapidjson::Document::AllocatorType& alloc) const = 0;
};

inline ExecutorData::~ExecutorData() {}

class Executor {
public:
  static Executor* Build(ns_Executor::Config* config);
  virtual ~Executor();

  std::string Name() const;

  virtual std::list<ns_Schedule::Step*> FindRunnableSteps(std::list<ns_Schedule::Step*> const& tasks) const = 0;
  virtual void Execute(ns_Schedule::Step& step) = 0;
  virtual std::list<ns_Schedule::Step*> CheckFinishedSteps(std::list<ns_Schedule::Step*>& runningSteps) = 0;
  virtual void Shutdown(ns_Schedule::Step& step, bool wait =false) = 0;
  virtual void FinalClean(ns_Schedule::Step& step) = 0;

protected:
  Executor(std::string const& name);

private:
  std::string name_;
};

inline Executor::Executor(std::string const& name)
    : name_(name)
{}

inline Executor::~Executor() {}

inline std::string Executor::Name() const {
  return name_;
}

};