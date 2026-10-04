/*
 * Stella's Linux launcher: installs Stella's runtimes and source, verifies the
 * signed tree, supervises Electron and rolls back to the last working version.
 * A port of launcher/macos (same contract, same install layout, same health
 * rules); see launcher-client.ts for Electron's side of the channel.
 *
 * Install root: $STELLA_LAUNCHER_ROOT, else $XDG_DATA_HOME/stella
 * (~/.local/share/stella):
 *   app/                  the checkout
 *   runtimes/bun-<v>/bun  pinned Bun (git is the system git on Linux)
 *   signing.pub, launcher-state.json, logs/{launcher,electron,install}.log
 *   bin/stella-launcher   the installed copy the .desktop entry runs
 *
 * Shells out to curl, tar/unzip and git; uses libcrypto for SHA-256 and
 * ECDSA P-256; keeps the signing key in the Secret Service (libsecret,
 * loaded at runtime) or a 0600 file; GTK3 for the progress and recovery
 * windows (headless runs log instead).
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <pthread.h>
#include <sched.h>
#include <signal.h>
#include <spawn.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#include <gtk/gtk.h>
#include <openssl/bio.h>
#include <openssl/evp.h>
#include <openssl/pem.h>
#include <openssl/x509.h>

#include "../common/mini_json.h"

extern char **environ;

/* ------------------------------------------------------------------ pins */

#define BUN_VERSION "1.4.0"
#define DEFAULT_BACKEND_URL "https://stella-v2-cloud-builder-prod.lolruuxi.workers.dev"
#define UPSTREAM_BRANCH "main"
#define UPSTREAM_REMOTE_NAME "stella-upstream"
#define KNOWN_GOOD_REF "refs/stella/known-good"
#define NOTES_REF "stella-signed"
#define RELAUNCH_EXIT_CODE 75
#define OUTPUT_LINES 40

typedef struct {
    const char *key;
    const char *url;
    const char *sha256;
    const char *member;
} Asset;

static const Asset BUN_ASSETS[] = {
    {"linux-x64", "https://github.com/oven-sh/bun/releases/download/bun-v1.4.0/bun-linux-x64.zip",
     "2d03fb5fb83ac8b567aca0a281b2ce1a1a19d488f56c2968d88c3f25e92fe452", "bun-linux-x64/bun"},
    {"linux-x64-baseline", "https://github.com/oven-sh/bun/releases/download/bun-v1.4.0/bun-linux-x64-baseline.zip",
     "184fb4595f0d401a217cf7c78c1bc430ba83314dab7a8b94805babbf7fa7097f", "bun-linux-x64-baseline/bun"},
    {"linux-arm64", "https://github.com/oven-sh/bun/releases/download/bun-v1.4.0/bun-linux-aarch64.zip",
     "4b1a332ee861983eb93bcfe6f770fff94e3e31b2c388bdaea3c8ed35e58eed0e", "bun-linux-aarch64/bun"},
};

static const char *platform_key(void) {
#if defined(__aarch64__)
    return "linux-arm64";
#else
    /* Bun's default x64 build needs AVX2. */
    __builtin_cpu_init();
    return __builtin_cpu_supports("avx2") ? "linux-x64" : "linux-x64-baseline";
#endif
}

/* -------------------------------------------------------------- utilities */

static char *xstrdup(const char *s) {
    char *d = strdup(s ? s : "");
    if (!d) abort();
    return d;
}

static char *xasprintf(const char *fmt, ...) {
    va_list ap;
    char *out = NULL;
    va_start(ap, fmt);
    if (vasprintf(&out, fmt, ap) < 0) abort();
    va_end(ap);
    return out;
}

static char *trim(char *s) {
    char *end;
    if (!s) return s;
    while (*s == ' ' || *s == '\n' || *s == '\r' || *s == '\t') s++;
    end = s + strlen(s);
    while (end > s && (end[-1] == ' ' || end[-1] == '\n' || end[-1] == '\r' || end[-1] == '\t')) *--end = 0;
    return s;
}

/* A malloc'd, trimmed copy. */
static char *trimmed(const char *s) {
    char *copy = xstrdup(s);
    char *t = trim(copy);
    char *out = xstrdup(t);
    free(copy);
    return out;
}

static int file_exists(const char *path) {
    struct stat st;
    return stat(path, &st) == 0;
}

static int is_executable(const char *path) {
    struct stat st;
    return stat(path, &st) == 0 && S_ISREG(st.st_mode) && access(path, X_OK) == 0;
}

static int mkdirs(const char *path, mode_t mode) {
    char *copy = xstrdup(path);
    char *p;
    for (p = copy + 1; *p; p++) {
        if (*p == '/') {
            *p = 0;
            if (mkdir(copy, mode) != 0 && errno != EEXIST) { free(copy); return -1; }
            *p = '/';
        }
    }
    if (mkdir(copy, mode) != 0 && errno != EEXIST) { free(copy); return -1; }
    free(copy);
    return 0;
}

static char *read_file(const char *path, size_t *len_out) {
    FILE *f = fopen(path, "rb");
    char *buf = NULL;
    size_t len = 0, cap = 0, n;
    if (!f) return NULL;
    for (;;) {
        if (cap - len < 65536) {
            cap = cap ? cap * 2 : 65536;
            buf = realloc(buf, cap + 1);
            if (!buf) abort();
        }
        n = fread(buf + len, 1, cap - len, f);
        len += n;
        if (n == 0) break;
    }
    fclose(f);
    buf[len] = 0;
    if (len_out) *len_out = len;
    return buf;
}

/* Write via a temp file and rename, so readers never see half a file. */
static int write_file_atomic(const char *path, const char *data, size_t len, mode_t mode) {
    char *tmp = xasprintf("%s.tmp-%d", path, (int)getpid());
    int fd = open(tmp, O_CREAT | O_TRUNC | O_WRONLY | O_CLOEXEC, mode);
    size_t off = 0;
    if (fd < 0) { free(tmp); return -1; }
    while (off < len) {
        ssize_t w = write(fd, data + off, len - off);
        if (w <= 0) { close(fd); unlink(tmp); free(tmp); return -1; }
        off += (size_t)w;
    }
    fchmod(fd, mode);
    close(fd);
    if (rename(tmp, path) != 0) { unlink(tmp); free(tmp); return -1; }
    free(tmp);
    return 0;
}

static int copy_file(const char *from, const char *to, mode_t mode) {
    size_t len;
    char *data = read_file(from, &len);
    int rc;
    if (!data) return -1;
    rc = write_file_atomic(to, data, len, mode);
    free(data);
    return rc;
}

static int remove_tree(const char *path) {
    char *argv[] = {"rm", "-rf", (char *)path, NULL};
    pid_t pid;
    int status = 0;
    if (!file_exists(path)) return 0;
    if (posix_spawnp(&pid, "rm", NULL, NULL, argv, environ) != 0) return -1;
    while (waitpid(pid, &status, 0) < 0 && errno == EINTR) {}
    return WIFEXITED(status) && WEXITSTATUS(status) == 0 ? 0 : -1;
}

static double now_seconds(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (double)ts.tv_sec + (double)ts.tv_nsec / 1e9;
}

static char *iso_now(void) {
    struct timeval tv;
    struct tm tm;
    char buf[64];
    gettimeofday(&tv, NULL);
    gmtime_r(&tv.tv_sec, &tm);
    strftime(buf, sizeof(buf), "%Y-%m-%dT%H:%M:%S", &tm);
    return xasprintf("%s.%03dZ", buf, (int)(tv.tv_usec / 1000));
}

/* Dynamic NULL-terminated string arrays (argv, envp). */
typedef struct {
    char **items;
    size_t count, cap;
} StrList;

static void sl_push(StrList *l, const char *s) {
    if (l->count + 2 > l->cap) {
        l->cap = l->cap ? l->cap * 2 : 16;
        l->items = realloc(l->items, l->cap * sizeof(char *));
        if (!l->items) abort();
    }
    l->items[l->count++] = xstrdup(s);
    l->items[l->count] = NULL;
}

static void sl_free(StrList *l) {
    size_t i;
    for (i = 0; i < l->count; i++) free(l->items[i]);
    free(l->items);
    memset(l, 0, sizeof(*l));
}

static const char *env_get(const StrList *env, const char *key) {
    size_t klen = strlen(key), i;
    for (i = 0; i < env->count; i++)
        if (strncmp(env->items[i], key, klen) == 0 && env->items[i][klen] == '=') return env->items[i] + klen + 1;
    return NULL;
}

static void env_unset(StrList *env, const char *key) {
    size_t klen = strlen(key), i;
    for (i = 0; i < env->count;) {
        if (strncmp(env->items[i], key, klen) == 0 && env->items[i][klen] == '=') {
            free(env->items[i]);
            memmove(&env->items[i], &env->items[i + 1], (env->count - i) * sizeof(char *));
            env->count--;
        } else {
            i++;
        }
    }
}

static void env_set(StrList *env, const char *key, const char *value) {
    char *entry = xasprintf("%s=%s", key, value);
    env_unset(env, key);
    sl_push(env, entry);
    free(entry);
}

/* ------------------------------------------------------------------- log */

static pthread_mutex_t log_lock = PTHREAD_MUTEX_INITIALIZER;
static FILE *log_file;

static void logf_(const char *fmt, ...) {
    va_list ap;
    char *msg, *stamp;
    va_start(ap, fmt);
    if (vasprintf(&msg, fmt, ap) < 0) abort();
    va_end(ap);
    stamp = iso_now();
    pthread_mutex_lock(&log_lock);
    if (log_file) { fprintf(log_file, "%s %s\n", stamp, msg); fflush(log_file); }
    fprintf(stderr, "%s %s\n", stamp, msg);
    pthread_mutex_unlock(&log_lock);
    free(stamp);
    free(msg);
}
#define LOG(...) logf_(__VA_ARGS__)

/* The last error, set by any function that returns failure. One worker thread
 * does all the launcher work, so a plain global is enough. */
static char *g_error;
static void set_error(const char *fmt, ...) {
    va_list ap;
    char *msg;
    va_start(ap, fmt);
    if (vasprintf(&msg, fmt, ap) < 0) abort();
    va_end(ap);
    free(g_error);
    g_error = msg;
}
static const char *last_error(void) { return g_error ? g_error : "unknown error"; }

/* ----------------------------------------------------------------- paths */

typedef struct {
    char *root;
    int isolated;
    char *app, *runtimes, *logs, *launcher_log, *electron_log, *install_log;
    char *signing_pub, *state_file, *lock_file, *isolated_user_data, *isolated_home, *bin_dir;
} Paths;

static Paths P;

static void paths_resolve(void) {
    const char *raw = getenv("STELLA_LAUNCHER_ROOT");
    char *t = raw ? trimmed(raw) : xstrdup("");
    if (*t) {
        char resolved[PATH_MAX];
        if (t[0] == '~' && getenv("HOME")) {
            char *e = xasprintf("%s%s", getenv("HOME"), t + 1);
            free(t);
            t = e;
        }
        mkdirs(t, 0700);
        P.root = xstrdup(realpath(t, resolved) ? resolved : t);
        P.isolated = 1;
    } else {
        const char *xdg = getenv("XDG_DATA_HOME");
        if (xdg && *xdg) P.root = xasprintf("%s/stella", xdg);
        else P.root = xasprintf("%s/.local/share/stella", getenv("HOME") ? getenv("HOME") : "/tmp");
    }
    free(t);
    P.app = xasprintf("%s/app", P.root);
    P.runtimes = xasprintf("%s/runtimes", P.root);
    P.logs = xasprintf("%s/logs", P.root);
    P.launcher_log = xasprintf("%s/launcher.log", P.logs);
    P.electron_log = xasprintf("%s/electron.log", P.logs);
    P.install_log = xasprintf("%s/install.log", P.logs);
    P.signing_pub = xasprintf("%s/signing.pub", P.root);
    P.state_file = xasprintf("%s/launcher-state.json", P.root);
    P.lock_file = xasprintf("%s/launcher.lock", P.root);
    P.isolated_user_data = xasprintf("%s/user-data", P.root);
    P.isolated_home = xasprintf("%s/stella-home", P.root);
    P.bin_dir = xasprintf("%s/bin", P.root);
}

/* ----------------------------------------------------------------- state */

typedef struct {
    char *bun_lock_hash;   /* sha256 of app/bun.lock at the last successful bun install */
    char *prepared_head;   /* HEAD at the last successful prepare-install.mjs */
    char *installed_at;
    char *key_store;       /* "secret" or "file": where the signing key lives */
} State;

static State S;

