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

  static struct SRessourcesSummary const* ToKillMem(
      std::vector<struct SRessourcesSummary> const& ressourcesSummaries);
  static struct SRessourcesSummary const* ToKillCPU(
      std::vector<struct SRessourcesSummary> const& ressourcesSummaries);
};

inline struct SRessourcesSummary const* SRessourcesSummary::ToKillMem(
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

inline struct SRessourcesSummary const* SRessourcesSummary::ToKillCPU(
    std::vector<struct SRessourcesSummary> const& ressourcesSummaries) {
  struct SRessourcesSummary const* result = &ressourcesSummaries[0];
  float maxScore = (float)result->cpu / (float)result->runningTime.count();
  for(size_t i=1; i<ressourcesSummaries.size(); ++i) {
    float score = (float)ressourcesSummaries[i].cpu / (float)ressourcesSummaries[i].runningTime.count();
    if ((score > maxScore) ||
        ((score == maxScore) && (ressourcesSummaries[i].runningTime.count() < result->runningTime.count()))) {
      result = &ressourcesSummaries[i];
      maxScore = score;
    }
  }
  return result;
}

};