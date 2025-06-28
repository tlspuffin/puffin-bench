#include <signal.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>
#include <cstdio>

int main(int argc, char* argv[]) {
  pid_t pid = fork();
  if (pid == 0) {
    pid_t ssid = setsid();
    printf("%d\n", ssid);
    char* args[] = { "prg.sh", "arg0", "arg1", nullptr };
    execv("./test.sh", args);
    return 0;
  }
  sleep(10);
  int retval = kill(-pid, 0);
  if (retval == 0) {
    retval = kill(-pid, SIGTERM);
    printf("kill %d\n", retval);
  }
  int wstatus;
  pid_t wpid = wait(&wstatus);
  printf("%d %d\n", pid, wpid);
  
  return 0;
}