static void state_load(void) {
    char *data = read_file(P.state_file, NULL);
    mj_value *json = data ? mj_parse(data, strlen(data)) : NULL;
    const char *v;
    memset(&S, 0, sizeof(S));
    if (json) {
        if ((v = mj_get_string(json, "bunLockHash"))) S.bun_lock_hash = xstrdup(v);
        if ((v = mj_get_string(json, "preparedHead"))) S.prepared_head = xstrdup(v);
        if ((v = mj_get_string(json, "installedAt"))) S.installed_at = xstrdup(v);
        if ((v = mj_get_string(json, "keyStore"))) S.key_store = xstrdup(v);
    }
    mj_free(json);
    free(data);
}

static void state_save(void) {
    const char *names[] = {"bunLockHash", "installedAt", "keyStore", "preparedHead"};
    const char *values[] = {S.bun_lock_hash, S.installed_at, S.key_store, S.prepared_head};
    char *out = xstrdup("{");
    int first = 1;
    size_t i;
    for (i = 0; i < 4; i++) {
        char *q, *next;
        if (!values[i]) continue;
        q = mj_quote(values[i]);
        next = xasprintf("%s%s\n  \"%s\" : %s", out, first ? "" : ",", names[i], q);
        free(q);
        free(out);
        out = next;
        first = 0;
    }
    {
        char *next = xasprintf("%s\n}\n", out);
        free(out);
        out = next;
    }
    write_file_atomic(P.state_file, out, strlen(out), 0644);
    free(out);
}

static void state_reset_install(void) {
    char *key_store = S.key_store;
    free(S.bun_lock_hash);
    free(S.prepared_head);
    free(S.installed_at);
    memset(&S, 0, sizeof(S));
    S.key_store = key_store;
    S.installed_at = iso_now();
    state_save();
}

/* --------------------------------------------------------------- options */

typedef enum { CHOICE_NONE, CHOICE_RETURN, CHOICE_REINSTALL, CHOICE_RETRY, CHOICE_QUIT } Choice;

static const char *choice_name(Choice c) {
    switch (c) {
    case CHOICE_RETURN: return "return";
    case CHOICE_REINSTALL: return "reinstall";
    case CHOICE_RETRY: return "retry";
    case CHOICE_QUIT: return "quit";
    default: return "none";
    }
}

static double env_seconds(const char *name, double fallback) {
    const char *raw = getenv(name);
    double v;
    if (!raw || !*raw) return fallback;
    v = strtod(raw, NULL);
    return v > 0 ? v : fallback;
}

typedef struct {
    int self_test;
    char *source;        /* a local path or git URL instead of the upstream bootstrap */
    char *source_ref;
    char *backend;
    char *local_bun;     /* adopt this Bun instead of downloading */
    double hold;         /* self-test: stay up this long after ready */
    Choice recovery_choice;
    char *capture_dir;   /* save PNGs of the launcher's own windows here */
    double ready_timeout;
    double stable_seconds;
} Options;

static Options O;

static const char *USAGE =
    "usage: stella-launcher [--self-test] [--source <path|git url>] [--source-ref <ref>]\n"
    "                       [--backend <url>] [--bun <path>] [--hold <seconds>]\n"
    "                       [--recovery-choice return|retry|quit] [--capture-dir <dir>]\n"
    "\n"
    "Environment: STELLA_LAUNCHER_ROOT (install root, for testing),\n"
    "STELLA_LAUNCHER_KEY_FILE (0600 PEM instead of the Secret Service),\n"
    "STELLA_LAUNCHER_BACKEND_URL, STELLA_LAUNCHER_STABLE_SECONDS,\n"
    "STELLA_LAUNCHER_READY_TIMEOUT_SECONDS, STELLA_LAUNCHER_PREPARE_TIMEOUT_SECONDS.\n";

static void parse_options(int argc, char **argv) {
    int i;
    const char *backend = getenv("STELLA_LAUNCHER_BACKEND_URL");
    O.backend = xstrdup(backend && *backend ? backend : DEFAULT_BACKEND_URL);
    O.ready_timeout = env_seconds("STELLA_LAUNCHER_READY_TIMEOUT_SECONDS", 90);
    O.stable_seconds = env_seconds("STELLA_LAUNCHER_STABLE_SECONDS", 60);
    for (i = 1; i < argc; i++) {
        const char *a = argv[i];
#define VALUE() (i + 1 < argc ? argv[++i] : (fprintf(stderr, "%s needs a value\n%s", a, USAGE), exit(64), (char *)NULL))
        if (!strcmp(a, "--self-test")) O.self_test = 1;
        else if (!strcmp(a, "--source")) O.source = xstrdup(VALUE());
        else if (!strcmp(a, "--source-ref")) O.source_ref = xstrdup(VALUE());
        else if (!strcmp(a, "--backend")) { free(O.backend); O.backend = xstrdup(VALUE()); }
        else if (!strcmp(a, "--bun")) O.local_bun = xstrdup(VALUE());
        else if (!strcmp(a, "--hold")) O.hold = strtod(VALUE(), NULL);
        else if (!strcmp(a, "--capture-dir")) O.capture_dir = xstrdup(VALUE());
        else if (!strcmp(a, "--recovery-choice")) {
            const char *v = VALUE();
            if (!strcmp(v, "return")) O.recovery_choice = CHOICE_RETURN;
            else if (!strcmp(v, "retry")) O.recovery_choice = CHOICE_RETRY;
            else if (!strcmp(v, "quit")) O.recovery_choice = CHOICE_QUIT;
            else { fprintf(stderr, "unknown recovery choice\n"); exit(64); }
        } else if (!strcmp(a, "-h") || !strcmp(a, "--help")) { fputs(USAGE, stdout); exit(0); }
        else LOG("launcher: ignoring argument %s", a);
#undef VALUE
    }
}

/* ----------------------------------------------------------------- shell */

typedef struct {
    int code;        /* exit status, or -1 when killed by a signal */
    char *out;
    char *err;       /* with an output file: that file's tail */
    int timed_out;
} CmdResult;

static void cmd_free(CmdResult *r) {
    free(r->out);
    free(r->err);
    memset(r, 0, sizeof(*r));
}

static char *file_tail(const char *path, long bytes) {
    FILE *f = fopen(path, "rb");
    char *buf;
    long size, start;
    size_t n;
    if (!f) return xstrdup("");
    fseek(f, 0, SEEK_END);
    size = ftell(f);
    start = size > bytes ? size - bytes : 0;
    fseek(f, start, SEEK_SET);
    buf = malloc((size_t)(size - start) + 1);
    n = fread(buf, 1, (size_t)(size - start), f);
    buf[n] = 0;
    fclose(f);
    return buf;
}

static void append_buf(char **buf, size_t *len, const char *data, size_t n) {
    *buf = realloc(*buf, *len + n + 1);
    if (!*buf) abort();
    memcpy(*buf + *len, data, n);
    *len += n;
    (*buf)[*len] = 0;
}

/*
 * Run a program without a shell (PATH lookup for bare names). With
 * output_file, stdout and stderr are appended there (long installs whose
 * grandchildren might hold a pipe open). With timeout > 0, the child's whole
 * process group is killed when it passes. Returns -1 only when the program
 * couldn't be started.
 */
static int run_cmd(char *const argv[], const char *cwd, char *const envp[], const char *output_file,
                   double timeout, CmdResult *r) {
    posix_spawn_file_actions_t fa;
    posix_spawnattr_t attr;
    sigset_t none, all;
    int outp[2] = {-1, -1}, errp[2] = {-1, -1}, logfd = -1, rc, status = 0;
    pid_t pid;
    size_t out_len = 0, err_len = 0;
    double deadline = timeout > 0 ? now_seconds() + timeout : 0;

    memset(r, 0, sizeof(*r));
    r->out = xstrdup("");
    r->err = xstrdup("");
    posix_spawn_file_actions_init(&fa);
    posix_spawn_file_actions_addopen(&fa, 0, "/dev/null", O_RDONLY, 0);
    if (output_file) {
        logfd = open(output_file, O_CREAT | O_APPEND | O_WRONLY | O_CLOEXEC, 0644);
        if (logfd >= 0) {
            size_t i;
            dprintf(logfd, "\n$");
            for (i = 0; argv[i]; i++) dprintf(logfd, " %s", argv[i]);
            dprintf(logfd, "\n");
            posix_spawn_file_actions_adddup2(&fa, logfd, 1);
            posix_spawn_file_actions_adddup2(&fa, logfd, 2);
        }
    } else {
        if (pipe2(outp, O_CLOEXEC) != 0 || pipe2(errp, O_CLOEXEC) != 0) {
            set_error("pipe: %s", strerror(errno));
            posix_spawn_file_actions_destroy(&fa);
            return -1;
        }
        posix_spawn_file_actions_adddup2(&fa, outp[1], 1);
        posix_spawn_file_actions_adddup2(&fa, errp[1], 2);
    }
    if (cwd) posix_spawn_file_actions_addchdir_np(&fa, cwd);
    posix_spawnattr_init(&attr);
    sigemptyset(&none);
    sigfillset(&all);
    posix_spawnattr_setsigmask(&attr, &none);
    posix_spawnattr_setsigdefault(&attr, &all);
    posix_spawnattr_setpgroup(&attr, 0);
    posix_spawnattr_setflags(&attr, POSIX_SPAWN_SETSIGMASK | POSIX_SPAWN_SETSIGDEF | POSIX_SPAWN_SETPGROUP);

    if (strchr(argv[0], '/')) rc = posix_spawn(&pid, argv[0], &fa, &attr, argv, envp);
    else rc = posix_spawnp(&pid, argv[0], &fa, &attr, argv, envp);
    posix_spawn_file_actions_destroy(&fa);
    posix_spawnattr_destroy(&attr);
    if (logfd >= 0) close(logfd);
    if (outp[1] >= 0) close(outp[1]);
    if (errp[1] >= 0) close(errp[1]);
    if (rc != 0) {
        if (outp[0] >= 0) close(outp[0]);
        if (errp[0] >= 0) close(errp[0]);
        set_error("could not run %s: %s", argv[0], strerror(rc));
        return -1;
    }

    for (;;) {
        struct pollfd fds[2];
        int nfds = 0, wait_ms = 200;
        char buf[16384];
        pid_t w;
        if (outp[0] >= 0) { fds[nfds].fd = outp[0]; fds[nfds].events = POLLIN; nfds++; }
        if (errp[0] >= 0) { fds[nfds].fd = errp[0]; fds[nfds].events = POLLIN; nfds++; }
        if (nfds > 0) {
            int i;
            if (poll(fds, (nfds_t)nfds, wait_ms) > 0) {
                for (i = 0; i < nfds; i++) {
                    ssize_t n;
                    if (!(fds[i].revents & (POLLIN | POLLHUP | POLLERR))) continue;
                    n = read(fds[i].fd, buf, sizeof(buf));
                    if (n > 0) {
                        if (fds[i].fd == outp[0]) append_buf(&r->out, &out_len, buf, (size_t)n);
                        else append_buf(&r->err, &err_len, buf, (size_t)n);
                    } else if (n == 0 || (n < 0 && errno != EINTR && errno != EAGAIN)) {
                        if (fds[i].fd == outp[0]) { close(outp[0]); outp[0] = -1; }
                        else { close(errp[0]); errp[0] = -1; }
                    }
                }
            }
        } else {
            usleep(100 * 1000);
        }
        w = waitpid(pid, &status, WNOHANG);
        if (w == pid && outp[0] < 0 && errp[0] < 0) break;
        if (w == pid) {
            /* Exited; drain what's left without waiting on grandchildren. */
            int i;
            for (i = 0; i < 2; i++) {
                int *fd = i == 0 ? &outp[0] : &errp[0];
                if (*fd < 0) continue;
                fcntl(*fd, F_SETFL, O_NONBLOCK);
                for (;;) {
                    ssize_t n = read(*fd, buf, sizeof(buf));
                    if (n <= 0) break;
                    if (i == 0) append_buf(&r->out, &out_len, buf, (size_t)n);
                    else append_buf(&r->err, &err_len, buf, (size_t)n);
                }
                close(*fd);
                *fd = -1;
            }
            break;
        }
        if (deadline > 0 && now_seconds() > deadline) {
            LOG("shell: %s exceeded %ds; killing its process group", argv[0], (int)timeout);
            kill(-pid, SIGKILL);
            kill(pid, SIGKILL);
            r->timed_out = 1;
            deadline = 0;
        }
    }
    r->code = WIFEXITED(status) ? WEXITSTATUS(status) : -1;
    if (output_file) {
        free(r->err);
        r->err = file_tail(output_file, 4000);
    }
    return 0;
}

static char *last_lines(const char *text, int count) {
    const char *p = text + strlen(text);
    int seen = 0;
    while (p > text) {
        p--;
        if (*p == '\n' && p[1] && ++seen >= count) { p++; break; }
    }
    return xstrdup(p);
}

/* The absolute path of `name` on PATH, or NULL. */
static char *which(const char *name) {
    const char *path = getenv("PATH");
    char *copy, *dir, *save = NULL, *found = NULL;
    if (!path || !*path) path = "/usr/local/bin:/usr/bin:/bin";
    copy = xstrdup(path);
    for (dir = strtok_r(copy, ":", &save); dir; dir = strtok_r(NULL, ":", &save)) {
        char *candidate = xasprintf("%s/%s", *dir ? dir : ".", name);
        if (is_executable(candidate)) { found = candidate; break; }
        free(candidate);
    }
    free(copy);
    return found;
}

