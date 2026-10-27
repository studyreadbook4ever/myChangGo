#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/mount.h>
#include <sys/reboot.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/statfs.h>
#include <sys/types.h>
#include <sys/un.h>
#include <sys/utsname.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#define HUGETLBFS_MAGIC 0x958458f6UL
#define SLOT_BYTES (4UL * 1024 * 1024)
#define SOCKET_PATH "/run/hugekeeper/test.sock"
static int failures, checks;
static pid_t daemon_pid;

static uint64_t now_ns(void) {
    struct timespec now;
    if (clock_gettime(CLOCK_MONOTONIC, &now) < 0) return 0;
    return (uint64_t)now.tv_sec * 1000000000ULL + (uint64_t)now.tv_nsec;
}

static void check(bool ok, const char *name) {
    ++checks;
    printf("%s %02d %s\n", ok ? "PASS" : "FAIL", checks, name);
    if (!ok) ++failures;
}

static long meminfo(const char *key) {
    FILE *f = fopen("/proc/meminfo", "r");
    if (!f) return -1;
    char line[256]; long value = -1;
    while (fgets(line, sizeof(line), f)) {
        if (!strncmp(line, key, strlen(key))) {
            (void)sscanf(line + strlen(key), "%ld", &value); break;
        }
    }
    fclose(f); return value;
}

static bool reserve_hugepages(unsigned pages) {
    FILE *f = fopen("/proc/sys/vm/nr_hugepages", "w");
    if (!f) return false;
    bool result = fprintf(f, "%u\n", pages) > 0;
    return fclose(f) == 0 && result;
}

static int connect_to(bool admin) {
    int s = socket(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC, 0);
    if (s < 0) return -1;
    struct sockaddr_un a = {.sun_family = AF_UNIX};
    snprintf(a.sun_path, sizeof(a.sun_path), "%s%s", SOCKET_PATH, admin ? ".admin" : "");
    struct timeval tv = {.tv_sec = 3};
    (void)setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
    (void)setsockopt(s, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));
    if (connect(s, (struct sockaddr *)&a, sizeof(a)) < 0) { close(s); return -1; }
    return s;
}

static bool request(int s, const char *cmd, char *response, int *received_fd) {
    if (received_fd) *received_fd = -1;
    if (s < 0 || send(s, cmd, strlen(cmd), MSG_NOSIGNAL) != (ssize_t)strlen(cmd)) return false;
    union { struct cmsghdr align; char data[CMSG_SPACE(sizeof(int) * 8)]; } control;
    struct iovec iov = {.iov_base = response, .iov_len = 4095};
    struct msghdr msg = {.msg_iov = &iov, .msg_iovlen = 1,
                        .msg_control = control.data, .msg_controllen = sizeof(control.data)};
    ssize_t n = recvmsg(s, &msg, MSG_CMSG_CLOEXEC);
    if (n < 0) { response[0] = 0; return false; }
    response[n] = 0;
    for (struct cmsghdr *h = CMSG_FIRSTHDR(&msg); h; h = CMSG_NXTHDR(&msg, h)) {
        if (h->cmsg_level == SOL_SOCKET && h->cmsg_type == SCM_RIGHTS) {
            size_t count = (h->cmsg_len - CMSG_LEN(0)) / sizeof(int);
            int *fds = (int *)CMSG_DATA(h);
            for (size_t i = 0; i < count; ++i) {
                if (received_fd && *received_fd < 0) *received_fd = fds[i]; else close(fds[i]);
            }
        }
    }
    return !(msg.msg_flags & (MSG_TRUNC | MSG_CTRUNC));
}

static bool ok(const char *s) {
    return strstr(s, "\"ok\":true") || strstr(s, "\"ok\": true");
}

static long field(const char *json, const char *name) {
    char key[80]; snprintf(key, sizeof(key), "\"%s\"", name);
    const char *p = strstr(json, key);
    if (!p || !(p = strchr(p, ':'))) return -1;
    return strtol(p + 1, NULL, 10);
}

static bool command(int s, const char *cmd) {
    char response[4096] = {0};
    bool result = request(s, cmd, response, NULL) && ok(response);
    if (!result) printf("DETAIL %s -> %s\n", cmd, response);
    return result;
}

static int acquire(int s, long *lease) {
    char response[4096] = {0}; int fd = -1;
    bool result = request(s, "ACQUIRE", response, &fd) && ok(response);
    if (!result) printf("DETAIL ACQUIRE -> %s\n", response);
    if (lease) *lease = field(response, "lease");
    return result ? fd : -1;
}

