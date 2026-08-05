/*
 * Launch a macOS development process without inheriting Terminal's TCC
 * responsibility. This lets Electron's Stella.app bundle own Accessibility,
 * Screen Recording, and Microphone permission prompts just like a packaged
 * launch. Packaged Stella does not use this helper.
 */

#include <dlfcn.h>
#include <errno.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;

typedef int (*disclaim_func_t)(posix_spawnattr_t *, int);

static volatile sig_atomic_t child_pid = 0;

static void forward_signal(int signal_number) {
    pid_t pid = (pid_t)child_pid;
    if (pid > 0) {
        kill(pid, signal_number);
    }
}

int main(int argc, char *argv[]) {
    if (argc < 2) {
        fprintf(stderr, "usage: disclaim-spawn <binary> [args...]\n");
        return 1;
    }

    posix_spawnattr_t attr;
    posix_spawnattr_init(&attr);

    sigset_t no_signals;
    sigemptyset(&no_signals);
    posix_spawnattr_setsigmask(&attr, &no_signals);

    sigset_t all_signals;
    sigfillset(&all_signals);
    posix_spawnattr_setsigdefault(&attr, &all_signals);

    short flags = POSIX_SPAWN_SETSIGMASK | POSIX_SPAWN_SETSIGDEF;
    posix_spawnattr_setflags(&attr, flags);

    disclaim_func_t disclaim_fn = (disclaim_func_t)dlsym(
        RTLD_DEFAULT,
        "responsibility_spawnattrs_setdisclaim"
    );
    if (disclaim_fn) {
        disclaim_fn(&attr, 1);
    }

    pid_t pid = 0;
    int result = posix_spawnp(&pid, argv[1], NULL, &attr, &argv[1], environ);
    posix_spawnattr_destroy(&attr);

    if (result != 0) {
        fprintf(stderr, "disclaim-spawn: posix_spawnp: %s\n", strerror(result));
        return result;
    }

    child_pid = pid;
    signal(SIGTERM, forward_signal);
    signal(SIGINT, forward_signal);
    signal(SIGHUP, forward_signal);

    int status;
    while (waitpid(pid, &status, 0) == -1) {
        if (errno != EINTR) {
            perror("disclaim-spawn: waitpid");
            return 1;
        }
    }

    if (WIFEXITED(status)) return WEXITSTATUS(status);
    if (WIFSIGNALED(status)) return 128 + WTERMSIG(status);
    return 1;
}