/* ---------------------------------------------------------------- crypto */

static char *sha256_file(const char *path) {
    FILE *f = fopen(path, "rb");
    EVP_MD_CTX *ctx;
    unsigned char buf[1 << 16], md[32];
    unsigned int mdlen = 0;
    size_t n;
    char *hex;
    int i;
    if (!f) { set_error("cannot read %s: %s", path, strerror(errno)); return NULL; }
    ctx = EVP_MD_CTX_new();
    EVP_DigestInit_ex(ctx, EVP_sha256(), NULL);
    while ((n = fread(buf, 1, sizeof(buf), f)) > 0) EVP_DigestUpdate(ctx, buf, n);
    fclose(f);
    EVP_DigestFinal_ex(ctx, md, &mdlen);
    EVP_MD_CTX_free(ctx);
    hex = malloc(65);
    for (i = 0; i < 32; i++) sprintf(hex + i * 2, "%02x", md[i]);
    hex[64] = 0;
    return hex;
}

static char *base64_encode(const unsigned char *data, size_t len) {
    char *out = malloc(4 * ((len + 2) / 3) + 1);
    EVP_EncodeBlock((unsigned char *)out, data, (int)len);
    return out;
}

static unsigned char *base64_decode(const char *text, size_t *len_out) {
    char *clean = trimmed(text);
    size_t len = strlen(clean), pad = 0;
    unsigned char *out;
    int n;
    if (len == 0 || len % 4 != 0) { free(clean); return NULL; }
    out = malloc(len / 4 * 3 + 1);
    n = EVP_DecodeBlock(out, (const unsigned char *)clean, (int)len);
    if (n < 0) { free(out); free(clean); return NULL; }
    if (clean[len - 1] == '=') pad++;
    if (clean[len - 2] == '=') pad++;
    free(clean);
    *len_out = (size_t)n - pad;
    return out;
}

/* --------------------------------------------------- secret service (dlopen) */

/* The parts of libsecret's ABI the launcher uses (stable since 0.18). */
typedef struct { const char *name; int type; } LsSchemaAttribute;
typedef struct {
    const char *name;
    int flags;
    LsSchemaAttribute attributes[32];
    int reserved;
    void *reserved1, *reserved2, *reserved3, *reserved4, *reserved5, *reserved6, *reserved7;
} LsSchema;

typedef int (*ls_store_fn)(const LsSchema *, const char *, const char *, const char *, void *, GError **, ...);
typedef char *(*ls_lookup_fn)(const LsSchema *, void *, GError **, ...);
typedef void (*ls_free_fn)(char *);

static const LsSchema SIGNING_SCHEMA = {
    "sh.stella.launcher.TreeSigning", 0, {{"service", 0}, {"account", 0}, {NULL, 0}}, 0,
    NULL, NULL, NULL, NULL, NULL, NULL, NULL};
#define SECRET_SERVICE_ID "sh.stella.launcher.tree-signing"
#define SECRET_ACCOUNT "p256"

static void *libsecret(void) {
    static void *handle;
    static int tried;
    if (!tried) {
        tried = 1;
        handle = dlopen("libsecret-1.so.0", RTLD_NOW | RTLD_LOCAL);
    }
    return handle;
}

/* 1 found (*pem set), 0 not found, -1 the Secret Service is unavailable. */
static int secret_lookup(char **pem) {
    void *h = libsecret();
    ls_lookup_fn lookup;
    ls_free_fn free_fn;
    GError *error = NULL;
    char *value;
    if (!h) { set_error("libsecret is not installed"); return -1; }
    lookup = (ls_lookup_fn)dlsym(h, "secret_password_lookup_sync");
    free_fn = (ls_free_fn)dlsym(h, "secret_password_free");
    if (!lookup || !free_fn) { set_error("libsecret is missing secret_password_lookup_sync"); return -1; }
    value = lookup(&SIGNING_SCHEMA, NULL, &error, "service", SECRET_SERVICE_ID, "account", SECRET_ACCOUNT, NULL);
    if (error) {
        set_error("the Secret Service is unavailable: %s", error->message);
        g_error_free(error);
        return -1;
    }
    if (!value) return 0;
    *pem = xstrdup(value);
    free_fn(value);
    return 1;
}

static int secret_store(const char *pem) {
    void *h = libsecret();
    ls_store_fn store;
    GError *error = NULL;
    if (!h) { set_error("libsecret is not installed"); return -1; }
    store = (ls_store_fn)dlsym(h, "secret_password_store_sync");
    if (!store) { set_error("libsecret is missing secret_password_store_sync"); return -1; }
    if (!store(&SIGNING_SCHEMA, "default", "Stella app signing key", pem, NULL, &error,
               "service", SECRET_SERVICE_ID, "account", SECRET_ACCOUNT, NULL) || error) {
        set_error("could not store the signing key: %s", error ? error->message : "unknown");
        if (error) g_error_free(error);
        return -1;
    }
    return 0;
}

/* ---------------------------------------------------------------- signer */

typedef struct {
    EVP_PKEY *key;
    char *spki_base64;   /* STELLA_LAUNCHER_PUBKEY */
} Signer;

static Signer *g_signer;

static EVP_PKEY *pem_to_key(const char *pem) {
    BIO *bio = BIO_new_mem_buf(pem, -1);
    EVP_PKEY *key = PEM_read_bio_PrivateKey(bio, NULL, NULL, NULL);
    BIO_free(bio);
    if (key && EVP_PKEY_get_base_id(key) != EVP_PKEY_EC) { EVP_PKEY_free(key); key = NULL; }
    return key;
}

static char *key_to_pem(EVP_PKEY *key) {
    BIO *bio = BIO_new(BIO_s_mem());
    char *data, *out;
    long len;
    PEM_write_bio_PrivateKey(bio, key, NULL, NULL, 0, NULL, NULL);
    len = BIO_get_mem_data(bio, &data);
    out = malloc((size_t)len + 1);
    memcpy(out, data, (size_t)len);
    out[len] = 0;
    BIO_free(bio);
    return out;
}

static char *public_pem(EVP_PKEY *key) {
    BIO *bio = BIO_new(BIO_s_mem());
    char *data, *out;
    long len;
    PEM_write_bio_PUBKEY(bio, key);
    len = BIO_get_mem_data(bio, &data);
    out = malloc((size_t)len + 1);
    memcpy(out, data, (size_t)len);
    out[len] = 0;
    BIO_free(bio);
    return out;
}

static EVP_PKEY *file_key(const char *path) {
    struct stat st;
    if (stat(path, &st) == 0) {
        char *pem;
        EVP_PKEY *key;
        if (st.st_mode & 077) {
            set_error("%s must not be readable by other users (chmod 600).", path);
            return NULL;
        }
        pem = read_file(path, NULL);
        key = pem ? pem_to_key(pem) : NULL;
        free(pem);
        if (!key) set_error("%s is not a P-256 private key.", path);
        return key;
    }
    {
        EVP_PKEY *key = EVP_PKEY_Q_keygen(NULL, NULL, "EC", "P-256");
        char *pem, *dir = xstrdup(path), *slash;
        if (!key) { set_error("could not generate a signing key"); free(dir); return NULL; }
        if ((slash = strrchr(dir, '/'))) { *slash = 0; mkdirs(dir, 0700); }
        free(dir);
        pem = key_to_pem(key);
        if (write_file_atomic(path, pem, strlen(pem), 0600) != 0) {
            set_error("could not write %s", path);
            free(pem);
            EVP_PKEY_free(key);
            return NULL;
        }
        free(pem);
        LOG("signing: generated a key file at %s", path);
        return key;
    }
}

/*
 * The key lives in the Secret Service when one is running (gnome-keyring,
 * KWallet), else in a 0600 file under the install root. Where it went is
 * recorded, so a keyring that is briefly locked or not yet up never makes the
 * launcher mint a second key and refuse its own signatures.
 */
static EVP_PKEY *load_or_create_key(void) {
    const char *override = getenv("STELLA_LAUNCHER_KEY_FILE");
    char *fallback = xasprintf("%s/signing.key", P.root);
    EVP_PKEY *key = NULL;
    if (override && *override) {
        char *path = trimmed(override);
        if (path[0] == '~' && getenv("HOME")) {
            char *e = xasprintf("%s%s", getenv("HOME"), path + 1);
            free(path);
            path = e;
        }
        key = file_key(path);
        free(path);
        free(fallback);
        return key;
    }
    if (S.key_store && !strcmp(S.key_store, "file")) {
        key = file_key(fallback);
    } else {
        char *pem = NULL;
        int found = secret_lookup(&pem);
        if (found == 1) {
            key = pem_to_key(pem);
            if (!key) set_error("the signing key in the Secret Service is unreadable");
            free(pem);
        } else if (found == 0 || (found < 0 && !S.key_store)) {
            if (found == 0) {
                key = EVP_PKEY_Q_keygen(NULL, NULL, "EC", "P-256");
                pem = key_to_pem(key);
                if (secret_store(pem) == 0) {
                    free(S.key_store);
                    S.key_store = xstrdup("secret");
                    state_save();
                    LOG("signing: generated a key in the Secret Service");
                } else {
                    LOG("signing: %s; using a key file", last_error());
                    EVP_PKEY_free(key);
                    key = NULL;
                }
                free(pem);
            } else {
                LOG("signing: %s; using a key file", last_error());
            }
            if (!key) {
                key = file_key(fallback);
                if (key) {
                    free(S.key_store);
                    S.key_store = xstrdup("file");
                    state_save();
                }
            }
        } else {
            /* Recorded as "secret" but the Secret Service is down: retryable. */
            set_error("Stella's signing key is in the keyring, which isn't available right now (%s).", last_error());
        }
    }
    free(fallback);
    return key;
}

static Signer *signer_create(void) {
    EVP_PKEY *key = load_or_create_key();
    Signer *s;
    unsigned char *der = NULL;
    int len;
    char *pem, *existing;
    if (!key) return NULL;
    s = calloc(1, sizeof(*s));
    s->key = key;
    len = i2d_PUBKEY(key, &der);
    s->spki_base64 = base64_encode(der, (size_t)len);
    OPENSSL_free(der);
    pem = public_pem(key);
    existing = read_file(P.signing_pub, NULL);
    if (!existing || strcmp(existing, pem) != 0) write_file_atomic(P.signing_pub, pem, strlen(pem), 0644);
    free(existing);
    free(pem);
    return s;
}

static char *tree_message(const char *tree) { return xasprintf("stella-tree-v1\n%s\n", tree); }

static char *signer_sign(Signer *s, const char *tree) {
    char *msg = tree_message(tree);
    EVP_MD_CTX *ctx = EVP_MD_CTX_new();
    size_t siglen = 0;
    unsigned char *sig = NULL;
    char *out = NULL;
    if (EVP_DigestSignInit(ctx, NULL, EVP_sha256(), NULL, s->key) == 1 &&
        EVP_DigestSign(ctx, NULL, &siglen, (unsigned char *)msg, strlen(msg)) == 1) {
        sig = malloc(siglen);
        if (EVP_DigestSign(ctx, sig, &siglen, (unsigned char *)msg, strlen(msg)) == 1)
            out = base64_encode(sig, siglen);
    }
    if (!out) set_error("signing failed");
    free(sig);
    EVP_MD_CTX_free(ctx);
    free(msg);
    return out;
}

static int signer_verify(Signer *s, const char *tree, const char *note) {
    size_t len = 0;
    unsigned char *der = base64_decode(note, &len);
    char *msg;
    EVP_MD_CTX *ctx;
    int ok = 0;
    if (!der) return 0;
    msg = tree_message(tree);
    ctx = EVP_MD_CTX_new();
    if (EVP_DigestVerifyInit(ctx, NULL, EVP_sha256(), NULL, s->key) == 1)
        ok = EVP_DigestVerify(ctx, der, len, (unsigned char *)msg, strlen(msg)) == 1;
    EVP_MD_CTX_free(ctx);
    free(msg);
    free(der);
    return ok;
}

/* ------------------------------------------------------------------- git */

typedef struct {
    char *bin;
} Git;

static Git *g_git;
static StrList base_environment(void);

static const char *IDENTITY_ENV[] = {"GIT_AUTHOR_NAME=Stella", "GIT_AUTHOR_EMAIL=stella@localhost",
                                     "GIT_COMMITTER_NAME=Stella", "GIT_COMMITTER_EMAIL=stella@localhost", NULL};