static bool sigbus_on_read(volatile unsigned char *p) {
    pid_t child = fork();
    if (!child) { volatile unsigned char value = p[0]; (void)value; _exit(77); }
    int status = 0;
    return child > 0 && waitpid(child, &status, 0) == child &&
           WIFSIGNALED(status) && WTERMSIG(status) == SIGBUS;
}

static bool zeroed(const unsigned char *p) {
    for (size_t i = 0; i < SLOT_BYTES; ++i) if (p[i]) return false;
    return true;
}

static bool no_effective_capabilities(void) {
    FILE *f = fopen("/proc/self/status", "r");
    if (!f) return false;
    char line[256]; unsigned long long capabilities = 1;
    while (fgets(line, sizeof(line), f))
        if (sscanf(line, "CapEff:\t%llx", &capabilities) == 1) break;
    fclose(f);
    return capabilities == 0;
}

static void unprivileged_worker(int channel, bool allowed) {
    unsigned flags = 0;
    if (setgroups(0, NULL) == 0 && setgid(65534) == 0 && setuid(65534) == 0 &&
        geteuid() == 65534 && getegid() == 65534) flags |= 1;
    if (no_effective_capabilities() && getgroups(0, NULL) == 0) flags |= 2;
    int admin = connect_to(true);
    if (admin < 0) flags |= 4;
    else close(admin);
    int client = connect_to(false), fd = -1;
    unsigned char *mapping = MAP_FAILED;
    char response[4096] = {0};
    if (!allowed) {
        if (client >= 0 && request(client, "ACQUIRE", response, &fd) &&
            !ok(response) && strstr(response, "denied") && fd < 0) flags |= 8;
    } else {
        fd = acquire(client, NULL);
        if (fd >= 0) {
            mapping = mmap(NULL, SLOT_BYTES, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
            struct statfs fs;
            if (mapping != MAP_FAILED && fstatfs(fd, &fs) == 0 &&
                (unsigned long)fs.f_type == HUGETLBFS_MAGIC) {
                mapping[0] = 0x19; mapping[SLOT_BYTES - 1] = 0x51;
                if (mapping[0] == 0x19 && mapping[SLOT_BYTES - 1] == 0x51) flags |= 8;
            }
        }
    }
    (void)send(channel, &flags, sizeof(flags), MSG_NOSIGNAL);
    if (allowed) {
        char continuation;
        flags = 0;
        if (recv(channel, &continuation, 1, 0) == 1) {
            struct stat st;
            if (fd >= 0 && fstat(fd, &st) == 0 && st.st_size == 0) flags |= 1;
            if (mapping != MAP_FAILED && sigbus_on_read(mapping)) flags |= 2;
            int another_fd = -1;
            if (request(client, "ACQUIRE", response, &another_fd) &&
                !ok(response) && strstr(response, "denied") && another_fd < 0) flags |= 4;
            if (another_fd >= 0) close(another_fd);
        }
        (void)send(channel, &flags, sizeof(flags), MSG_NOSIGNAL);
    }
    if (mapping != MAP_FAILED) munmap(mapping, SLOT_BYTES);
    if (fd >= 0) close(fd);
    if (client >= 0) close(client);
    close(channel);
    _exit(0);
}

static void multi_uid_tests(int admin) {
    for (int allowed = 0; allowed <= 1; ++allowed) {
        if (allowed) check(command(admin, "ALLOW 65534"), "admin grants HugeTLB access to UID 65534");
        int pair[2];
        if (socketpair(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC, 0, pair) < 0) {
            check(false, "create unprivileged test control channel"); return;
        }
        struct timeval timeout = {.tv_sec = 5};
        (void)setsockopt(pair[0], SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));
        (void)setsockopt(pair[1], SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));
        pid_t child = fork();
        if (!child) {
            close(pair[0]);
            close(admin); /* Do not inherit the parent's already-authorized control capability. */
            unprivileged_worker(pair[1], allowed != 0);
        }
        close(pair[1]);
        unsigned flags = 0;
        bool reported = child > 0 && recv(pair[0], &flags, sizeof(flags), 0) == sizeof(flags);
        check(reported && (flags & 1), "worker runs with distinct unprivileged UID and GID 65534");
        check(reported && (flags & 2), "unprivileged worker has no effective capabilities or supplementary groups");
        check(reported && (flags & 4), "unprivileged worker cannot open the admin socket");
        check(reported && (flags & 8), allowed ? "allowed unprivileged worker maps and writes real HugeTLB memory" :
                                                    "unlisted UID 65534 reaches data socket but acquisition is denied");
        if (allowed) {
            char response[4096] = {0};
            check(request(admin, "STATUS", response, NULL) && ok(response) && field(response, "uid") == 65534,
                  "broker authenticates lease UID from kernel peer credentials");
            check(command(admin, "DENY 65534"), "admin denies UID 65534 while its mapping is active");
            (void)send(pair[0], "x", 1, MSG_NOSIGNAL);
            flags = 0;
            reported = recv(pair[0], &flags, sizeof(flags), 0) == sizeof(flags);
            check(reported && (flags & 1), "DENY truncates the unprivileged client's retained FD");
            check(reported && (flags & 2), "unprivileged retained HugeTLB mapping raises SIGBUS after DENY");
            check(reported && (flags & 4), "denied unprivileged connection cannot reacquire");
        }
        close(pair[0]);
        if (child > 0) {
            if (!reported) (void)kill(child, SIGKILL);
            int status = 0;
            check(waitpid(child, &status, 0) == child && WIFEXITED(status) && WEXITSTATUS(status) == 0,
                  "unprivileged worker exits cleanly");
        }
    }
}

