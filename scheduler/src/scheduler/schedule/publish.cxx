#include "publish.hxx"
#include "../../utils/rapidjson.hxx"
#include "../../utils/logs.hxx"
#include <memory>
#include <iostream>
#include <fstream>
#include <Poco/URI.h>
#include <Poco/Net/HTMLForm.h>
#include <Poco/Net/HTTPClientSession.h>
#include <Poco/Net/HTTPSClientSession.h>
#include <Poco/Net/HTTPRequest.h>
#include <Poco/Net/HTTPResponse.h>

ns_Schedule::Publish::Publish() 
    : baseURL_(), notifyEndpoint_(), viewEndpoint_(), rootStorage_(), storage_(), 
    checkServerCertificat_(false) 
{}

ns_Schedule::Publish::Publish(std::unordered_map<std::string, PublisherConfig> const& publishersConfig, 
    rapidjson::Value const& config) : Publish() {
  ReadJSON(publishersConfig, config);
}

void ns_Schedule::Publish::ReadJSON(std::unordered_map<std::string, PublisherConfig> const& publishersConfig, 
    rapidjson::Value const& config) {
  if (!config.IsObject()) {
    throw std::runtime_error("publish config should be an object");
  }

  goal_ = GetOrDefault<std::string>(config, "goal", "");

  std::string const server = GetOrDefault<std::string>(config, "server", "");
  checkServerCertificat_ = 
      GetOrDefault<bool>(config, "check_server_certificat", false);
  storage_  = std::filesystem::weakly_canonical(
      GetOrDefault<std::string>(config, "storage", ""));
  rootStorage_.clear();

  auto const& itConfig = publishersConfig.find(server);
  if (itConfig != publishersConfig.end()) {
    baseURL_ = itConfig->second.baseURL_;
    notifyEndpoint_ = itConfig->second.notifyEndpoint_;
    viewEndpoint_ = itConfig->second.viewEndpoint_;
    checkServerCertificat_ = itConfig->second.checkServerCertificat_;
    //storage_ = ResolveVariables(storage_, { {"PUBLISHER_STORAGE", itConfig->second.storage_} });
    //storage_ = storage_;
    rootStorage_ = itConfig->second.storage_;
  }
}

void ns_Schedule::Publish::ToJSON(rapidjson::Value& node, 
    rapidjson::Document::AllocatorType& alloc) const {
  node.AddMember("base_url", rapidjson::Value(baseURL_.c_str(), alloc), alloc);
  node.AddMember("notify_endpoint", rapidjson::Value(notifyEndpoint_.c_str(), alloc), alloc);
  node.AddMember("viewEndpoint_", rapidjson::Value(viewEndpoint_.c_str(), alloc), alloc);
  node.AddMember("check_server_certificat", checkServerCertificat_, alloc);
  node.AddMember("root_storage", rapidjson::Value(rootStorage_.c_str(), alloc), alloc);
  node.AddMember("storage", rapidjson::Value(storage_.c_str(), alloc), alloc);
  node.AddMember("goal", rapidjson::Value(goal_.c_str(), alloc), alloc);
}

void ns_Schedule::Publish::PublishResults(
    std::unordered_map<std::string, std::string> const& taskVariables, 
    std::filesystem::path const& taskJSONfile,
    std::vector<std::filesystem::path> const& data) {
  std::filesystem::path finalStoragePath = ResolveVariables(storage_, taskVariables);
  if (finalStoragePath.empty()) {
    LOGE << "Error: can not publish result, no storage provided" << Log::Flags::End;
    return;
  }
  if (rootStorage_.empty() ? finalStoragePath.is_relative() : rootStorage_.is_relative()) {
    LOGE << "Error: can not publish result, publish folder can not be computed from : " << 
        rootStorage_ << " / " << finalStoragePath << Log::Flags::End;
    return;
  }

  if (!rootStorage_.empty()) {
    finalStoragePath = rootStorage_ / finalStoragePath;
  }
  if (!finalStoragePath.empty()) {
    std::error_code ec;
    std::filesystem::create_directories(finalStoragePath, ec);
    if (ec) {
      LOGE << "Error: can not publish result, publish folder creation failed : " << 
          finalStoragePath << " : " << ec.message() << Log::Flags::End;
    }
    for(auto const& file: data) {
      std::filesystem::path destinationFile = finalStoragePath / file.filename();
      MoveFileAndCreateSymLink(file, destinationFile);
    }
    std::filesystem::path destinationFile = finalStoragePath / taskJSONfile.filename();
    MoveFileAndCreateSymLink(taskJSONfile, destinationFile);
  }

  if (baseURL_.empty()) {
    return;
  }
  try {
    std::vector<std::string> files;
    files.reserve(1+data.size());
    files.push_back(taskJSONfile);
    for (std::string const& file : data) {
      files.push_back(file);
    }
    PublishToServer(files, finalStoragePath);
  } catch(std::runtime_error const& e) {
    LOGW << "Error with publish server " << baseURL_ + notifyEndpoint_ << "\n\t" << e.what() << Log::Flags::End;
  } catch(...) {
    LOGW << "Unknown Error with publish server " << baseURL_ + notifyEndpoint_ << Log::Flags::End;
  }
}