static int git_raw(const char *const *args, const char *cwd, const char *const *extra_env, CmdResult *r) {
    StrList argv = {0}, env = base_environment();
    size_t i;
    int rc;
    sl_push(&argv, g_git->bin);
    for (i = 0; args[i]; i++) sl_push(&argv, args[i]);
    env_set(&env, "GIT_TERMINAL_PROMPT", "0");
    for (i = 0; extra_env && extra_env[i]; i++) {
        char *key = xstrdup(extra_env[i]), *eq = strchr(key, '=');
        if (eq) { *eq = 0; env_set(&env, key, eq + 1); }
        free(key);
    }
    rc = run_cmd(argv.items, cwd, env.items, NULL, 0, r);
    sl_free(&argv);
    sl_free(&env);
    return rc;
}

/* Trimmed stdout, or NULL with the error set. */
static char *git_run(const char *const *args, const char *cwd, const char *const *extra_env) {
    CmdResult r;
    char *out;
    if (git_raw(args, cwd, extra_env, &r) != 0) return NULL;
    if (r.code != 0) {
        char *detail = trimmed(r.err);
        if (*detail) set_error("git %s failed: %s", args[0], detail);
        else set_error("git %s failed: exit %d", args[0], r.code);
        free(detail);
        cmd_free(&r);
        return NULL;
    }
    out = trimmed(r.out);
    cmd_free(&r);
    return out;
}

#define GIT(...) git_run((const char *const[]){__VA_ARGS__, NULL}, P.app, NULL)

/* Linux uses the system git (the plan's choice for this platform). */
static int ensure_git(void) {
    char *bin;
    if (g_git) return 0;
    bin = which("git");
    if (!bin) {
        set_error("Stella needs git. Install it (for example `sudo pacman -S git`) and try again.");
        return -1;
    }
    g_git = calloc(1, sizeof(*g_git));
    g_git->bin = bin;
    {
        char *version = git_run((const char *const[]){"--version", NULL}, NULL, NULL);
        LOG("install: using %s (%s)", bin, version ? version : "unknown version");
        free(version);
    }
    return 0;
}

/* `git status --porcelain` lines; untracked files count (the renderer globs the tree). */
static int changed_files(StrList *out) {
    char *status = GIT("status", "--porcelain=v1", "--untracked-files=all");
    char *line, *save = NULL;
    if (!status) return -1;
    for (line = strtok_r(status, "\n", &save); line; line = strtok_r(NULL, "\n", &save))
        if (*line) sl_push(out, line);
    free(status);
    return 0;
}

typedef enum { V_SIGNED, V_UNSIGNED, V_BAD_SIGNATURE, V_DIRTY, V_ERROR } Verdict;

/* Before every spawn: HEAD's note must verify and the tree must be clean. */
static Verdict verify_head(StrList *dirty) {
    char *head, *tree;
    CmdResult note;
    Verdict v;
    if (changed_files(dirty) != 0) return V_ERROR;
    if (dirty->count) return V_DIRTY;
    head = GIT("rev-parse", "HEAD");
    tree = GIT("rev-parse", "HEAD^{tree}");
    if (!head || !tree) { free(head); free(tree); return V_ERROR; }
    if (git_raw((const char *const[]){"notes", "--ref", NOTES_REF, "show", head, NULL}, P.app, NULL, &note) != 0) {
        free(head); free(tree);
        return V_ERROR;
    }
    if (note.code != 0) v = V_UNSIGNED;
    else v = signer_verify(g_signer, tree, note.out) ? V_SIGNED : V_BAD_SIGNATURE;
    cmd_free(&note);
    free(head);
    free(tree);
    return v;
}

/* Sign HEAD after checking it is `expected` (when given) and clean. Returns HEAD. */
static char *sign_head(const char *expected) {
    char *head = GIT("rev-parse", "HEAD"), *tree, *note, *added;
    StrList dirty = {0};
    if (!head) return NULL;
    if (expected && *expected && strcmp(expected, head) != 0) {
        set_error("HEAD is %.12s, not %.12s.", head, expected);
        free(head);
        return NULL;
    }
    if (changed_files(&dirty) != 0) { free(head); return NULL; }
    if (dirty.count) {
        set_error("The checkout has uncommitted changes: %s%s", dirty.items[0], dirty.count > 1 ? ", ..." : ".");
        sl_free(&dirty);
        free(head);
        return NULL;
    }
    tree = GIT("rev-parse", "HEAD^{tree}");
    note = tree ? signer_sign(g_signer, tree) : NULL;
    if (!note) { free(tree); free(head); return NULL; }
    added = git_run((const char *const[]){"notes", "--ref", NOTES_REF, "add", "-f", "-m", note, head, NULL},
                    P.app, IDENTITY_ENV);
    if (!added) { free(note); free(tree); free(head); return NULL; }
    LOG("signing: signed %.12s tree %.12s", head, tree);
    free(added);
    free(note);
    free(tree);
    return head;
}

/* ------------------------------------------------------------------- UI */

/*
 * GTK runs on the main thread; the launcher's work runs on a worker thread and
 * hops to the main loop for every window operation. Without a display the
 * windows are skipped and everything is logged.
 */
static int g_ui;

typedef struct {
    GtkWidget *window, *label, *bar;
    guint pulse;
    int captured;
} Progress;
static Progress g_progress;

static void capture_window(GtkWidget *window, const char *path) {
    GdkWindow *gw = gtk_widget_get_window(window);
    GdkPixbuf *pb;
    char *dir, *slash;
    if (!gw) return;
    pb = gdk_pixbuf_get_from_window(gw, 0, 0, gdk_window_get_width(gw), gdk_window_get_height(gw));
    if (!pb) return;
    dir = xstrdup(path);
    if ((slash = strrchr(dir, '/'))) { *slash = 0; mkdirs(dir, 0755); }
    free(dir);
    if (gdk_pixbuf_save(pb, path, "png", NULL, NULL)) LOG("ui: captured %s", path);
    g_object_unref(pb);
}

static gboolean pulse_cb(gpointer data) {
    (void)data;
    if (g_progress.bar) gtk_progress_bar_pulse(GTK_PROGRESS_BAR(g_progress.bar));
    return G_SOURCE_CONTINUE;
}

static gboolean capture_progress_cb(gpointer data) {
    char *path = data;
    if (g_progress.window && gtk_widget_get_visible(g_progress.window)) capture_window(g_progress.window, path);
    free(path);
    return G_SOURCE_REMOVE;
}

static gboolean progress_show_idle(gpointer data) {
    char *status = data;
    if (!g_progress.window) {
        GtkWidget *box, *title;
        g_progress.window = gtk_window_new(GTK_WINDOW_TOPLEVEL);
        gtk_window_set_title(GTK_WINDOW(g_progress.window), "Stella");
        gtk_window_set_default_size(GTK_WINDOW(g_progress.window), 380, 120);
        gtk_window_set_resizable(GTK_WINDOW(g_progress.window), FALSE);
        gtk_window_set_position(GTK_WINDOW(g_progress.window), GTK_WIN_POS_CENTER);
        gtk_window_set_deletable(GTK_WINDOW(g_progress.window), FALSE);
        box = gtk_box_new(GTK_ORIENTATION_VERTICAL, 8);
        gtk_container_set_border_width(GTK_CONTAINER(box), 20);
        title = gtk_label_new(NULL);
        gtk_label_set_markup(GTK_LABEL(title), "<b>Getting Stella ready</b>");
        gtk_widget_set_halign(title, GTK_ALIGN_START);
        g_progress.label = gtk_label_new("");
        gtk_widget_set_halign(g_progress.label, GTK_ALIGN_START);
        gtk_style_context_add_class(gtk_widget_get_style_context(g_progress.label), "dim-label");
        g_progress.bar = gtk_progress_bar_new();
        gtk_box_pack_start(GTK_BOX(box), title, FALSE, FALSE, 0);
        gtk_box_pack_start(GTK_BOX(box), g_progress.label, FALSE, FALSE, 0);
        gtk_box_pack_start(GTK_BOX(box), g_progress.bar, FALSE, FALSE, 0);
        gtk_container_add(GTK_CONTAINER(g_progress.window), box);
        g_progress.pulse = g_timeout_add(120, pulse_cb, NULL);
    }
    gtk_label_set_text(GTK_LABEL(g_progress.label), status);
    gtk_widget_show_all(g_progress.window);
    gtk_window_present(GTK_WINDOW(g_progress.window));
    if (O.capture_dir && !g_progress.captured) {
        g_progress.captured = 1;
        g_timeout_add(500, capture_progress_cb, xasprintf("%s/progress.png", O.capture_dir));
    }
    free(status);
    return G_SOURCE_REMOVE;
}

static void progress_show(const char *status) {
    LOG("progress: %s", status);
    if (g_ui) g_idle_add(progress_show_idle, xstrdup(status));
}

static gboolean progress_hide_idle(gpointer data) {
    (void)data;
    if (g_progress.window) gtk_widget_hide(g_progress.window);
    return G_SOURCE_REMOVE;
}

static void progress_hide(void) {
    if (g_ui) g_idle_add(progress_hide_idle, NULL);
}

typedef struct {
    const char *reason;
    const StrList *output;
    int has_known_good;
    char *capture_path;
    Choice automation;
    double automation_delay;
    GtkWidget *window;
    GtkWidget *buttons[5];
    Choice choice;
    int done;
    GMutex lock;
    GCond cond;
} Recovery;

static void recovery_finish(Recovery *r, Choice choice) {
    if (r->window) { gtk_widget_destroy(r->window); r->window = NULL; }
    g_mutex_lock(&r->lock);
    if (!r->done) { r->choice = choice; r->done = 1; }
    g_cond_signal(&r->cond);
    g_mutex_unlock(&r->lock);
}

static void recovery_clicked(GtkButton *button, gpointer data) {
    Recovery *r = data;
    Choice c = (Choice)GPOINTER_TO_INT(g_object_get_data(G_OBJECT(button), "choice"));
    recovery_finish(r, c);
}

static gboolean recovery_deleted(GtkWidget *w, GdkEvent *e, gpointer data) {
    (void)w; (void)e;
    recovery_finish(data, CHOICE_QUIT);
    return TRUE;
}

static gboolean recovery_capture_cb(gpointer data) {
    Recovery *r = data;
    if (r->window && r->capture_path) capture_window(r->window, r->capture_path);
    return G_SOURCE_REMOVE;
}

static gboolean recovery_auto_cb(gpointer data) {
    Recovery *r = data;
    GtkWidget *target = r->buttons[r->automation];
    /* "return" means the primary button, which reads "Reinstall" without a known-good version. */
    if (!target && r->automation == CHOICE_RETURN) target = r->buttons[CHOICE_REINSTALL];
    LOG("recovery: self-test clicks %s", choice_name(r->automation));
    if (target && r->window) gtk_button_clicked(GTK_BUTTON(target));
    else recovery_finish(r, r->automation);
    return G_SOURCE_REMOVE;
}

static GtkWidget *recovery_button(Recovery *r, const char *label, Choice choice) {
    GtkWidget *b = gtk_button_new_with_label(label);
    g_object_set_data(G_OBJECT(b), "choice", GINT_TO_POINTER(choice));
    g_signal_connect(b, "clicked", G_CALLBACK(recovery_clicked), r);
    r->buttons[choice] = b;
    return b;
}

static gboolean scroll_to_end_cb(gpointer data) {
    GtkTextView *view = data;
    GtkTextMark *mark = gtk_text_buffer_get_mark(gtk_text_view_get_buffer(view), "end");
    if (mark) gtk_text_view_scroll_to_mark(view, mark, 0, TRUE, 0, 1);
    return G_SOURCE_REMOVE;
}

