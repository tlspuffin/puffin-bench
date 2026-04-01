#pragma once

#include <cstdint>
#include <chrono>
#include <vector>

namespace ns_Schedule {

class Task;

struct SRessourcesSummary {
  int8_t cpu;
  int8_t memory;
  ns_Schedule::Task* task;
  std::chrono::milliseconds runningTime;

  static struct SRessourcesSummary const* ToKill(
      std::vector<struct SRessourcesSummary> const& ressourcesSummaries);
};

inline struct SRessourcesSummary const* SRessourcesSummary::ToKill(
    std::vector<struct SRessourcesSummary> const& ressourcesSummaries) {
  struct SRessourcesSummary const* result = &ressourcesSummaries[0];
  float maxScore = (float)result->memory / (float)result->runningTime.count();
  for(size_t i=1; i<ressourcesSummaries.size(); ++i) {
    float score = (float)ressourcesSummaries[i].memory / (float)ressourcesSummaries[i].runningTime.count();
    if ((score > maxScore) ||
        ((score == maxScore) && (ressourcesSummaries[i].runningTime.count() < result->runningTime.count()))) {
      result = &ressourcesSummaries[i];
      maxScore = score;
    }
  }
  return result;
}

};