void ns_Schedule::Publish::PublishToServer(std::vector<std::string> const& files, 
    std::string const& archivePath) {
  try {
    Poco::URI uri(baseURL_ + notifyEndpoint_);
    std::unique_ptr<Poco::Net::HTTPClientSession> session;
    if (uri.getScheme() == "https") {
      Poco::Net::Context::Ptr context = new Poco::Net::Context(
          Poco::Net::Context::CLIENT_USE,
          "", "", "",
          checkServerCertificat_ ? Poco::Net::Context::VERIFY_STRICT : Poco::Net::Context::VERIFY_NONE);
      std::unique_ptr<Poco::Net::HTTPSClientSession> httpsSession = 
          std::make_unique<Poco::Net::HTTPSClientSession>(
              uri.getHost(), uri.getPort() != 0 ? uri.getPort() : 443, context);
      session = std::move(httpsSession);
    } else {
      session = std::make_unique<Poco::Net::HTTPClientSession>(
          uri.getHost(), uri.getPort() != 0 ? uri.getPort() : 80);
    }
    session->setTimeout(Poco::Timespan(30, 0));

    std::string path = uri.getPath().empty() ? "/" : uri.getPath();
    Poco::Net::HTTPRequest request(Poco::Net::HTTPRequest::HTTP_POST, path);

    Poco::Net::HTMLForm form(Poco::Net::HTMLForm::ENCODING_MULTIPART);
    for (std::string const& src : files) {
      form.add("src", src);
    }
    form.set("dst", archivePath);
    form.prepareSubmit(request);

    LOGD << "Sending notify request to " << path << Log::Flags::End;
    std::ostream& requestStream = session->sendRequest(request);
    form.write(requestStream);
    requestStream.flush();

    Poco::Net::HTTPResponse response;
    std::istream& responseStream = session->receiveResponse(response);

    if (response.getStatus() != Poco::Net::HTTPResponse::HTTP_OK) {
      std::string responseBody;
      Poco::StreamCopier::copyToString(responseStream, responseBody);
      LOGW << "Notify report error " << responseBody << Log::Flags::End;
      throw std::runtime_error("Server returned status " + 
          std::to_string(response.getStatus()) + 
          ": " + responseBody);
    }
    LOGI << "Sending notify was successful" << Log::Flags::End;

  } catch (const Poco::Exception& e) {
    throw std::runtime_error("HTTP[S] request failed: " + e.displayText());
  }
}

bool ns_Schedule::Publish::MoveFileAndCreateSymLink(std::string const& source, 
    std::filesystem::path const& destination) {
  if (!std::filesystem::is_regular_file(source)) {
    return false;
  }

  if (access(destination.parent_path().string().c_str(), W_OK) != 0) {
    LOGE << "Unable to copy, not have write right in folder " << 
        destination.parent_path() << Log::Flags::End;
    return false;
  }

  std::error_code ec;
  std::filesystem::rename(source, destination, ec);
  if (ec) {
    ec.clear();

    static std::filesystem::copy_options const copyOptions = 
        std::filesystem::copy_options::overwrite_existing;
    std::string destinationTmp = destination.string() + ".tmp";
    std::filesystem::copy(source, destinationTmp, copyOptions, ec);
    if (ec) {
      LOGE << "Unable to copy " << source << " to " << destinationTmp << " :" << 
          ec.message() << Log::Flags::End;
      return false;
    }
    std::filesystem::rename(destinationTmp, destination, ec);
    if (ec) {
      LOGE << "Unable to rename " << destinationTmp << " to " << destination << 
          ec.message() << Log::Flags::End;
      std::filesystem::remove(destinationTmp, ec);
      return false;
    }
    std::filesystem::remove(source, ec);
    if (ec) {
      LOGE << "Unable to delete " << source << " : " << ec.message() <<
           Log::Flags::End;
      return false;
    }
  }

  std::filesystem::create_symlink(destination, source, ec);
  if (ec) {
    LOGE << "Unable to create a symlink " <<  source << " to " << destination << 
        " : " << ec.message() << Log::Flags::End;
    return false;
  }

  return true;
}

bool ns_Schedule::Publish::MoveDirectory(std::string const& source, std::string const& destination) {
  if (!std::filesystem::is_directory(source)) {
    return false;
  }

  std::error_code ec;
  std::filesystem::rename(source, destination, ec);
  if (!ec) {
    return true;
  }
  ec.clear();

  static std::filesystem::copy_options const copyOptions = 
      std::filesystem::copy_options::overwrite_existing |
      std::filesystem::copy_options::copy_symlinks |
      std::filesystem::copy_options::recursive;
  std::filesystem::copy(source, destination, copyOptions, ec);
  if (ec) {
    LOGE << "Unable to copy folder " << source << " to " << destination << " : " << 
        ec.message() << Log::Flags::End;
    return false;
  }
  std::filesystem::remove_all(source, ec);
  if (ec) {
    LOGE << "Unable to delete folder " << source << " : " << ec.message() << 
        Log::Flags::End;
    return false;
  }

  return true;
}