static gboolean recovery_show_idle(gpointer data) {
    Recovery *r = data;
    GtkWidget *box, *title, *message, *scroll, *text, *row, *primary, *retry, *quit;
    GtkTextBuffer *buffer;
    GtkTextIter end;
    GString *joined = g_string_new(NULL);
    size_t i;
    Choice primary_choice = r->has_known_good ? CHOICE_RETURN : CHOICE_REINSTALL;

    r->window = gtk_window_new(GTK_WINDOW_TOPLEVEL);
    gtk_window_set_title(GTK_WINDOW(r->window), "Stella");
    gtk_window_set_default_size(GTK_WINDOW(r->window), 640, 460);
    gtk_window_set_position(GTK_WINDOW(r->window), GTK_WIN_POS_CENTER);
    g_signal_connect(r->window, "delete-event", G_CALLBACK(recovery_deleted), r);

    box = gtk_box_new(GTK_ORIENTATION_VERTICAL, 12);
    gtk_container_set_border_width(GTK_CONTAINER(box), 20);
    title = gtk_label_new(NULL);
    gtk_label_set_markup(GTK_LABEL(title), "<span size='large' weight='bold'>Stella couldn't start</span>");
    gtk_widget_set_halign(title, GTK_ALIGN_START);
    message = gtk_label_new(r->reason);
    gtk_label_set_line_wrap(GTK_LABEL(message), TRUE);
    gtk_label_set_xalign(GTK_LABEL(message), 0);
    gtk_style_context_add_class(gtk_widget_get_style_context(message), "dim-label");

    text = gtk_text_view_new();
    gtk_text_view_set_editable(GTK_TEXT_VIEW(text), FALSE);
    gtk_text_view_set_monospace(GTK_TEXT_VIEW(text), TRUE);
    gtk_text_view_set_left_margin(GTK_TEXT_VIEW(text), 6);
    gtk_text_view_set_wrap_mode(GTK_TEXT_VIEW(text), GTK_WRAP_WORD_CHAR);
    buffer = gtk_text_view_get_buffer(GTK_TEXT_VIEW(text));
    for (i = 0; i < r->output->count; i++) {
        if (i) g_string_append_c(joined, '\n');
        g_string_append(joined, r->output->items[i]);
    }
    gtk_text_buffer_set_text(buffer, r->output->count ? joined->str : "(Stella wrote no output.)", -1);
    g_string_free(joined, TRUE);
    scroll = gtk_scrolled_window_new(NULL, NULL);
    gtk_scrolled_window_set_shadow_type(GTK_SCROLLED_WINDOW(scroll), GTK_SHADOW_IN);
    gtk_widget_set_size_request(scroll, -1, 260);
    gtk_container_add(GTK_CONTAINER(scroll), text);

    row = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 8);
    quit = recovery_button(r, "Quit", CHOICE_QUIT);
    retry = recovery_button(r, "Try again", CHOICE_RETRY);
    primary = recovery_button(r, r->has_known_good ? "Return to last working version" : "Reinstall", primary_choice);
    gtk_style_context_add_class(gtk_widget_get_style_context(primary), "suggested-action");
    gtk_box_pack_start(GTK_BOX(row), quit, FALSE, FALSE, 0);
    gtk_box_pack_end(GTK_BOX(row), primary, FALSE, FALSE, 0);
    gtk_box_pack_end(GTK_BOX(row), retry, FALSE, FALSE, 0);

    gtk_box_pack_start(GTK_BOX(box), title, FALSE, FALSE, 0);
    gtk_box_pack_start(GTK_BOX(box), message, FALSE, FALSE, 0);
    gtk_box_pack_start(GTK_BOX(box), scroll, TRUE, TRUE, 0);
    gtk_box_pack_start(GTK_BOX(box), row, FALSE, FALSE, 0);
    gtk_container_add(GTK_CONTAINER(r->window), box);
    gtk_widget_show_all(r->window);
    gtk_widget_set_can_default(primary, TRUE);
    gtk_widget_grab_default(primary);
    gtk_widget_grab_focus(primary);
    gtk_window_present(GTK_WINDOW(r->window));
    /* Show the newest output once the view has its size. */
    gtk_text_buffer_get_end_iter(buffer, &end);
    gtk_text_buffer_create_mark(buffer, "end", &end, FALSE);
    g_timeout_add(100, scroll_to_end_cb, text);
    LOG("recovery: shown reason: %s", r->reason);
    if (r->capture_path) g_timeout_add(700, recovery_capture_cb, r);
    if (r->automation != CHOICE_NONE) g_timeout_add((guint)(r->automation_delay * 1000), recovery_auto_cb, r);
    return G_SOURCE_REMOVE;
}

/* "Stella couldn't start": blocks the worker until a choice is made. */
static Choice recovery_present(const char *reason, const StrList *output, int has_known_good,
                               const char *capture_path, Choice automation, double delay) {
    Recovery r;
    memset(&r, 0, sizeof(r));
    r.reason = reason;
    r.output = output;
    r.has_known_good = has_known_good;
    r.capture_path = capture_path ? xstrdup(capture_path) : NULL;
    r.automation = automation;
    r.automation_delay = delay;
    if (!g_ui) {
        size_t i;
        LOG("recovery: (no display) %s", reason);
        for (i = 0; i < output->count; i++) LOG("recovery: | %s", output->items[i]);
        r.choice = automation != CHOICE_NONE ? automation : CHOICE_QUIT;
        if (r.choice == CHOICE_RETURN && !has_known_good) r.choice = CHOICE_REINSTALL;
    } else {
        g_mutex_init(&r.lock);
        g_cond_init(&r.cond);
        g_idle_add(recovery_show_idle, &r);
        g_mutex_lock(&r.lock);
        while (!r.done) g_cond_wait(&r.cond, &r.lock);
        g_mutex_unlock(&r.lock);
        /* Let the main loop finish any callback still holding &r. */
        usleep(200 * 1000);
        g_mutex_clear(&r.lock);
        g_cond_clear(&r.cond);
    }
    free(r.capture_path);
    LOG("recovery: chose %s", choice_name(r.choice));
    return r.choice;
}

/* --------------------------------------------------------- environments */

static char *g_bun_bin;
static char *g_bun_version;

/* The environment for git, bun and Electron: the managed runtimes first on
 * PATH, and none of the launcher's own secrets. */
static StrList base_environment(void) {
    StrList env = {0};
    const char *stripped[] = {"STELLA_LAUNCHER_KEY_FILE", "STELLA_LAUNCHER_ROOT", "ELECTRON_RUN_AS_NODE",
                              "STELLA_V2_DEV_DATA_DIR", "STELLA_APP_DIR", "STELLA_RUNTIME_STATE_DIR",
                              "STELLA_DEV_RESTART_REQUEST_FILE", "STELLA_DEV_USER_QUIT_REQUEST_FILE",
                              "STELLA_ELECTRON_DEV_RUNNER_PID", "STELLA_ELECTRON_READY_FILE", "NODE_OPTIONS", NULL};
    /* The dev harness opens Electron to debugging, so it passes through only
     * for a test root signed with a test key file. */
    const char *harness[] = {"STELLA_DEV_HARNESS", "STELLA_DEV_HARNESS_STORAGE_KEY", "STELLA_V2_DEV_USER_DATA_DIR",
                             "STELLA_REMOTE_DEBUG_PORT", "STELLA_DEV_HARNESS_SESSION_TOKEN", NULL};
    const char *key_file = getenv("STELLA_LAUNCHER_KEY_FILE");
    int uses_test_key = key_file && *key_file;
    const char *existing;
    char **e;
    size_t i;
    for (e = environ; *e; e++) sl_push(&env, *e);
    for (i = 0; stripped[i]; i++) env_unset(&env, stripped[i]);
    if (!(P.isolated && uses_test_key))
        for (i = 0; harness[i]; i++) env_unset(&env, harness[i]);
    if (P.isolated) env_unset(&env, "STELLA_DATA_DIR");
    existing = env_get(&env, "PATH");
    {
        char *path;
        const char *rest = existing && *existing ? existing : "/usr/local/bin:/usr/bin:/bin";
        if (g_bun_bin) {
            char *dir = xstrdup(g_bun_bin), *slash = strrchr(dir, '/');
            if (slash) *slash = 0;
            path = xasprintf("%s:%s", dir, rest);
            free(dir);
        } else {
            path = xstrdup(rest);
        }
        env_set(&env, "PATH", path);
        free(path);
    }
    return env;
}

static StrList electron_environment(void) {
    StrList env = base_environment();
    env_set(&env, "STELLA_LAUNCHER", "1");
    /* The backend this launcher installs from is the one the app talks to. */
    env_set(&env, "VITE_STELLA_BACKEND_URL", O.backend);
    if (g_bun_bin) env_set(&env, "STELLA_BUN_PATH", g_bun_bin);
    if (g_git) env_set(&env, "STELLA_GIT_BIN", g_git->bin);
    if (g_signer) env_set(&env, "STELLA_LAUNCHER_PUBKEY", g_signer->spki_base64);
    /* Electron names its Wayland app_id / X11 class after this desktop file. */
    env_set(&env, "CHROME_DESKTOP", "stella.desktop");
    if (P.isolated) {
        env_set(&env, "STELLA_LAUNCHER_USER_DATA_DIR", P.isolated_user_data);
        env_set(&env, "STELLA_DATA_DIR", P.isolated_home);
        env_set(&env, "STELLA_V2_DEV_DATA_DIR", P.isolated_home);
    }
    return env;
}

/* --------------------------------------------------------------- install */

static int download(const char *url, const char *dest, const char *sha256) {
    char *staging = xasprintf("%s.download", dest);
    char *argv[] = {"curl", "-fsSL", "--retry", "3", "--connect-timeout", "30", "-o", staging, (char *)url, NULL};
    StrList env = base_environment();
    CmdResult r;
    char *actual;
    unlink(staging);
    if (run_cmd(argv, NULL, env.items, NULL, 30 * 60, &r) != 0) {
        set_error("Stella needs curl to download its runtimes (%s).", last_error());
        sl_free(&env);
        free(staging);
        return -1;
    }
    sl_free(&env);
    if (r.code != 0) {
        char *detail = trimmed(r.err);
        set_error("Download of %s failed: %s", url, detail);
        free(detail);
        cmd_free(&r);
        unlink(staging);
        free(staging);
        return -1;
    }
    cmd_free(&r);
    actual = sha256_file(staging);
    if (!actual || strcasecmp(actual, sha256) != 0) {
        set_error("Checksum mismatch for %s: expected %s, got %s.", url, sha256, actual ? actual : "?");
        free(actual);
        unlink(staging);
        free(staging);
        return -1;
    }
    free(actual);
    unlink(dest);
    rename(staging, dest);
    free(staging);
    return 0;
}

/* unzip, else bsdtar, else Python's zipfile: whichever the system has. */
static int extract_zip(const char *archive, const char *dir) {
    StrList env = base_environment();
    CmdResult r;
    int ok = 0;
    char *unzip_argv[] = {"unzip", "-q", "-o", (char *)archive, "-d", (char *)dir, NULL};
    char *bsdtar_argv[] = {"bsdtar", "-xf", (char *)archive, "-C", (char *)dir, NULL};
    char *py_argv[] = {"python3", "-c", "import sys,zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])",
                       (char *)archive, (char *)dir, NULL};
    char **tries[] = {unzip_argv, bsdtar_argv, py_argv};
    size_t i;
    mkdirs(dir, 0755);
    for (i = 0; i < 3 && !ok; i++) {
        char *found = which(tries[i][0]);
        if (!found) continue;
        free(found);
        if (run_cmd(tries[i], NULL, env.items, NULL, 600, &r) == 0) {
            ok = r.code == 0;
            if (!ok) LOG("install: %s failed: %s", tries[i][0], r.err);
            cmd_free(&r);
        }
    }
    sl_free(&env);
    if (!ok) set_error("Could not unpack %s (Stella needs unzip, bsdtar or python3).", archive);
    return ok ? 0 : -1;
}

/*
 * Bun from the version baked into the launcher, or the one a signed tree asks
 * for in packages/desktop/launcher.json:
 * {"bun": {"version": "1.4.1", "assets": {"linux-x64": {"url", "sha256", "member"}}}}.
 */
static int ensure_bun(void) {
    const char *key = platform_key();
    const char *version = BUN_VERSION, *url = NULL, *sha = NULL, *member = NULL;
    char *manifest_path = xasprintf("%s/packages/desktop/launcher.json", P.app);
    char *manifest = read_file(manifest_path, NULL);
    mj_value *json = manifest ? mj_parse(manifest, strlen(manifest)) : NULL;
    char *dir = NULL, *bin = NULL;
    size_t i;
    int rc = -1;
    free(manifest_path);
    for (i = 0; i < sizeof(BUN_ASSETS) / sizeof(BUN_ASSETS[0]); i++)
        if (!strcmp(BUN_ASSETS[i].key, key)) {
            url = BUN_ASSETS[i].url; sha = BUN_ASSETS[i].sha256; member = BUN_ASSETS[i].member;
        }
    if (json) {
        const mj_value *bun = mj_get(json, "bun");
        const mj_value *asset = mj_get(mj_get(bun, "assets"), key);
        const char *v = mj_get_string(bun, "version");
        if (v && mj_get_string(asset, "url") && mj_get_string(asset, "sha256")) {
            version = v;
            url = mj_get_string(asset, "url");
            sha = mj_get_string(asset, "sha256");
            member = mj_get_string(asset, "member");
        }
    }

    if (O.local_bun) {
        /* Offline/testing: adopt an existing Bun instead of downloading. */
        char *argv[] = {O.local_bun, "--version", NULL};
        StrList env = base_environment();
        CmdResult r;
        char *local_version;
        if (run_cmd(argv, NULL, env.items, NULL, 60, &r) != 0 || r.code != 0) {
            set_error("%s is not a working bun.", O.local_bun);
            sl_free(&env);
            goto out;
        }
        sl_free(&env);
        local_version = trimmed(r.out);
        cmd_free(&r);
        dir = xasprintf("%s/bun-%s", P.runtimes, local_version);
        bin = xasprintf("%s/bun", dir);
        if (!is_executable(bin)) {
            char resolved[PATH_MAX];
            mkdirs(dir, 0755);
            if (copy_file(realpath(O.local_bun, resolved) ? resolved : O.local_bun, bin, 0755) != 0) {
                set_error("could not copy %s", O.local_bun);
                free(local_version);
                goto out;
            }
            LOG("install: adopted local bun %s from %s", local_version, O.local_bun);
        }
        free(g_bun_bin); g_bun_bin = xstrdup(bin);
        free(g_bun_version); g_bun_version = local_version;
        rc = 0;
        goto out;
    }

    dir = xasprintf("%s/bun-%s", P.runtimes, version);
    bin = xasprintf("%s/bun", dir);
    if (!is_executable(bin)) {
        char *archive = xasprintf("%s/bun-%s.zip", P.runtimes, version);
        char *staging = xasprintf("%s/.bun-%s.partial", P.runtimes, version);
        char *member_path;
        if (!url || !sha) { set_error("No Bun %s for %s.", version, key); free(archive); free(staging); goto out; }
        progress_show("Downloading Bun…");
        LOG("install: downloading bun %s from %s", version, url);
        mkdirs(P.runtimes, 0755);
        if (download(url, archive, sha) != 0) { free(archive); free(staging); goto out; }
        remove_tree(staging);
        if (extract_zip(archive, staging) != 0) { free(archive); free(staging); goto out; }
        member_path = xasprintf("%s/%s", staging, member ? member : "bun");
        mkdirs(dir, 0755);
        unlink(bin);
        if (rename(member_path, bin) != 0) {
            set_error("Bun's archive has no %s.", member ? member : "bun");
            free(member_path); free(archive); free(staging);
            goto out;
        }
        chmod(bin, 0755);
        remove_tree(staging);
        unlink(archive);
        free(member_path); free(archive); free(staging);
        LOG("install: bun %s ready", version);
    }
    free(g_bun_bin); g_bun_bin = xstrdup(bin);
    free(g_bun_version); g_bun_version = xstrdup(version);
    rc = 0;
out:
    mj_free(json);
    free(dir);
    free(bin);
    return rc;
}

