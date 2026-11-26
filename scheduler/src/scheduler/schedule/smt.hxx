#pragma once

#include <string>
#include <map>

namespace ns_Schedule {

class SMT {
public:
// How the CPUs of a step are chosen:
//   pairs: whole physical cores, all their threads to the step (its clients share cores only with each other); the
//          thread left over by an odd number of CPUs stays idle, reserved by the step
//   one:   one thread of each physical core, the other ones reserved by the step and idle (each client alone on its
//          core, twice the CPUs)
//   any:   logical CPUs whatever their cores (the former behaviour: two steps can share a physical core)
  enum class Mode { UnSet, Whole, One, Any };

  static bool Parse(std::string const& smtMode, Mode& value);
  static std::string Label(Mode smtMode);
};

inline bool SMT::Parse(std::string const& smtMode, SMT::Mode& value) {
  static std::map<std::string, SMT::Mode> smtModeValues = {
      { "pairs", SMT::Mode::Whole }, { "whole", SMT::Mode::Whole },
      { "one", SMT::Mode::One }, { "any", SMT::Mode::Any }
  };
  auto it = smtModeValues.find(smtMode);
  bool success = it != smtModeValues.end();
  value = success ? it->second : SMT::Mode::UnSet;
  return success;
}

inline std::string SMT::Label(SMT::Mode smtMode) {
  static std::map<SMT::Mode, std::string> smtModeLabels = {
      { SMT::Mode::Whole, "pairs" /*"whole"*/ }, { SMT::Mode::One, "one" }, { SMT::Mode::Any, "any" }
  };
  auto it = smtModeLabels.find(smtMode);
  return it != smtModeLabels.end() ? it->second : "";
}

};