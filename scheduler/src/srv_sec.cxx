#include <Poco/Net/SecureServerSocket.h>
#include <Poco/Net/Context.h>

#include <Poco/JSON/Object.h>
#include <Poco/JSON/Stringifier.h>
#include <Poco/Net/HTTPRequestHandler.h>
#include <Poco/Net/HTTPServerResponse.h>
#include <Poco/Net/HTTPRequestHandlerFactory.h>
#include <Poco/Net/HTTPServerRequest.h>
#include <Poco/Net/HTTPServer.h>
#include <Poco/Net/ServerSocket.h>
#include <Poco/Util/ServerApplication.h>

#include <rapidjson/document.h>
#include <fstream>

#include "schedule.hxx"

//#define SEC_PATH "/home/olivier/Desktop/restsrv/security"
#define SEC_PATH "../security"
//#define TESTJSON "/home/olivier/Desktop/restsrv/experiment.json"
#define TESTJSON "../experiment.json"

class MyRequestHandler : public Poco::Net::HTTPRequestHandler {
public:
  void handleRequest(Poco::Net::HTTPServerRequest& request,
      Poco::Net::HTTPServerResponse& response) override;
};

void MyRequestHandler::handleRequest(Poco::Net::HTTPServerRequest& request,
    Poco::Net::HTTPServerResponse& response) {
  response.setChunkedTransferEncoding(true);
  response.setContentType("application/json");

  Poco::JSON::Object::Ptr json = new Poco::JSON::Object;
  json->set("message", "Hello, REST!");

  std::ostream& out = response.send();
  Poco::JSON::Stringifier::stringify(json, out);
}

class RequestHandlerFactory : public Poco::Net::HTTPRequestHandlerFactory {
public:
  Poco::Net::HTTPRequestHandler* createRequestHandler(
      const Poco::Net::HTTPServerRequest&) override;
};

Poco::Net::HTTPRequestHandler* RequestHandlerFactory::createRequestHandler(
    const Poco::Net::HTTPServerRequest& request) {
    
  if (request.getURI() == "/hello") {
    return new MyRequestHandler;
  } else {
    return nullptr;  // 404 Not Found
  }
}

class MyServerApp : public Poco::Util::ServerApplication {
protected:
  int main(const std::vector<std::string>& args) override {
    Poco::Net::Context::Ptr context = new Poco::Net::Context(
        Poco::Net::Context::SERVER_USE,
        SEC_PATH "/site.key", SEC_PATH "/site.pem", SEC_PATH "/CA.pem", // clé privée, cert, CA
        Poco::Net::Context::VERIFY_NONE
    );
    Poco::Net::HTTPServer server(new RequestHandlerFactory(), 
        Poco::Net::SecureServerSocket(8443, 64, context), new Poco::Net::HTTPServerParams);

    server.start();
    std::cout << "Server started on port 8443..." << std::endl;
    waitForTerminationRequest(); // CTRL-C
    server.stop();
    return 0;
  }
};

int main(int argc, char *argv[]) {

  Schedule schedule(4);
  schedule.AddJob(TESTJSON, std::vector<std::string>());

  MyServerApp app;
  return app.run(argc, argv);
}