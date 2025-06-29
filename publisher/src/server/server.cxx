#include "server.hxx"
#include "request_handler_factory.hxx"
#include <iostream>
#include <Poco/Net/HTTPServer.h>
#include <Poco/Net/SecureServerSocket.h>

ns_Server::MyServerApp::MyServerApp(ns_Server::Config const& config, 
    ns_API::ScheduleAPI& scheduleAPI) 
    : config_(config), scheduleAPI_(scheduleAPI)
{
}

int ns_Server::MyServerApp::main(const std::vector<std::string>& args) {
  Poco::Net::ServerSocket* serverSocket = nullptr;
  if (!config_.secure_) {
    serverSocket = new Poco::Net::ServerSocket(config_.port_);
  } else {
    Poco::Net::Context::Ptr context = new Poco::Net::Context(
        Poco::Net::Context::SERVER_USE,
        config_.key_, config_.cert_, config_.CA_, 
        Poco::Net::Context::VERIFY_NONE);
    serverSocket = new Poco::Net::SecureServerSocket(config_.port_, 64, context);
  }

  Poco::Net::HTTPServer server(new RequestHandlerFactory(config_, scheduleAPI_), 
      *serverSocket, new Poco::Net::HTTPServerParams);

  server.start();
  std::cout << "Server started on port " << config_.port_ << "..." << std::endl;
  waitForTerminationRequest();
  server.stop();
  return 0;
}