/* POST <backend>/api/app-source/bootstrap → {upstream: {remote, token, expiresAt}}. */
static int bootstrap_access(char **remote, char **token) {
    char *base = xstrdup(O.backend), *url;
    char *argv[12];
    StrList env = base_environment();
    CmdResult r;
    mj_value *json;
    const mj_value *body;
    size_t len = strlen(base);
    if (len && base[len - 1] == '/') base[len - 1] = 0;
    url = xasprintf("%s/api/app-source/bootstrap", base);
    free(base);
    argv[0] = "curl"; argv[1] = "-sS"; argv[2] = "--retry"; argv[3] = "2"; argv[4] = "-X"; argv[5] = "POST";
    argv[6] = "-H"; argv[7] = "Content-Type: application/json"; argv[8] = "-d"; argv[9] = "{}";
    argv[10] = url; argv[11] = NULL;
    LOG("install: POST %s", url);
    if (run_cmd(argv, NULL, env.items, NULL, 120, &r) != 0) { sl_free(&env); free(url); return -1; }
    sl_free(&env);
    free(url);
    if (r.code != 0) {
        char *detail = trimmed(r.err);
        set_error("Could not reach Stella's servers: %s", detail);
        free(detail);
        cmd_free(&r);
        return -1;
    }
    json = mj_parse(r.out, strlen(r.out));
    cmd_free(&r);
    if (!json) { set_error("The app source bootstrap returned an unexpected body."); return -1; }
    /* Accept {remote, token} or {upstream: {remote, token}}. */
    body = mj_get(json, "upstream");
    if (!body) body = json;
    if (!mj_get_string(body, "remote") || !mj_get_string(body, "token")) {
        set_error("The app source bootstrap response has no remote and token.");
        mj_free(json);
        return -1;
    }
    *remote = xstrdup(mj_get_string(body, "remote"));
    *token = xstrdup(mj_get_string(body, "token"));
    mj_free(json);
    return 0;
}

/* Clone into app/; staged beside it and renamed, so an interrupted install
 * never leaves half a tree. */
static int clone_source(void) {
    char *staging = xasprintf("%s/app.partial", P.root);
    StrList args = {0}, extra = {0};
    char *remote = NULL, *token = NULL, *out, *head;
    int rc = -1;
    progress_show("Downloading Stella…");
    remove_tree(staging);
    sl_push(&args, "clone");
    sl_push(&args, "--origin");
    sl_push(&args, UPSTREAM_REMOTE_NAME);
    if (O.source) {
        remote = xstrdup(O.source);
        if (O.source_ref) { sl_push(&args, "--branch"); sl_push(&args, O.source_ref); }
    } else {
        char *header;
        if (bootstrap_access(&remote, &token) != 0) goto out;
        sl_push(&args, "--branch");
        sl_push(&args, UPSTREAM_BRANCH);
        /* Through the environment: the token stays out of argv and the clone's config. */
        header = xasprintf("GIT_CONFIG_VALUE_0=Authorization: Bearer %s", token);
        sl_push(&extra, "GIT_CONFIG_COUNT=2");
        sl_push(&extra, "GIT_CONFIG_KEY_0=http.extraHeader");
        sl_push(&extra, header);
        sl_push(&extra, "GIT_CONFIG_KEY_1=protocol.version");
        sl_push(&extra, "GIT_CONFIG_VALUE_1=1");
        free(header);
    }
    sl_push(&args, remote);
    sl_push(&args, staging);
    LOG("install: cloning %s", remote);
    out = git_run((const char *const *)args.items, P.root, extra.items ? (const char *const *)extra.items : NULL);
    if (!out) goto out;
    free(out);
    if (rename(staging, P.app) != 0) { set_error("could not move the checkout into place: %s", strerror(errno)); goto out; }
    head = GIT("rev-parse", "HEAD");
    LOG("install: source at %s", head ? head : "?");
    free(head);
    rc = 0;
out:
    sl_free(&args);
    sl_free(&extra);
    free(remote);
    free(token);
    free(staging);
    return rc;
}

/* The .desktop entry, pointing at an installed copy of this launcher. */
static void install_desktop_entry(void) {
    char self[PATH_MAX], *installed, *apps, *entry_path, *entry, *icon_src, *icon, *existing;
    const char *xdg = getenv("XDG_DATA_HOME");
    ssize_t n = readlink("/proc/self/exe", self, sizeof(self) - 1);
    if (n <= 0) return;
    self[n] = 0;
    mkdirs(P.bin_dir, 0755);
    installed = xasprintf("%s/stella-launcher", P.bin_dir);
    if (strcmp(self, installed) != 0) {
        if (copy_file(self, installed, 0755) == 0) LOG("install: copied the launcher to %s", installed);
        else LOG("install: could not copy the launcher to %s", installed);
    }
    icon_src = xasprintf("%s/packages/desktop/build/icon.png", P.app);
    icon = xasprintf("%s/stella.png", P.root);
    if (file_exists(icon_src)) copy_file(icon_src, icon, 0644);
    apps = xdg && *xdg ? xasprintf("%s/applications", xdg)
                       : xasprintf("%s/.local/share/applications", getenv("HOME") ? getenv("HOME") : "/tmp");
    mkdirs(apps, 0755);
    entry_path = xasprintf("%s/stella.desktop", apps);
    entry = xasprintf(
        "[Desktop Entry]\n"
        "Type=Application\n"
        "Name=Stella\n"
        "Comment=Your personal AI assistant\n"
        "Exec=\"%s\"\n"
        "Icon=%s\n"
        "Terminal=false\n"
        "Categories=Utility;\n"
        "StartupWMClass=Stella\n"
        "StartupNotify=true\n",
        installed, icon);
    existing = read_file(entry_path, NULL);
    if (!existing || strcmp(existing, entry) != 0) {
        if (write_file_atomic(entry_path, entry, strlen(entry), 0644) == 0) LOG("install: wrote %s", entry_path);
    }
    free(existing);
    free(entry);
    free(entry_path);
    free(apps);
    free(icon);
    free(icon_src);
    free(installed);
}

/* --------------------------------------------------------------- prepare */

/* On install, after a relaunch request and after a rollback. Returns the Electron binary. */
static char *prepare(void) {
    char *lock = xasprintf("%s/bun.lock", P.app);
    char *lock_hash = sha256_file(lock);
    char *electron_pkg = xasprintf("%s/node_modules/electron/package.json", P.app);
    char *script = xasprintf("%s/packages/desktop/scripts/prepare-install.mjs", P.app);
    char *electron = xasprintf("%s/node_modules/electron/dist/electron", P.app);
    char *head = NULL, *result = NULL;
    free(lock);
    if (!lock_hash) goto out;
    if (!S.bun_lock_hash || strcmp(S.bun_lock_hash, lock_hash) != 0 || !file_exists(electron_pkg)) {
        StrList env = base_environment();
        char *argv[] = {g_bun_bin, "install", "--frozen-lockfile", NULL};
        CmdResult r;
        double started = now_seconds();
        progress_show("Installing Stella's dependencies…");
        LOG("prepare: bun install --frozen-lockfile (lock %.12s)", lock_hash);
        /* Dependencies only: the postinstall's asset downloads are prepare-install.mjs's job. */
        env_set(&env, "STELLA_SKIP_BROWSER_HYDRATE", "1");
        env_set(&env, "STELLA_SKIP_OFFICE_HYDRATE", "1");
        if (run_cmd(argv, P.app, env.items, P.install_log, 30 * 60, &r) != 0) { sl_free(&env); goto out; }
        sl_free(&env);
        if (r.timed_out || r.code != 0) {
            char *tail = last_lines(r.err, 20);
            if (r.timed_out) set_error("bun install timed out after 30 minutes:\n%s", tail);
            else set_error("bun install failed (exit %d):\n%s", r.code, tail);
            free(tail);
            cmd_free(&r);
            goto out;
        }
        cmd_free(&r);
        LOG("prepare: bun install finished in %ds", (int)(now_seconds() - started));
        free(S.bun_lock_hash);
        S.bun_lock_hash = xstrdup(lock_hash);
        state_save();
    }

    head = GIT("rev-parse", "HEAD");
    if (!head) goto out;
    if ((!S.prepared_head || strcmp(S.prepared_head, head) != 0) && file_exists(script)) {
        /* Optional features (computer use, the browser, office previews): a
         * failure or timeout is logged, not fatal, and retried next launch. */
        StrList env = base_environment();
        char *argv[] = {g_bun_bin, script, NULL};
        double timeout = env_seconds("STELLA_LAUNCHER_PREPARE_TIMEOUT_SECONDS", 10 * 60);
        CmdResult r;
        progress_show("Preparing Stella…");
        LOG("prepare: prepare-install.mjs for %.12s", head);
        if (run_cmd(argv, P.app, env.items, P.install_log, timeout, &r) == 0 && !r.timed_out && r.code == 0) {
            free(S.prepared_head);
            S.prepared_head = xstrdup(head);
            state_save();
        } else {
            char *tail = last_lines(r.err ? r.err : "", 10);
            if (r.timed_out) LOG("prepare: prepare-install.mjs incomplete (timed out after %ds):\n%s", (int)timeout, tail);
            else LOG("prepare: prepare-install.mjs incomplete (exit %d):\n%s", r.code, tail);
            free(tail);
        }
        cmd_free(&r);
        sl_free(&env);
    }

    if (!is_executable(electron)) {
        set_error("Electron is not installed (missing %s).", electron);
        goto out;
    }
    result = xstrdup(electron);
out:
    free(head);
    free(lock_hash);
    free(electron_pkg);
    free(script);
    free(electron);
    return result;
}

/* ------------------------------------------------------------ supervisor */

typedef struct {
    pid_t pid;
    int chan;            /* our end of the fd-3 socketpair */
    int out;             /* Electron's stdout+stderr */
    FILE *log;
    char *lines[OUTPUT_LINES];
    int line_count, line_start;
    char *partial;
    size_t partial_len;
    char *chan_buf;
    size_t chan_len;
    int reaped;
    int status;
    double kill_at;      /* SIGKILL deadline after a SIGTERM, 0 if none */
} Electron;

static Electron *volatile g_current;

static void output_push_line(Electron *e, const char *line, size_t len) {
    int idx;
    char *copy = malloc(len + 1);
    memcpy(copy, line, len);
    copy[len] = 0;
    if (e->line_count < OUTPUT_LINES) {
        idx = (e->line_start + e->line_count) % OUTPUT_LINES;
        e->line_count++;
    } else {
        idx = e->line_start;
        free(e->lines[idx]);
        e->line_start = (e->line_start + 1) % OUTPUT_LINES;
    }
    e->lines[idx] = copy;
}

