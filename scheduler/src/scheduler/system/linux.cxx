#include "linux.hxx"

ns_System::Linux::Linux(uint64_t time_interval) : time_interval_(time_interval), 
    threadRunning_(true)
{
  cores_.Init();
  if (!ThreadWaitOrStop(2)) {
    return;
  }
  cores_.Update();
  memory_.Update();
  thread_ = std::thread(&Linux::ThreadLoop, this);
}

ns_System::Linux::~Linux() {
  threadRunning_.store(false);
  thread_.join();
}

void ns_System::Linux::GetLoad(CoreStats& global, std::vector<CoreStats>& perCores, 
      ns_System::Memory::MemoryStats& memory) {
  std::lock_guard lock(lock_);
  cores_.CoresValuesRatio(global, perCores);
  memory = memory_.Stats();
}

void ns_System::Linux::ThreadLoop() {
  while(true) {
    if (!ThreadWaitOrStop(time_interval_)) {
      return;
    }
    lock_.lock();

    cores_.Update();
    memory_.Update();

    lock_.unlock();
  }
}

bool ns_System::Linux::ThreadWaitOrStop(uint64_t wait_time_s) {
  for (uint64_t i=0; i<wait_time_s; ++i) {
    std::this_thread::sleep_for(std::chrono::seconds(1));
    if (!threadRunning_.load()) return false;
  }
  return true;
}