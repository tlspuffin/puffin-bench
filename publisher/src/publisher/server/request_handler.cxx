#include "request_handler.hxx"
#include "parts_handler.hxx"
#include "../../utils/logs.hxx"
#include <fstream>
#include <rapidjson/writer.h>
#include <rapidjson/ostreamwrapper.h>
#include <Poco/JSON/Object.h>
#include <Poco/JSON/Stringifier.h>
#include <Poco/Net/HTTPServerRequest.h>
#include <Poco/Base64Encoder.h>
#include <Poco/StreamCopier.h>
#include <Poco/URI.h>

static std::unordered_map<std::string, std::pair<std::string, std::ios_base::openmode>> 
    mimeType {
        {".html", {"text/html", std::ios_base::in}}, 
        {".css", {"text/css", std::ios_base::in}},
        {".json", {"application/json", std::ios_base::in}},
        {".js", {"text/javascript", std::ios_base::in}}, 
        {".jpg", {"image/jpeg", std::ios_base::binary}}, 
        {".jpeg", {"image/jpeg", std::ios_base::binary}}, 
        {".png", {"image/png", std::ios_base::binary}}, 
        {".svg", {"image/svg+xml", std::ios_base::in}}, 
    };

static bool ManageCORS(Poco::Net::HTTPServerRequest& request,
    Poco::Net::HTTPServerResponse& response) {
  response.set("Access-Control-Allow-Origin", "*");
  response.set("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS");
  response.set("Access-Control-Allow-Headers", "Content-Type");

  if (request.getMethod() == Poco::Net::HTTPRequest::HTTP_OPTIONS) {
    response.setStatus(Poco::Net::HTTPResponse::HTTP_OK);
    response.send();
    return true;
  }
  return false;
}

void ns_Server::RequestHandlerError::handleRequest(Poco::Net::HTTPServerRequest& request,
    Poco::Net::HTTPServerResponse& response) {
  response.setStatus(Poco::Net::HTTPResponse::HTTP_NOT_FOUND);
  response.setContentType("text/plain");
  response.send() << "404 - Path not found: " << request.getURI();
}

void ns_Server::RequestHandlerCORSOptions::handleRequest(Poco::Net::HTTPServerRequest& request,
    Poco::Net::HTTPServerResponse& response) {
  ManageCORS(request, response);
}

void ns_Server::RequestHandlerNotify::handleRequest(Poco::Net::HTTPServerRequest& request,
    Poco::Net::HTTPServerResponse& response) {
  if (ManageCORS(request, response)) {
    return;
  }

  response.setChunkedTransferEncoding(true);
  response.setContentType("application/json");
  response.set("Cache-Control", "no-store, no-cache, must-revalidate");
  response.set("Pragma", "no-cache");

  PartsHandler partsHandler;
  Poco::Net::HTMLForm form(request, request.stream(), partsHandler);
  std::unordered_multimap<std::string, ns_Server::PartsHandler::PartData> const& parts = 
      partsHandler.GetParts();

  std::ostream* out = nullptr;
  try {
    std::string error;
    std::string debugStr = "src: ";
    std::vector<std::filesystem::path> srcFiles;
    for (auto const& [key, value]: form) {
      if (key == "src") {
        srcFiles.push_back(value);
        debugStr += value + ", ";
      }
    }
    std::filesystem::path dstPath = form.get("dst", "");
    debugStr += "dst: " + dstPath.string();
    LOGI << " args= "+debugStr << Log::Flags::End;
    if (!apis_->publishAPI_.NotifyFiles(srcFiles, dstPath, error)) {
      throw std::runtime_error(error);
    }
    out = &(response.send());
    *out << R"({"success": true})";
    LOGI << "Notify success" << Log::Flags::End;
  } catch (std::exception const& e) {
    if (out == nullptr) {
      response.setStatus(Poco::Net::HTTPResponse::HTTP_INTERNAL_SERVER_ERROR);
      out = &(response.send());
    }
    *out << R"({"success": false, "error": ")" << e.what() << R"("})";
    LOGI << "Notify fail: " << e.what() << Log::Flags::End;
  }
  out->flush();
}