static void output_append(Electron *e, const char *data, size_t n) {
    size_t i, start = 0;
    if (e->log) { fwrite(data, 1, n, e->log); fflush(e->log); }
    for (i = 0; i < n; i++) {
        if (data[i] != '\n') continue;
        append_buf(&e->partial, &e->partial_len, data + start, i - start);
        output_push_line(e, e->partial ? e->partial : "", e->partial_len);
        free(e->partial);
        e->partial = NULL;
        e->partial_len = 0;
        start = i + 1;
    }
    if (start < n) append_buf(&e->partial, &e->partial_len, data + start, n - start);
}

static StrList output_last_lines(Electron *e) {
    StrList out = {0};
    int i, total = e->line_count + (e->partial_len ? 1 : 0), skip = total > OUTPUT_LINES ? total - OUTPUT_LINES : 0;
    for (i = 0; i < e->line_count; i++) {
        if (skip > 0) { skip--; continue; }
        sl_push(&out, e->lines[(e->line_start + i) % OUTPUT_LINES]);
    }
    if (e->partial_len) sl_push(&out, e->partial);
    return out;
}

static int sandbox_usable(const char *electron) {
    /* Chromium's sandbox needs unprivileged user namespaces or a setuid
     * chrome-sandbox; without either (or as root) Electron must run with
     * --no-sandbox or it refuses to start. */
    char *helper;
    struct stat st;
    pid_t pid;
    int status = 0, setuid_ok;
    if (geteuid() == 0) return 0;
    helper = xasprintf("%s", electron);
    {
        char *slash = strrchr(helper, '/');
        if (slash) { *slash = 0; }
    }
    {
        char *path = xasprintf("%s/chrome-sandbox", helper);
        setuid_ok = stat(path, &st) == 0 && st.st_uid == 0 && (st.st_mode & S_ISUID);
        free(path);
    }
    free(helper);
    if (setuid_ok) return 1;
    pid = fork();
    if (pid == 0) {
        char map[64];
        int fd, len;
        uid_t uid = getuid();
        if (unshare(CLONE_NEWUSER) != 0) _exit(1);
        len = snprintf(map, sizeof(map), "0 %u 1\n", (unsigned)uid);
        fd = open("/proc/self/uid_map", O_WRONLY);
        if (fd < 0 || write(fd, map, (size_t)len) != len) _exit(1);
        _exit(0);
    }
    if (pid < 0) return 0;
    while (waitpid(pid, &status, 0) < 0 && errno == EINTR) {}
    return WIFEXITED(status) && WEXITSTATUS(status) == 0;
}

static Electron *electron_spawn(const char *executable, char **err) {
    Electron *e = calloc(1, sizeof(*e));
    int pair[2], outp[2], child_chan, rc;
    posix_spawn_file_actions_t fa;
    posix_spawnattr_t attr;
    sigset_t none, all;
    StrList argv = {0}, env = electron_environment();
    char *stamp;

    e->chan = e->out = -1;
    e->log = fopen(P.electron_log, "a");
    stamp = iso_now();
    {
        char *header = xasprintf("\n===== launch %s =====\n", stamp);
        output_append(e, header, strlen(header));
        free(header);
    }
    free(stamp);
    if (socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0, pair) != 0 || pipe2(outp, O_CLOEXEC) != 0) {
        *err = xasprintf("socketpair failed: %s", strerror(errno));
        sl_free(&env);
        free(e);
        return NULL;
    }
    /* Keep the child's end above 3 so dup2 onto 3 is never a no-op (which would leave CLOEXEC set). */
    child_chan = fcntl(pair[1], F_DUPFD_CLOEXEC, 10);
    close(pair[1]);
    e->chan = pair[0];

    sl_push(&argv, executable);
    sl_push(&argv, P.app);
    if (!sandbox_usable(executable)) {
        LOG("supervisor: no usable Chromium sandbox here; starting Electron with --no-sandbox");
        sl_push(&argv, "--no-sandbox");
    }

    posix_spawn_file_actions_init(&fa);
    posix_spawn_file_actions_addopen(&fa, 0, "/dev/null", O_RDONLY, 0);
    posix_spawn_file_actions_adddup2(&fa, outp[1], 1);
    posix_spawn_file_actions_adddup2(&fa, outp[1], 2);
    posix_spawn_file_actions_adddup2(&fa, child_chan, 3);
    posix_spawn_file_actions_addchdir_np(&fa, P.app);
    posix_spawnattr_init(&attr);
    sigemptyset(&none);
    sigfillset(&all);
    posix_spawnattr_setsigmask(&attr, &none);
    posix_spawnattr_setsigdefault(&attr, &all);
    posix_spawnattr_setflags(&attr, POSIX_SPAWN_SETSIGMASK | POSIX_SPAWN_SETSIGDEF);
    rc = posix_spawn(&e->pid, executable, &fa, &attr, argv.items, env.items);
    posix_spawn_file_actions_destroy(&fa);
    posix_spawnattr_destroy(&attr);
    close(outp[1]);
    close(child_chan);
    sl_free(&argv);
    sl_free(&env);
    if (rc != 0) {
        *err = xasprintf("posix_spawn %s: %s", executable, strerror(rc));
        close(outp[0]);
        close(e->chan);
        if (e->log) fclose(e->log);
        free(e);
        return NULL;
    }
    e->out = outp[0];
    LOG("supervisor: spawned Electron pid %d", (int)e->pid);
    return e;
}

static void electron_send(Electron *e, const char *json_line) {
    size_t len = strlen(json_line), off = 0;
    if (e->chan < 0) return;
    while (off < len) {
        ssize_t w = send(e->chan, json_line + off, len - off, MSG_NOSIGNAL);
        if (w <= 0) {
            if (w < 0 && errno == EINTR) continue;
            break;
        }
        off += (size_t)w;
    }
}

static void electron_terminate(Electron *e) {
    if (e->reaped) return;
    kill(e->pid, SIGTERM);
    if (e->kill_at == 0) e->kill_at = now_seconds() + 8;
}

static void electron_free(Electron *e) {
    int i;
    if (e->chan >= 0) close(e->chan);
    if (e->out >= 0) close(e->out);
    if (e->log) fclose(e->log);
    for (i = 0; i < OUTPUT_LINES; i++) free(e->lines[i]);
    free(e->partial);
    free(e->chan_buf);
    free(e);
}

typedef enum { OUT_QUIT, OUT_RELAUNCH, OUT_CRASHED, OUT_FAILED } OutcomeKind;

typedef struct {
    OutcomeKind kind;
    double since_ready;
    char *detail;
    char *reason;
    StrList output;
} Outcome;

enum { T_READY_TIMEOUT, T_STABLE, T_SELF_TEST_QUIT, T_QUIT_TIMEOUT, T_EXIT_GRACE, T_COUNT };

static void handle_sign(Electron *e, const mj_value *msg) {
    const mj_value *id = mj_get(msg, "id");
    const char *commit = mj_get_string(msg, "commit");
    char id_text[64], *line, *head;
    if (id && id->type == MJ_NUMBER) {
        if (id->number == (double)(long long)id->number) snprintf(id_text, sizeof(id_text), "%lld", (long long)id->number);
        else snprintf(id_text, sizeof(id_text), "%.17g", id->number);
    } else if (id && id->type == MJ_STRING) {
        char *q = mj_quote(id->string);
        snprintf(id_text, sizeof(id_text), "%s", q);
        free(q);
    } else {
        strcpy(id_text, "null");
    }
    head = sign_head(commit);
    if (head) {
        char *q = mj_quote(head);
        line = xasprintf("{\"op\":\"sign-result\",\"id\":%s,\"ok\":true,\"commit\":%s}\n", id_text, q);
        free(q);
        free(head);
    } else {
        char *q = mj_quote(last_error());
        LOG("signing: refused: %s", last_error());
        line = xasprintf("{\"op\":\"sign-result\",\"id\":%s,\"ok\":false,\"error\":%s}\n", id_text, q);
        free(q);
    }
    electron_send(e, line);
    free(line);
}

static Outcome supervise(const char *electron_bin) {
    Outcome result;
    Electron *e;
    char *err = NULL, *spawned_head;
    double timers[T_COUNT] = {0};
    double ready_at = 0, now;
    char *pending_reason = NULL;
    int quit_requested = 0, announced = 0, announced_code = 0, exited = 0;

    memset(&result, 0, sizeof(result));
    spawned_head = GIT("rev-parse", "HEAD");
    if (!spawned_head) spawned_head = xstrdup("");
    e = electron_spawn(electron_bin, &err);
    if (!e) {
        result.kind = OUT_FAILED;
        result.reason = xasprintf("Stella could not be started: %s", err);
        free(err);
        free(spawned_head);
        return result;
    }
    g_current = e;
    timers[T_READY_TIMEOUT] = now_seconds() + O.ready_timeout;

    while (!exited) {
        struct pollfd fds[2];
        int nfds = 0, i, wait_ms = 200;
        char buf[16384];
        pid_t w;
        if (e->chan >= 0) { fds[nfds].fd = e->chan; fds[nfds].events = POLLIN; nfds++; }
        if (e->out >= 0) { fds[nfds].fd = e->out; fds[nfds].events = POLLIN; nfds++; }
        if (poll(fds, (nfds_t)nfds, wait_ms) > 0) {
            for (i = 0; i < nfds; i++) {
                ssize_t n;
                if (!(fds[i].revents & (POLLIN | POLLHUP | POLLERR))) continue;
                n = read(fds[i].fd, buf, sizeof(buf));
                if (n < 0 && (errno == EINTR || errno == EAGAIN)) continue;
                if (fds[i].fd == e->out) {
                    if (n <= 0) { close(e->out); e->out = -1; }
                    else output_append(e, buf, (size_t)n);
                    continue;
                }
                if (n <= 0) { close(e->chan); e->chan = -1; continue; }
                append_buf(&e->chan_buf, &e->chan_len, buf, (size_t)n);
                for (;;) {
                    char *nl = e->chan_buf ? memchr(e->chan_buf, '\n', e->chan_len) : NULL;
                    size_t line_len;
                    mj_value *msg;
                    const char *op;
                    if (!nl) break;
                    line_len = (size_t)(nl - e->chan_buf);
                    msg = mj_parse(e->chan_buf, line_len);
                    if (!msg) LOG("channel: ignored malformed line %.200s", e->chan_buf);
                    op = mj_get_string(msg, "op");
                    if (op && !strcmp(op, "ready")) {
                        if (ready_at == 0) {
                            ready_at = now_seconds();
                            LOG("supervisor: ready");
                            timers[T_STABLE] = ready_at + O.stable_seconds;
                            if (O.self_test) timers[T_SELF_TEST_QUIT] = ready_at + O.hold;
                        }
                    } else if (op && !strcmp(op, "sign")) {
                        handle_sign(e, msg);
                    } else if (op && !strcmp(op, "exiting")) {
                        double code = 0;
                        mj_get_number(msg, "code", &code);
                        announced = 1;
                        announced_code = (int)code;
                        LOG("supervisor: Electron is exiting with %d", announced_code);
                        timers[T_EXIT_GRACE] = now_seconds() + 10;
                    } else if (op && !strcmp(op, "failed")) {
                        const char *reason = mj_get_string(msg, "reason");
                        LOG("supervisor: Electron reported failure: %s", reason ? reason : "unknown");
                        if (!pending_reason) {
                            pending_reason = xasprintf("Stella reported a problem: %s", reason ? reason : "unknown");
                            electron_terminate(e);
                        }
                    } else if (msg) {
                        LOG("supervisor: ignored message %.*s", (int)line_len, e->chan_buf);
                    }
                    mj_free(msg);
                    e->chan_len -= line_len + 1;
                    memmove(e->chan_buf, nl + 1, e->chan_len);
                }
            }
        }

        now = now_seconds();
        for (i = 0; i < T_COUNT; i++) {
            if (timers[i] == 0 || now < timers[i]) continue;
            timers[i] = 0;
            switch (i) {
            case T_READY_TIMEOUT:
                if (ready_at == 0 && !pending_reason) {
                    LOG("supervisor: no ready within %ds", (int)O.ready_timeout);
                    pending_reason = xasprintf("Stella didn't finish starting within %d seconds.", (int)O.ready_timeout);
                    electron_terminate(e);
                }
                break;
            case T_STABLE:
                if (!pending_reason && *spawned_head) {
                    char *out = GIT("update-ref", KNOWN_GOOD_REF, spawned_head);
                    if (out) LOG("supervisor: %ds stable; %s = %.12s", (int)O.stable_seconds, KNOWN_GOOD_REF, spawned_head);
                    else LOG("supervisor: could not mark known-good: %s", last_error());
                    free(out);
                }
                break;
            case T_SELF_TEST_QUIT:
                LOG("supervisor: self-test asks Electron to quit");
                quit_requested = 1;
                electron_send(e, "{\"op\":\"quit\"}\n");
                timers[T_QUIT_TIMEOUT] = now + 30;
                break;
            case T_QUIT_TIMEOUT:
                if (!announced) {
                    LOG("supervisor: Electron did not quit in time; terminating");
                    electron_terminate(e);
                }
                break;
            case T_EXIT_GRACE:
                LOG("supervisor: Electron's teardown is still running 10s after it announced its exit; terminating");
                electron_terminate(e);
                break;
            }
        }
        if (e->kill_at && now > e->kill_at && !e->reaped) {
            kill(e->pid, SIGKILL);
            e->kill_at = 0;
        }

        w = waitpid(e->pid, &e->status, WNOHANG);
        if (w == e->pid) {
            double drain_until = now_seconds() + 0.3;
            e->reaped = 1;
            exited = 1;
            /* Give the output reader a moment to drain the pipe. */
            if (e->out >= 0) fcntl(e->out, F_SETFL, O_NONBLOCK);
            while (e->out >= 0 && now_seconds() < drain_until) {
                ssize_t n = read(e->out, buf, sizeof(buf));
                if (n > 0) output_append(e, buf, (size_t)n);
                else if (n == 0) break;
                else usleep(20 * 1000);
            }
        }
    }

    {
        int code = WIFEXITED(e->status) ? WEXITSTATUS(e->status) : -1;
        int sig = WIFSIGNALED(e->status) ? WTERMSIG(e->status) : 0;
        char *detail = sig ? xasprintf("signal %d", sig) : xasprintf("exit %d", code);
        StrList output = output_last_lines(e);
        LOG("supervisor: Electron exited (%s)", detail);
        g_current = NULL;
        electron_free(e);
        result.output = output;
        result.detail = detail;
        if (pending_reason) {
            result.kind = OUT_FAILED;
            result.reason = pending_reason;
            goto done;
        }
        /* A hung teardown killed after the announcement counts as the announced exit. */
        if (announced) { code = announced_code; sig = 0; }
        if (sig == 0 && code == RELAUNCH_EXIT_CODE) { result.kind = OUT_RELAUNCH; goto done; }
        if (quit_requested && !(sig == 0 && code == 0)) {
            result.kind = OUT_FAILED;
            result.reason = xasprintf("Stella didn't quit cleanly when asked (%s).", detail);
            goto done;
        }
        if (sig == 0 && code == 0) {
            if (ready_at == 0 && O.self_test) {
                result.kind = OUT_FAILED;
                result.reason = xstrdup("Stella quit before it finished starting.");
            } else {
                result.kind = OUT_QUIT;
            }
            goto done;
        }
        if (ready_at == 0) {
            result.kind = OUT_FAILED;
            result.reason = xasprintf("Stella stopped before it finished starting (%s).", detail);
            goto done;
        }
        result.kind = OUT_CRASHED;
        result.since_ready = now_seconds() - ready_at;
    }
done:
    free(spawned_head);
    return result;
}

