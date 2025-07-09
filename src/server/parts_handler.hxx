#pragma once

#include <Poco/Net/PartHandler.h>
#include <Poco/Net/MessageHeader.h>
#include <unordered_map>

namespace ns_Server {

class PartsHandler : public Poco::Net::PartHandler {
public:
  struct PartData {
    std::string filename;
    std::string contentType;
    std::vector<uint8_t> content;
  };

  void handlePart(const Poco::Net::MessageHeader& header, std::istream& stream);
  std::unordered_multimap<std::string, struct PartData> const& GetParts() const;

private:
  std::unordered_multimap<std::string, PartData> parts_;
};

};