void ns_Server::RequestHandlerProjectListData::handleRequest(Poco::Net::HTTPServerRequest& request,
    Poco::Net::HTTPServerResponse& response) {
  if (ManageCORS(request, response)) {
    return;
  }

  response.setChunkedTransferEncoding(true);
  response.setContentType("application/json; charset=utf-8");
  response.set("Cache-Control", "no-store, no-cache, must-revalidate");
  response.set("Pragma", "no-cache");

  std::ostream* out = nullptr;
  try {
    std::string projectName = std::get<0>(args_);
    std::vector<std::string> list;
    apis_->publishAPI_.ProjectListData(projectName, list);
    out = &(response.send());
    bool gotType = false;
    std::stringstream oss;
    oss << R"({"success": true, "files": [)";
    for(auto const& file: list) {
      if (gotType) {
        oss << ", ";
      }
      gotType = true;
      oss << '\"' << file << '\"';
    }
    oss << "]}";
    *out << oss.str();
  } catch(std::exception const& e) {
    if (out == nullptr) {
      response.setContentType("application/json");
      response.setStatus(Poco::Net::HTTPResponse::HTTP_INTERNAL_SERVER_ERROR);
      out = &(response.send());
    }
    *out << R"({"success": false, "error": ")" << e.what() << R"("})";
  }
  out->flush();
}

void ns_Server::RequestHandlerProjectListCampaigns::handleRequest(Poco::Net::HTTPServerRequest& request,
    Poco::Net::HTTPServerResponse& response) {
  if (ManageCORS(request, response)) {
    return;
  }

  response.setChunkedTransferEncoding(true);
  response.setContentType("application/json; charset=utf-8");
  response.set("Cache-Control", "no-store, no-cache, must-revalidate");
  response.set("Pragma", "no-cache");

  std::ostream* out = nullptr;
  try {
    std::string projectName = std::get<0>(args_);
    auto campaignsList = apis_->publishAPI_.ProjectListCampaigns(projectName);

    rapidjson::Document doc;
    doc.SetObject();
    rapidjson::Document::AllocatorType& allocator = doc.GetAllocator();
    for (const auto& [user, campaigns] : campaignsList) {
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
    doc.AddMember("success", true, allocator);

    out = &(response.send());
    rapidjson::OStreamWrapper osw(*out);
    rapidjson::Writer<rapidjson::OStreamWrapper> writer(osw);
    doc.Accept(writer);
  } catch(std::exception const& e) {
    if (out == nullptr) {
      response.setContentType("application/json");
      response.setStatus(Poco::Net::HTTPResponse::HTTP_INTERNAL_SERVER_ERROR);
      out = &(response.send());
    }
    *out << R"({"success": false, "error": ")" << e.what() << R"("})";
  }
  out->flush();
}

void ns_Server::RequestHandlerFiles::handleRequest(Poco::Net::HTTPServerRequest& request,
    Poco::Net::HTTPServerResponse& response) {
  if (ManageCORS(request, response)) {
    return;
  }

  std::ostream* out = nullptr;
  try {
    std::filesystem::path rootPath = std::get<0>(args_);
    std::filesystem::path filePath = std::get<1>(args_);
    std::filesystem::path filename = rootPath / filePath;
    try {
      filename = std::filesystem::canonical(filename);
    } catch(...) {
      //detectHostileIP_.SetHostileIP(srcIP);
      response.setStatusAndReason(Poco::Net::HTTPResponse::HTTP_NOT_FOUND);
      response.send();
      return;
    }

    std::error_code ec;
    std::string relativePath = std::filesystem::relative(filename, rootPath, ec).string();
    if (ec || (relativePath.find("..") == 0)) {
      //detectHostileIP_.SetHostileIP(srcIP);
      response.setStatusAndReason(Poco::Net::HTTPResponse::HTTP_BAD_REQUEST);
      response.send();
      return;
    }

    std::string extension = filename.extension().string();

    std::string contentType = "application/octet-stream";
    std::ios_base::openmode openmode = std::ios_base::in;
    auto const& mimeTypeIT = mimeType.find(extension);
    if (mimeTypeIT != mimeType.end()) {
      contentType = mimeTypeIT->second.first;
      openmode = mimeTypeIT->second.second;
    }

    std::ifstream file(filename, openmode);
    if (!file.is_open()) {
      //detectHostileIP_.RecordFailedRequest(srcIP);
      //char cwd[4096] = {};
      //getcwd(cwd, 4096);
      ///LOGWARNING("[%s][%s] unable to access %s cwd: %s", GenerateHumanTS().c_str(), srcIP.c_str(), filename.c_str(), cwd);
      throw std::runtime_error("file open failed");
    }

    response.setContentType(contentType);
    response.setChunkedTransferEncoding(true);
    out = &response.send();
    Poco::StreamCopier::copyStream(file, *out);
    out->flush();
  } catch (std::exception const& e) {
    std::cerr << "File server error: " << e.what() << std::endl;
    if (out != nullptr) {
      out->flush();
    } else if (!response.sent()) {
      response.setStatus(Poco::Net::HTTPResponse::HTTP_INTERNAL_SERVER_ERROR);
      response.send();
    }
  }
}
