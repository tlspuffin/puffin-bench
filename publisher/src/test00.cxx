#include "publisher/publish/rule_campaign_summary.hxx"
#include "publisher/config.hxx"
#include "publisher/publish/publish.hxx"
#include <rapidjson/document.h>
#include <rapidjson/prettywriter.h>
#include "utils/dir.hxx"
#include <iostream>
#include <filesystem>

int main(int argc, char* argv[]) {
  /*std::cout << true << '\n';

  std::cout << IsSubDir("/hello/world", "/hello") << '\n';
  std::cout << IsSubDir("/hello", "/hello/world") << '\n';
  std::cout << IsSubDir("/hello/world", "/hello/world/series") << '\n';
  std::cout << IsSubDir("/hello/world/series", "/hello/world") << '\n';

  std::cout << IsSubDir("hello/world", "hello") << '\n';
  std::cout << IsSubDir("hello", "hello/world") << '\n';
  std::cout << IsSubDir("hello/world", "hello/world/series") << '\n';
  std::cout << IsSubDir("hello/world/series", "hello/world") << '\n';*/

#if 0
  std::filesystem::path outPath = "./";
  uint64_t timestamp = 0;
  std::string outFile;
  std::unordered_set<std::string> libsManaged;
  rapidjson::Document parameters;
  parameters.SetObject();
  const rapidjson::Value& constParameters = parameters;
  ns_Publish::RuleCampaignUseSummary object("name", "", "", "", constParameters.GetObject());
  //object.Apply("/data/home/olivier/Desktop/puffin-bench/1778687196962.zip", outPath, timestamp, outFile, libsManaged);
  //object.Apply("/data/home/olivier/Desktop/puffin-bench/1779456681004.zip", outPath, timestamp, outFile, libsManaged);
  ///object.Apply("/home/olivier/Desktop/analyze/Y/Campaign/olivier/test/1779456681004.zip", outPath, timestamp, outFile, libsManaged);
  ///object.Apply("/home/olivier/Desktop/analyze/Y/Campaign/olivier/mycamp/1779897425074.zip", outPath, timestamp, outFile, libsManaged);
  ///object.Apply("/home/olivier/Desktop/analyze/Y/PR/dcf9ff4e7caffbd35d6b83cfef6bac5b7f7efdc3/Perf/1776965401867.zip", outPath, timestamp, outFile, libsManaged);
  object.Apply("/home/olivier/Desktop/analyze/Y/Campaign/olivier/test01/1780319984878.zip", outPath, timestamp, outFile, libsManaged);

#endif


  Config c;
  c.Load("/home/olivier/Desktop/puffin-bench/build/publisher/publisher_config.json");
  //c.Validate(false);
  ns_Publish::Publish p(c.publish_);
  auto r = p.ProjectListCampaigns("Y");

  rapidjson::Document doc;
  doc.SetObject();
  rapidjson::Document::AllocatorType& allocator = doc.GetAllocator();

  for (const auto& [user, campaigns] : r) {
    rapidjson::Value user_obj(rapidjson::kObjectType);
    for (const auto& [campaign, tasks] : campaigns) {
      rapidjson::Value task_array(rapidjson::kArrayType);
      for (const auto& [task, file] : tasks) {
        rapidjson::Value file_obj(rapidjson::kObjectType);
        file_obj.AddMember(rapidjson::StringRef("task"), rapidjson::Value(task.c_str(), allocator), allocator);
        file_obj.AddMember(rapidjson::StringRef("file"), rapidjson::Value(file.c_str(), allocator), allocator);
        task_array.PushBack(file_obj, allocator);
      }
      rapidjson::Value campaign_key(campaign.c_str(), allocator);
      user_obj.AddMember(campaign_key, task_array, allocator);
    }
    rapidjson::Value user_key(user.c_str(), allocator);
    doc.AddMember(user_key, user_obj, allocator);
  }

  rapidjson::StringBuffer buffer;
  rapidjson::PrettyWriter<rapidjson::StringBuffer> writer(buffer);
  doc.Accept(writer);
  std::cout << buffer.GetString() << std::endl;

  return 0;
}
