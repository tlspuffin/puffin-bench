#pragma once

#include "config.hxx"
#include "../api/api.hxx"
#include <Poco/Util/ServerApplication.h>
#include <cstdint>

namespace Poco { namespace Net { class HTTPServer; } };

namespace ns_Server {

// Serving state of the HTTP server, reported by /api/health so that a saturated
// thread pool (which answers nothing and logs nothing) becomes visible.
struct HTTPStats {
  int threads_ = 0;
  int threadsMax_ = 0;
  int queued_ = 0;
  int connections_ = 0;
  int connectionsMax_ = 0;
  int refused_ = 0;
  int total_ = 0;
};

// Registered while the server runs, so that a request handler can read its counters.
void SetRunningServer(Poco::Net::HTTPServer* server);
bool GetHTTPStats(struct HTTPStats& stats);

class MyServerApp : public Poco::Util::ServerApplication {
public:
  MyServerApp(ns_Server::Config const& config, struct ns_API::APIS& apis);

  protected:
  int main(const std::vector<std::string>& args);

private:
  ns_Server::Config const& config_;
  struct ns_API::APIS& apis_;
};

};