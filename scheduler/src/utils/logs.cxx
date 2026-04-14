#include "logs.hxx"

Logs logs;

static std::mutex lockOut;
static std::mutex lockError;

Logs::Logs() : a_(std::cout, lockOut, ""), e_(std::shared_ptr<Log>(new Log())), 
    w_(std::shared_ptr<Log>(new Log())), i_(std::shared_ptr<Log>(new Log())), 
    d_(std::shared_ptr<Log>(new Log())), logsLevel_({0, 0, 0, 0}) {}

void Logs::SetLevel(struct sLevel logsLevel) {
  if (logsLevel_.error != logsLevel.error) {
    if (logsLevel.error) {
      e_ =  std::shared_ptr<Log>(new LogInstance(std::cerr, lockError, "[X]"));
    } else {
      e_ = std::shared_ptr<Log>(new Log());
    }
  }
  if (logsLevel_.warning != logsLevel.warning) {
    if (logsLevel.warning) {
      w_ =  std::shared_ptr<Log>(new LogInstance(std::cerr, lockError, "/!\\"));
    } else {
      w_ = std::shared_ptr<Log>(new Log());
    }
  }
  if (logsLevel_.info != logsLevel.info) {
    if (logsLevel.info) {
      i_ =  std::shared_ptr<Log>(new LogInstance(std::cout, lockOut, ""));
    } else {
      i_ = std::shared_ptr<Log>(new Log());
    }
  }
  if (logsLevel_.debug != logsLevel.debug) {
    if (logsLevel.debug) {
      d_ =  std::shared_ptr<Log>(new LogInstance(std::cout, lockOut, "** "));
    } else {
      d_ = std::shared_ptr<Log>(new Log());
    }
  }
  logsLevel_ = logsLevel;
}

void Logs::SetLevel(unsigned int logsLevel) {
  struct sLevel logsLevelStruct {0,0,0,0};
  if (logsLevel & 1) logsLevelStruct.error = 1;
  if (logsLevel & 2) logsLevelStruct.warning = 1;
  if (logsLevel & 4) logsLevelStruct.info = 1;
  if (logsLevel & 8) logsLevelStruct.debug = 1;
  SetLevel(logsLevelStruct);
}

unsigned int Logs::GetLevel() {
  unsigned int level = 0;
  if (logsLevel_.error) level += 1;
  if (logsLevel_.warning) level += 2;
  if (logsLevel_.info) level += 4;
  if (logsLevel_.debug) level += 8;
  return level;
}