static void stop_daemon(void) {
    if (daemon_pid <= 0) return;
    (void)kill(daemon_pid, SIGTERM);
    int status = 0;
    bool ended = false;
    for (int i = 0; i < 500; ++i) {
        if (waitpid(daemon_pid, &status, WNOHANG) == daemon_pid) { ended = true; break; }
        usleep(10000);
    }
    check(ended && WIFEXITED(status) && WEXITSTATUS(status) == 0, "graceful daemon shutdown");
    if (!ended) { (void)kill(daemon_pid, SIGKILL); (void)waitpid(daemon_pid, NULL, 0); }
    daemon_pid = 0;
}

static void automatic_maximum_tests(void) {
    int master = posix_openpt(O_RDWR | O_NOCTTY | O_NONBLOCK | O_CLOEXEC);
    bool terminal_ok = master >= 0 && grantpt(master) == 0 && unlockpt(master) == 0;
    int slave = terminal_ok ? open(ptsname(master), O_RDWR | O_NOCTTY | O_CLOEXEC) : -1;
    check(slave >= 0, "create actual guest terminal for maximum-size confirmation");
    if (slave < 0) { if (master >= 0) close(master); return; }
    daemon_pid = fork();
    if (!daemon_pid) {
        close(master);
        if (dup2(slave, STDIN_FILENO) < 0 || dup2(slave, STDOUT_FILENO) < 0 ||
            dup2(slave, STDERR_FILENO) < 0) _exit(126);
        close(slave);
        execl("/hugekeeperd", "hugekeeperd", "--socket", SOCKET_PATH,
              "--backend", "hugetlb", "--max-mib", "64", "--allow-uid", "0", (char *)NULL);
        _exit(127);
    }
    close(slave);
    char transcript[8192] = {0}; size_t used = 0;
    for (int i = 0; i < 500 && !strstr(transcript, "[y/N]"); ++i) {
        ssize_t received = read(master, transcript + used, sizeof(transcript) - used - 1);
        if (received > 0) { used += (size_t)received; transcript[used] = 0; }
        usleep(10000);
    }
    bool prompted = strstr(transcript, "[y/N]") && strstr(transcript, "--pages");
    printf("STARTUP terminal %s\n", transcript);
    check(prompted, "missing page count prompts on a real guest terminal");
    check(meminfo("HugePages_Free:") == 16 && access(SOCKET_PATH, F_OK) < 0,
          "maximum-mode prompt does not allocate pages or publish a socket before consent");
    check(write(master, "yes\n", 4) == 4, "explicit yes confirms guest maximum allocation");
    int admin = -1;
    for (int i = 0; i < 500 && admin < 0; ++i) { admin = connect_to(true); if (admin < 0) usleep(10000); }
    char response[4096] = {0};
    bool ready = admin >= 0 && request(admin, "STATUS", response, NULL) && ok(response);
    printf("STATUS automatic_maximum %s\n", response);
    check(ready && field(response, "pool_bytes") == 32 * 1024 * 1024 &&
          field(response, "ready") == field(response, "capacity") && field(response, "degraded") == 0,
          "confirmed maximum consumes exactly the 16 available guest HugeTLB pages");
    check(ready && meminfo("HugePages_Free:") == 0, "automatic maximum has real physical HugeTLB backing");
    if (admin >= 0) close(admin);
    stop_daemon();
    for (;;) {
        ssize_t received = read(master, transcript + used, sizeof(transcript) - used - 1);
        if (received <= 0) break;
        used += (size_t)received; transcript[used] = 0;
    }
    printf("STARTUP terminal_complete %s\n", transcript);
    close(master);
    check(meminfo("HugePages_Free:") == 16, "maximum-mode shutdown returns every guest HugeTLB page");
}

