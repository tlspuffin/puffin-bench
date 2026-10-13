#include "server.hxx"
#include "request_handler_factory.hxx"
#include <iostream>
#include <Poco/Net/HTTPServer.h>
#include <Poco/Timespan.h>
#include <Poco/ThreadPool.h>
#include <Poco/Net/SecureServerSocket.h>

ns_Server::MyServerApp::MyServerApp(ns_Server::Config const& config, 
    struct ns_API::APIS& apis) 
    : config_(config), apis_(apis)
{
}

int ns_Server::MyServerApp::main(const std::vector<std::string>& args) {
  Poco::Net::ServerSocket* serverSocket = nullptr;
  if (!config_.secure_) {
    serverSocket = new Poco::Net::ServerSocket();
  } else {
    Poco::Net::Context::Ptr context = new Poco::Net::Context(
        Poco::Net::Context::SERVER_USE,
        config_.key_, config_.cert_, config_.CA_, 
        Poco::Net::Context::VERIFY_NONE);
    serverSocket = new Poco::Net::SecureServerSocket(context);
  }

  Poco::Net::SocketAddress address(config_.port_);
  serverSocket->bind(address, true, false);
  serverSocket->listen(64);

  // Own pool, declared before the server so that it outlives it: its threads are joined before main() returns, so
  // that no request is still served while the publisher's objects are destroyed (the publisher once aborted when
  // stopped while a page was polling it). Keep-alive bounded: an open browser tab no longer pins a thread for 15 s.
  Poco::Net::HTTPServerParams::Ptr params = new Poco::Net::HTTPServerParams;
  params->setMaxThreads(64);
  params->setMaxQueued(256);
  params->setKeepAlive(true);
  params->setKeepAliveTimeout(Poco::Timespan(5, 0));
  params->setMaxKeepAliveRequests(100);
  Poco::ThreadPool threadPool(4, 64);

  Poco::Net::HTTPServer server(new RequestHandlerFactory(config_, apis_), 
      threadPool, *serverSocket, params);

  server.start();
  std::cout << "Server started on port " << config_.port_ << "..." << std::endl;
  waitForTerminationRequest();
  // close the open connections too, then wait for the requests being served
  server.stopAll(true);
  threadPool.joinAll();
  delete serverSocket;
  return 0;
}
