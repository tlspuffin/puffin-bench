#include <Poco/JSON/Object.h>
#include <Poco/JSON/Stringifier.h>
#include <Poco/Net/HTTPRequestHandler.h>
#include <Poco/Net/HTTPServerResponse.h>
#include <Poco/Net/HTTPRequestHandlerFactory.h>
#include <Poco/Net/HTTPServerRequest.h>
#include <Poco/Net/HTTPServer.h>
#include <Poco/Net/ServerSocket.h>
#include <Poco/Util/ServerApplication.h>


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
  int main(const std::vector<std::string>&) override {
    Poco::Net::HTTPServer server(new RequestHandlerFactory(), 
        Poco::Net::ServerSocket(8080), new Poco::Net::HTTPServerParams);

    server.start();
    std::cout << "Server started on port 8080..." << std::endl;
    waitForTerminationRequest(); // CTRL-C
    server.stop();
    return 0;
  }
};

int main(int argc, char *argv[]) {
  MyServerApp app;
  return app.run(argc, argv);
}