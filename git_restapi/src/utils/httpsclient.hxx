#pragma once

#include <string>
#include <unordered_map>
#include <Poco/Net/HTTPSClientSession.h>

class HTTPSClient {
public:
  HTTPSClient();
  ~HTTPSClient();
  bool Remote(std::string const& site);
  bool Close();
  bool Get(std::string const& path, std::string& result, 
    std::unordered_map<std::string, std::string>& headers);

private:
  Poco::Net::HTTPSClientSession* session_;
};
