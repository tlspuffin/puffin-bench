#include "scheduler/schedule/executor/files_ring.hxx"
#include <unistd.h>
#include <fcntl.h>
#include "utils/logs.hxx"

int main() {
  int p[2];
  int retval = pipe2(p, O_NONBLOCK);
  if (retval != 0) {
    LOGE("Pipe failed " << errno);
    return 1;
  }
  ns_Executor::FilesRing filesRing(128);
  filesRing.AddFD(p[0], "outfile.txt");
  for(uint8_t i=0; i<(128+64); ++i) {
    std::string buf = std::to_string(i);
    write(p[1], &(buf.c_str()[buf.size()-1]), 1);
  }
  fsync(p[1]);
  filesRing.RemoveFD(p[0]);

  return 0;
}