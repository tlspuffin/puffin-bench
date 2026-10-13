#include "server.hxx"
#include "request_handler_factory.hxx"
#include "../../utils/logs.hxx"
#include <iostream>
#include <atomic>
#include <Poco/Net/HTTPServer.h>
#include <Poco/Net/SecureServerSocket.h>
#include <Poco/ThreadPool.h>
#include <Poco/Timespan.h>

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

  // Poco's defaults are a 16-thread shared pool with unlimited 15 s keep-alive
  // connections: a few open bench tabs pinned every thread, after which connections
  // were queued and then refused without any answer or log line. Give the server its
  // own, larger pool and bound what one connection may hold.
  Poco::Net::HTTPServerParams::Ptr params = new Poco::Net::HTTPServerParams;
  params->setMaxThreads(config_.maxThreads_);
  params->setMaxQueued(config_.maxQueued_);
  params->setKeepAlive(true);
  params->setKeepAliveTimeout(Poco::Timespan(config_.keepAliveTimeout_, 0));
  params->setMaxKeepAliveRequests(config_.maxKeepAliveRequests_);

  // Declared before the server so that it outlives it.
  Poco::ThreadPool threadPool(4, config_.maxThreads_);

  Poco::Net::HTTPServer server(new RequestHandlerFactory(config_, apis_), 
      threadPool, *serverSocket, params);

  server.start();
  SetRunningServer(&server);
  LOGA << "Server started on port " << config_.port_ << " (max " << config_.maxThreads_ <<
      " threads, " << config_.maxQueued_ << " queued, keep-alive " <<
      config_.keepAliveTimeout_ << " s / " << config_.maxKeepAliveRequests_ <<
      " requests)..." << Log::Flags::End;
  waitForTerminationRequest();
  SetRunningServer(nullptr);
  // Close the open connections too: a plain stop() leaves keep-alive connections served, and the
  // pool's destructor then waits up to 10 s for each busy thread.
  server.stopAll(true);
  delete serverSocket;
  return 0;
}


namespace {
std::atomic<Poco::Net::HTTPServer*> runningServer__{nullptr};
};

void ns_Server::SetRunningServer(Poco::Net::HTTPServer* server) {
  runningServer__.store(server);
}

bool ns_Server::GetHTTPStats(struct ns_Server::HTTPStats& stats) {
  Poco::Net::HTTPServer* server = runningServer__.load();
  if (server == nullptr) {
    return false;
  }
  stats.threads_ = server->currentThreads();
  stats.threadsMax_ = server->maxThreads();
  stats.queued_ = server->queuedConnections();
  stats.connections_ = server->currentConnections();
  stats.connectionsMax_ = server->maxConcurrentConnections();
  stats.refused_ = server->refusedConnections();
  stats.total_ = server->totalConnections();
  return true;
}
