#include "scheduler/schedule/executor/files_ring.hxx"
#include <unistd.h>
#include <fcntl.h>
#include <thread>
#include <chrono>
#include <iostream>
#include "utils/logs.hxx"

int main() {
  int p[2];
  if (pipe(p) != 0) {
    std::cerr << "Pipe failed " << errno << '\n';
    return 1;
  }

  ns_Executor::FilesRing filesRing(16 * 1024 * 1024);
  filesRing.AddFD(p[0], "outfile.txt");

  auto start = std::chrono::steady_clock::now();
  uint64_t totalBytes = 0;

  uint8_t buf[65536];
  ssize_t n;
  while ((n = read(STDIN_FILENO, buf, sizeof(buf))) > 0) {
    ssize_t written = 0;
    while (written < n) {
      ssize_t w = write(p[1], buf + written, n - written);
      if (w < 0) {
        if (errno == EINTR) continue;
        break;
      }
      written += w;
    }
    totalBytes += n;
  }

  close(p[1]);
  filesRing.RemoveFD(p[0]);

  auto end = std::chrono::steady_clock::now();
  double seconds = std::chrono::duration<double>(end - start).count();
  std::cerr << totalBytes << " bytes en " << seconds << "s = "
            << (totalBytes / 1024.0 / 1024.0 / seconds) << " MB/s\n";

  return 0;
}