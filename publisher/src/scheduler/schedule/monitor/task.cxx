#include "task.hxx"
#include "thread.hxx"
#include "../../utils/rapidjson.hxx"

ns_Monitor::Task::Task() : monitorFile(".monitor"), thread(nullptr),
    delayStartMS(0), timeoutS(0), intervalS(0)
{}

ns_Monitor::Task::Task(rapidjson::Value const& json) : Task()
{
  entryPoint = Get<std::string>(json, "entry_point");
  std::string value = Get<std::string>(json, "interval");
  intervalS = ParseDurationToSeconds(value);
  value = GetOrDefault<std::string>(json, "timeout", "0s");
  timeoutS = ParseDurationToSeconds(value);
  value = GetOrDefault<std::string>(json, "delay_start", "0ms");
  delayStartMS = ParseDurationToMilliSeconds(value);
}

void ns_Monitor::Task::ToJSON(rapidjson::Value& out, 
      rapidjson::Document::AllocatorType& alloc) const {
  out.AddMember("entry_point", 
      rapidjson::Value(entryPoint.c_str(), alloc), alloc);
  out.AddMember("interval", 
      rapidjson::Value((std::to_string(intervalS) + "s").c_str(), alloc), alloc);
  out.AddMember("timeout", 
      rapidjson::Value((std::to_string(timeoutS) + "s").c_str(), alloc), alloc);
  out.AddMember("delay_start", 
      rapidjson::Value((std::to_string(delayStartMS) + "ms").c_str(), alloc), alloc);
}
