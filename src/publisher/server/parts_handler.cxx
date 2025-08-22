#include "parts_handler.hxx"

std::unordered_multimap<std::string, struct ns_Server::PartsHandler::PartData> const& ns_Server::PartsHandler::GetParts() const {
  return parts_;
}

void ns_Server::PartsHandler::handlePart(const Poco::Net::MessageHeader& header, std::istream& stream) {
  std::string infos = header.get("Content-Disposition");
  Poco::Net::NameValueCollection infosList;
  std::string value;
  Poco::Net::MessageHeader::splitParameters(infos, value, infosList);

  std::string name = infosList.get("name", "");
  std::string filename = infosList.get("filename", "");
  std::string contentType = header.get("Content-Type", "");

  std::vector<uint8_t> buffer;
  char chunk[8192];
  while (stream.read(chunk, sizeof(chunk)) || stream.gcount() > 0) {
    buffer.insert(buffer.end(), chunk, chunk + stream.gcount());
  }

  parts_.insert(std::make_pair<>(name, PartData{filename, contentType, std::move(buffer)}));
}