static void tests(void) {
    char response[4096] = {0}, cmd[128];
    bool reserved = reserve_hugepages(16);
    check(reserved && meminfo("HugePages_Total:") == 16, "guest reserves 16 real 2 MiB HugeTLB pages");
    printf("METRIC guest_hugepages_total=%ld guest_hugepages_free=%ld\n",
           meminfo("HugePages_Total:"), meminfo("HugePages_Free:"));
    if (!reserved || meminfo("HugePages_Total:") != 16) return;
    daemon_pid = fork();
    if (!daemon_pid) {
        execl("/hugekeeperd", "hugekeeperd", "--socket", SOCKET_PATH,
              "--backend", "hugetlb", "--pages", "4", "--slots", "2",
              "--allow-uid", "0", "--max-mib", "64", (char *)NULL);
        perror("exec hugekeeperd"); _exit(127);
    }
    int admin = -1;
    for (int i = 0; i < 500 && admin < 0; ++i) { admin = connect_to(true); if (admin < 0) usleep(10000); }
    check(admin >= 0, "HugeTLB daemon starts");
    if (admin < 0) { stop_daemon(); return; }
    bool status_ok = request(admin, "STATUS", response, NULL) && ok(response);
    printf("STATUS initial %s\n", response);
    check(status_ok && strstr(response, "hugetlb") && field(response, "ready") == 2,
          "two prefaulted HugeTLB slots ready");
    check(meminfo("HugePages_Free:") == 12, "8 MiB physically allocated from HugeTLB pool before acquisition");
    multi_uid_tests(admin);

    int client = connect_to(false); long lease = -1;
    int fd = acquire(client, &lease);
    check(fd >= 0 && lease > 0, "acquire passes a lease FD");
    if (fd < 0) { close(client); close(admin); stop_daemon(); return; }
    struct statfs fs;
    check(fstatfs(fd, &fs) == 0 && (unsigned long)fs.f_type == HUGETLBFS_MAGIC,
          "lease FD belongs to hugetlbfs, not THP or ordinary pages");
    int seals = fcntl(fd, F_GET_SEALS);
    check(seals >= 0 && (seals & (F_SEAL_GROW | F_SEAL_SEAL)) == (F_SEAL_GROW | F_SEAL_SEAL),
          "lease sealed against regrowth and hostile added seals");
    check(fcntl(fd, F_ADD_SEALS, F_SEAL_SHRINK) < 0 && errno == EPERM,
          "client cannot seal against broker revocation");
    unsigned char *mapping = mmap(NULL, SLOT_BYTES, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    check(mapping != MAP_FAILED, "map actual HugeTLB lease");
    if (mapping == MAP_FAILED) { close(fd); close(client); close(admin); stop_daemon(); return; }
    check(zeroed(mapping), "new HugeTLB lease is entirely zeroed");
    memset(mapping, 0xa5, SLOT_BYTES);
    check(mapping[0] == 0xa5 && mapping[SLOT_BYTES - 1] == 0xa5, "direct memory access spans both huge pages");
    unsigned char *private_mapping = mmap(NULL, SLOT_BYTES, PROT_READ | PROT_WRITE, MAP_PRIVATE, fd, 0);
    check(private_mapping != MAP_FAILED, "client can create a private HugeTLB alias");
    if (private_mapping != MAP_FAILED) private_mapping[0] = 0x5a;
    snprintf(cmd, sizeof(cmd), "REVOKE %ld", lease);
    check(command(admin, cmd), "admin revokes live HugeTLB lease");
    struct stat st;
    check(fstat(fd, &st) == 0 && st.st_size == 0, "revoked inode is truncated to zero");
    check(ftruncate(fd, SLOT_BYTES) < 0 && errno == EPERM, "stale FD cannot regrow");
    check(sigbus_on_read(mapping), "stale actual HugeTLB mapping raises SIGBUS");
    if (private_mapping != MAP_FAILED) {
        check(sigbus_on_read(private_mapping), "revocation also invalidates private COW HugeTLB alias");
        munmap(private_mapping, SLOT_BYTES);
    }
    munmap(mapping, SLOT_BYTES); close(fd);

    fd = acquire(client, &lease);
    check(fd >= 0, "same connection can acquire a fresh generation");
    if (fd >= 0) {
        mapping = mmap(NULL, SLOT_BYTES, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
        check(mapping != MAP_FAILED && zeroed(mapping), "replacement contains no previous tenant data");
        check(command(admin, "DENY 0"), "DENY revokes active UID leases");
        if (mapping != MAP_FAILED) {
            check(sigbus_on_read(mapping), "DENY invalidates active HugeTLB mappings");
            munmap(mapping, SLOT_BYTES);
        }
        close(fd);
    }
    int denied_fd = -1;
    bool denied = request(client, "ACQUIRE", response, &denied_fd) && !ok(response) && strstr(response, "denied");
    if (denied_fd >= 0) close(denied_fd);
    check(denied, "denied UID cannot reacquire");
    check(command(admin, "ALLOW 0"), "ALLOW restores future acquisitions");
    check(command(admin, "RESIZE 4"), "pool grows to four slots");
    check(meminfo("HugePages_Free:") == 8, "growth allocates 16 MiB of actual HugeTLB memory");
    check(command(admin, "RESIZE 1"), "pool shrinks to one idle slot");
    check(meminfo("HugePages_Free:") == 14, "shrink returns 12 MiB to guest HugeTLB pool");
    bool exhausted = request(admin, "RESIZE 9", response, NULL) && !ok(response) && strstr(response, "allocation");
    check(exhausted, "growth exceeding physical HugeTLB availability fails cleanly");
    check(request(admin, "STATUS", response, NULL) && ok(response) && field(response, "capacity") == 1 &&
          field(response, "ready") == 1 && meminfo("HugePages_Free:") == 14,
          "failed growth rolls back all partially allocated HugeTLB pages");

    fd = acquire(client, &lease);
    check(fd >= 0, "acquire slot for deterministic guest pool exhaustion");
    if (fd >= 0) {
        mapping = mmap(NULL, SLOT_BYTES, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
        check(reserve_hugepages(0), "guest retires its persistent HugeTLB pool while a lease is active");
        snprintf(cmd, sizeof(cmd), "REVOKE %ld", lease);
        check(command(admin, cmd), "revocation succeeds even when replacement allocation is impossible");
        check(request(admin, "STATUS", response, NULL) && ok(response) && field(response, "capacity") == 1 &&
              field(response, "degraded") == 1 && field(response, "ready") == 0 && field(response, "leased") == 0,
              "unreplenished slot is reported as degraded, not ready");
        if (mapping != MAP_FAILED) {
            check(sigbus_on_read(mapping), "degraded refill does not weaken old mapping revocation");
            munmap(mapping, SLOT_BYTES);
        }
        close(fd);
        check(request(admin, "REFILL", response, NULL) && !ok(response) && strstr(response, "allocation"),
              "REFILL reports physical HugeTLB exhaustion");
        check(reserve_hugepages(16) && command(admin, "REFILL"), "REFILL recovers after guest HugeTLB supply is restored");
        check(request(admin, "STATUS", response, NULL) && ok(response) && field(response, "ready") == 1 &&
              field(response, "degraded") == 0 && meminfo("HugePages_Free:") == 14,
              "recovered slot has verified backing and correct HugeTLB accounting");
    }

    bool recycled = true;
    uint64_t acquire_ns = 0, release_ns = 0;
    for (int i = 0; i < 200 && recycled; ++i) {
        uint64_t started = now_ns();
        int cycle_fd = acquire(client, &lease);
        acquire_ns += now_ns() - started;
        if (cycle_fd < 0) { recycled = false; break; }
        unsigned char *cycle_mapping = mmap(NULL, SLOT_BYTES, PROT_READ | PROT_WRITE, MAP_SHARED, cycle_fd, 0);
        if (cycle_mapping == MAP_FAILED) { close(cycle_fd); recycled = false; break; }
        recycled = cycle_mapping[0] == 0 && cycle_mapping[SLOT_BYTES - 1] == 0;
        cycle_mapping[0] = 0x7b; cycle_mapping[SLOT_BYTES - 1] = 0x91;
        munmap(cycle_mapping, SLOT_BYTES);
        snprintf(cmd, sizeof(cmd), "RELEASE %ld", lease);
        started = now_ns();
        recycled = command(client, cmd) && recycled;
        release_ns += now_ns() - started;
        recycled = fstat(cycle_fd, &st) == 0 && st.st_size == 0 && recycled;
        close(cycle_fd);
    }
    check(recycled && meminfo("HugePages_Free:") == 14, "200 acquire/write/release cycles retain exact HugeTLB capacity");
    if (recycled) printf("METRIC lifecycle_cycles=200 slot_bytes=%lu acquire_mean_us=%.3f release_and_refill_mean_us=%.3f\n",
                         SLOT_BYTES, (double)acquire_ns / 200000.0, (double)release_ns / 200000.0);

    fd = acquire(client, &lease);
    check(fd >= 0, "acquire final slot for disconnect test");
    if (fd >= 0) {
        mapping = mmap(NULL, SLOT_BYTES, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
        close(client); client = -1;
        bool released = false;
        for (int i = 0; i < 300; ++i) {
            if (fstat(fd, &st) == 0 && st.st_size == 0) { released = true; break; }
            usleep(10000);
        }
        check(released, "connection loss revokes its outstanding FD");
        if (mapping != MAP_FAILED) {
            check(sigbus_on_read(mapping), "disconnect invalidates retained HugeTLB mapping");
            munmap(mapping, SLOT_BYTES);
        }
        close(fd);
    }
    if (client >= 0) close(client);
    check(request(admin, "STATUS", response, NULL) && ok(response) && field(response, "leased") == 0,
          "all leases reclaimed after disconnect");
    printf("STATUS final %s\n", response);
    close(admin);
    client = connect_to(false);
    fd = acquire(client, &lease);
    mapping = fd >= 0 ? mmap(NULL, SLOT_BYTES, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0) : MAP_FAILED;
    check(fd >= 0 && mapping != MAP_FAILED, "retain an active HugeTLB mapping across daemon shutdown");
    stop_daemon();
    if (mapping != MAP_FAILED) {
        check(sigbus_on_read(mapping), "SIGTERM revokes mappings even while clients retain FDs");
        munmap(mapping, SLOT_BYTES);
    }
    if (fd >= 0) close(fd);
    if (client >= 0) close(client);
    check(meminfo("HugePages_Free:") == 16, "all guest HugeTLB pages returned on daemon shutdown");
    printf("METRIC guest_hugepages_total=%ld guest_hugepages_free=%ld\n",
           meminfo("HugePages_Total:"), meminfo("HugePages_Free:"));
    automatic_maximum_tests();
}

int main(void) {
    setvbuf(stdout, NULL, _IONBF, 0);
    setvbuf(stderr, NULL, _IONBF, 0);
    if (getpid() != 1) { fprintf(stderr, "This binary must run as PID 1 in an isolated VM.\n"); return 2; }
    mkdir("/proc", 0755); mkdir("/sys", 0755); mkdir("/dev", 0755);
    mkdir("/run", 0755); mkdir("/run/hugekeeper", 0755);
    (void)mount("proc", "/proc", "proc", 0, NULL);
    (void)mount("sysfs", "/sys", "sysfs", 0, NULL);
    mkdir("/sys/fs/cgroup", 0755);
    (void)mount("none", "/sys/fs/cgroup", "cgroup2", 0, NULL);
    (void)mount("devtmpfs", "/dev", "devtmpfs", 0, NULL);
    mkdir("/dev/pts", 0755);
    (void)mount("devpts", "/dev/pts", "devpts", 0, NULL);
    struct rlimit core = {0, 0}; (void)setrlimit(RLIMIT_CORE, &core);
    struct utsname uts;
    if (!uname(&uts)) printf("GUEST kernel=%s arch=%s pid=%ld\n", uts.release, uts.machine, (long)getpid());
    tests();
    printf("HUGETLB_VM_RESULT %s checks=%d failures=%d\n", failures ? "FAIL" : "PASS", checks, failures);
    sync();
    reboot(RB_POWER_OFF);
    for (;;) pause();
}
