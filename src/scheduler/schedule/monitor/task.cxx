#include "task.hxx"
#include "../step.hxx"
#include "../../utils/rapidjson.hxx"
#include "../../utils/logs.hxx"

ns_Monitor::Task::Task() : entryPoint_(), 
    delayStartS_("0"), timeoutS_("0"), intervalS_("0")
{}

ns_Monitor::Task::Task(ns_Schedule::Step const* step, rapidjson::Value const& json) 
    : Task()
{
  entryPoint_ = Get<std::string>(json, "entry_point");
  std::string value = Get<std::string>(json, "interval");
  intervalS_ = std::to_string(ParseDurationToSeconds(value));
  value = GetOrDefault<std::string>(json, "timeout", "0s");
  timeoutS_ = std::to_string(ParseDurationToSeconds(value));
  value = GetOrDefault<std::string>(json, "delay_start", "0ms");
  delayStartS_ = std::to_string(ParseDurationToSeconds(value));
}

void ns_Monitor::Task::ToJSON(rapidjson::Value& out, 
    rapidjson::Document::AllocatorType& alloc) const {
  out.AddMember("entry_point", 
      rapidjson::Value(entryPoint_.c_str(), alloc), alloc);
  out.AddMember("interval", 
      rapidjson::Value((intervalS_ + "s").c_str(), alloc), alloc);
  out.AddMember("timeout", 
      rapidjson::Value((timeoutS_ + "s").c_str(), alloc), alloc);
  out.AddMember("delay_start", 
      rapidjson::Value((delayStartS_ + "s").c_str(), alloc), alloc);
}
