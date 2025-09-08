#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

static int sock_fd = -1;

static void on_signal(int sig) {
    if (sock_fd >= 0) {
        close(sock_fd);
        sock_fd = -1;
    }
    _exit(0);
}

static void Daemonize(void) {
  pid_t pid = fork();
  if (pid < 0) exit(EXIT_FAILURE);
  if (pid > 0) {
    printf("RESERVED_PORT_PID=%d\n", pid);
    fflush(stdout);
    exit(EXIT_SUCCESS);
  }

  int fd = open("/dev/null", O_RDWR);
  if (fd >= 0) {
    dup2(fd, STDIN_FILENO);
    dup2(fd, STDOUT_FILENO);
    dup2(fd, STDERR_FILENO);
    if (fd > 2) close(fd);
  }
}

int main(int argc, char **argv) {
  (void)argc;
  (void)argv;

  sock_fd = socket(AF_INET, SOCK_STREAM, 0);
  if (sock_fd < 0) {
    perror("socket");
    return 1;
  }

  int one = 1;
  if (setsockopt(sock_fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one)) < 0) {
    perror("setsockopt(SO_REUSEADDR)");
    return 1;
  }
  if (setsockopt(sock_fd, SOL_SOCKET, SO_REUSEPORT, &one, sizeof(one)) < 0) {
    perror("setsockopt(SO_REUSEPORT)");
    return 1;
  }

  struct sockaddr_in addr;
  memset(&addr, 0, sizeof(addr));
  addr.sin_family = AF_INET;
  addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  addr.sin_port = htons(0);

  if (bind(sock_fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
    perror("bind");
    return 1;
  }

  socklen_t len = sizeof(addr);
  if (getsockname(sock_fd, (struct sockaddr *)&addr, &len) < 0) {
    perror("getsockname");
    return 1;
  }
  int port = ntohs(addr.sin_port);

  printf("RESERVED_PORT=%d\n", port);
  fflush(stdout);

  struct sigaction sa;
  memset(&sa, 0, sizeof(sa));
  sa.sa_handler = on_signal;
  sigemptyset(&sa.sa_mask);
  sigaction(SIGTERM, &sa, NULL);
  sigaction(SIGINT,  &sa, NULL);
  sigaction(SIGHUP,  &sa, NULL);

  Daemonize();

  for (;;) {
    pause();
  }
}