/* -------------------------------------------------------------- recovery */

static int has_known_good(void) {
    CmdResult r;
    int ok;
    if (!g_git || !file_exists(P.app)) return 0;
    if (git_raw((const char *const[]){"rev-parse", "--verify", "--quiet", KNOWN_GOOD_REF "^{commit}", NULL}, P.app,
                NULL, &r) != 0)
        return 0;
    ok = r.code == 0;
    cmd_free(&r);
    return ok;
}

static int reinstall(void) {
    if (file_exists(P.app)) {
        char *aside = xasprintf("%s/app.previous-%ld", P.root, (long)time(NULL));
        if (rename(P.app, aside) != 0) {
            set_error("could not move the old checkout aside: %s", strerror(errno));
            free(aside);
            return -1;
        }
        LOG("recovery: moved the old checkout to %s", aside);
        free(aside);
    }
    if (clone_source() != 0) return -1;
    {
        char *head = sign_head(NULL);
        if (!head) return -1;
        free(head);
    }
    state_reset_install();
    return 0;
}

/* A forward commit back to the known-good tree: nothing is rewritten, so the
 * fork still fast-forwards. Uncommitted edits are stashed, not lost. */
static int return_to_known_good(void) {
    StrList dirty = {0};
    char *head, *known_tree, *head_tree, *signed_head;
    if (!has_known_good()) return reinstall();
    if (changed_files(&dirty) != 0) return -1;
    if (dirty.count) {
        char *stamp = iso_now(), *msg = xasprintf("Stella recovery %s", stamp);
        char *out = git_run((const char *const[]){"stash", "push", "--include-untracked", "-m", msg, NULL}, P.app,
                            IDENTITY_ENV);
        free(stamp);
        free(msg);
        sl_free(&dirty);
        if (!out) return -1;
        free(out);
        LOG("recovery: stashed uncommitted changes");
    }
    head = GIT("rev-parse", "HEAD");
    known_tree = GIT("rev-parse", KNOWN_GOOD_REF "^{tree}");
    head_tree = GIT("rev-parse", "HEAD^{tree}");
    if (!head || !known_tree || !head_tree) { free(head); free(known_tree); free(head_tree); return -1; }
    if (strcmp(known_tree, head_tree) != 0) {
        char *commit = git_run((const char *const[]){"commit-tree", known_tree, "-p", head, "-m",
                                                     "Return to the last working version", NULL},
                               P.app, IDENTITY_ENV);
        char *merged = commit ? GIT("merge", "--ff-only", commit) : NULL;
        if (!merged) { free(commit); free(head); free(known_tree); free(head_tree); return -1; }
        LOG("recovery: returned to known-good tree %.12s as %.12s", known_tree, commit);
        free(merged);
        free(commit);
    }
    free(head); free(known_tree); free(head_tree);
    signed_head = sign_head(NULL);
    if (!signed_head) return -1;
    free(signed_head);
    return 0;
}

/* ---------------------------------------------------------------- launcher */

static int g_recovery_count;

static Choice recover(const char *reason, const StrList *output) {
    Choice automation = CHOICE_NONE, choice;
    double delay = 0;
    int forced_exit = 0;
    char *capture = NULL;
    g_recovery_count++;
    if (O.self_test) {
        if (O.recovery_choice != CHOICE_NONE && g_recovery_count == 1) { automation = O.recovery_choice; delay = 2; }
        else { automation = CHOICE_QUIT; delay = 1.5; forced_exit = 1; }
    }
    if (O.capture_dir) capture = xasprintf("%s/recovery-%d.png", O.capture_dir, g_recovery_count);
    choice = recovery_present(reason, output, has_known_good(), capture, automation, delay);
    free(capture);
    if (forced_exit) LOG("launcher: self-test failed: %s", reason);
    return choice;
}

static char *refusal_message(Verdict v, const StrList *dirty) {
    switch (v) {
    case V_DIRTY:
        return xasprintf("Stella's files were changed outside of Stella's updates, so it won't run them "
                         "(%zu changed: %s%s).",
                         dirty->count, dirty->count ? trim(dirty->items[0]) : "", dirty->count > 1 ? ", ..." : "");
    case V_UNSIGNED:
        return xstrdup("This version of Stella wasn't installed through Stella's updates (it has no signature), so it won't run.");
    case V_BAD_SIGNATURE:
        return xstrdup("This version of Stella has an invalid signature, so it won't run.");
    default:
        return xasprintf("Stella's files could not be checked: %s", last_error());
    }
}

/* Install, verify, prepare. Returns the Electron binary, or NULL with the error set. */
static char *prepare_for_launch(void) {
    char *git_dir;
    StrList dirty = {0};
    Verdict v;
    mkdirs(P.root, 0755);
    mkdirs(P.logs, 0755);
    mkdirs(P.runtimes, 0755);
    if (ensure_git() != 0) return NULL;
    if (!g_signer && !(g_signer = signer_create())) return NULL;

    git_dir = xasprintf("%s/.git", P.app);
    if (!file_exists(git_dir)) {
        char *head;
        free(git_dir);
        if (clone_source() != 0) return NULL;
        /* The initial clone is signed at install. */
        if (!(head = sign_head(NULL))) return NULL;
        free(head);
        state_reset_install();
    } else {
        free(git_dir);
    }
    if (!P.isolated && !O.self_test) install_desktop_entry();

    v = verify_head(&dirty);
    if (v != V_SIGNED) {
        char *msg = refusal_message(v, &dirty);
        LOG("verify: refused (%d)", (int)v);
        set_error("%s", msg);
        free(msg);
        sl_free(&dirty);
        return NULL;
    }
    LOG("verify: HEAD signed and clean");
    if (ensure_bun() != 0) return NULL;
    return prepare();
}

static int launcher_run(void) {
    double crash_times[8];
    int crash_count = 0;
    LOG("launcher: start root=%s selfTest=%d pid=%d", P.root, O.self_test, (int)getpid());
    for (;;) {
        char *reason = NULL;
        StrList output = {0};
        char *electron = prepare_for_launch();
        Choice choice;
        if (electron) {
            Outcome outcome;
            progress_hide();
            outcome = supervise(electron);
            free(electron);
            switch (outcome.kind) {
            case OUT_QUIT:
                LOG("launcher: Stella quit; exiting");
                return 0;
            case OUT_RELAUNCH:
                LOG("launcher: relaunch requested");
                sl_free(&outcome.output);
                free(outcome.detail);
                continue;
            case OUT_CRASHED: {
                double now = now_seconds();
                int i, kept = 0;
                if (outcome.since_ready < O.stable_seconds) {
                    for (i = 0; i < crash_count; i++)
                        if (now - crash_times[i] < O.stable_seconds * 2) crash_times[kept++] = crash_times[i];
                    crash_count = kept;
                    if (crash_count < 8) crash_times[crash_count++] = now;
                }
                LOG("launcher: Stella crashed %ds after ready (%s); recent early crashes %d", (int)outcome.since_ready,
                    outcome.detail, crash_count);
                if (crash_count >= 2) {
                    crash_count = 0;
                    reason = xasprintf("Stella crashed twice shortly after starting (%s).", outcome.detail);
                    output = outcome.output;
                    free(outcome.detail);
                } else {
                    sl_free(&outcome.output);
                    free(outcome.detail);
                    continue;
                }
                break;
            }
            case OUT_FAILED:
                reason = outcome.reason;
                output = outcome.output;
                free(outcome.detail);
                break;
            }
        } else {
            /* First line is the message; any detail (a command's output) goes to the output pane. */
            char *copy = xstrdup(last_error()), *nl = strchr(copy, '\n');
            if (nl) {
                char *line, *save = NULL;
                *nl = 0;
                for (line = strtok_r(nl + 1, "\n", &save); line; line = strtok_r(NULL, "\n", &save)) sl_push(&output, line);
                while (output.count > OUTPUT_LINES) {
                    free(output.items[0]);
                    memmove(output.items, output.items + 1, output.count * sizeof(char *));
                    output.count--;
                }
            }
            reason = xstrdup(copy);
            free(copy);
        }

        progress_hide();
        LOG("launcher: failure: %s", reason);
        choice = recover(reason, &output);
        free(reason);
        sl_free(&output);
        switch (choice) {
        case CHOICE_QUIT:
        case CHOICE_NONE:
            return 1;
        case CHOICE_RETRY:
            continue;
        case CHOICE_RETURN:
            if (return_to_known_good() != 0) LOG("recovery: return failed: %s", last_error());
            break;
        case CHOICE_REINSTALL:
            if (reinstall() != 0) LOG("recovery: reinstall failed: %s", last_error());
            break;
        }
    }
}

/* ------------------------------------------------------------------ main */

static void on_signal(int sig) {
    Electron *e = g_current;
    if (e && !e->reaped) kill(e->pid, SIGTERM);
    _exit(128 + sig);
}

static gpointer worker(gpointer data) {
    int code;
    (void)data;
    code = launcher_run();
    LOG("launcher: exit %d", code);
    exit(code);
    return NULL;
}

int main(int argc, char **argv) {
    int lock_fd;
    struct sigaction sa;

    paths_resolve();
    mkdirs(P.logs, 0755);
    log_file = fopen(P.launcher_log, "a");
    if (log_file) fcntl(fileno(log_file), F_SETFD, FD_CLOEXEC);
    parse_options(argc, argv);

    /* One launcher per install root. */
    lock_fd = open(P.lock_file, O_CREAT | O_RDWR | O_CLOEXEC, 0600);
    if (lock_fd < 0 || flock(lock_fd, LOCK_EX | LOCK_NB) != 0) {
        LOG("launcher: another launcher owns %s; exiting", P.root);
        return O.self_test ? 1 : 0;
    }
    state_load();

    memset(&sa, 0, sizeof(sa));
    sa.sa_handler = on_signal;
    sigaction(SIGTERM, &sa, NULL);
    sigaction(SIGINT, &sa, NULL);
    sigaction(SIGHUP, &sa, NULL);
    signal(SIGPIPE, SIG_IGN);

    g_set_prgname("stella");
    g_ui = gtk_init_check(&argc, &argv);
    if (!g_ui) {
        LOG("launcher: no display; running without windows");
        worker(NULL);
        return 0;
    }
    g_set_application_name("Stella");
    gtk_window_set_default_icon_name("stella");
    g_thread_new("launcher", worker, NULL);
    gtk_main();
    return 0;
}
