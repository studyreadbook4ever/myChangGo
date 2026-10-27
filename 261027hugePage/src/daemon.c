#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <ctype.h>
#include "capacity.h"
#include <fcntl.h>
#include <getopt.h>
#include <inttypes.h>
#include <limits.h>
#include <linux/memfd.h>
#include <poll.h>
#include <signal.h>
#include <stdbool.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/signalfd.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>

_Static_assert(sizeof(size_t) >= 8, "Hugekeeper requires a 64-bit build");

/* Control plane only: clients access the memory directly after acquisition. */
#define MAX_SLOTS 32
#define MAX_UIDS 32
#define MAX_CLIENTS 128
#define ADMIN_CLIENTS 16
#define MIB ((size_t)1024 * 1024)
#define REQUEST_MAX 255
#define RESPONSE_MAX 4096

enum backend { HUGETLB, THP, PLAIN };
struct slot {
    bool enabled;
    int fd;
    void *mapping;
    uint64_t lease;
    int owner;
};
struct client {
    int fd;
    bool admin;
    struct ucred cred;
};
static struct slot slots[MAX_SLOTS];
static struct client clients[MAX_CLIENTS];
static uid_t allowed[MAX_UIDS];
static size_t allowed_count;
static enum backend backend = HUGETLB;
static size_t slot_bytes = 16 * MIB, max_bytes = 1024 * MIB;
static unsigned capacity;
static uint64_t next_lease = 1;
static bool lock_pages;
static bool fatal_revoke;
static bool fatal_accept;
static char data_path[sizeof(((struct sockaddr_un *)0)->sun_path)];
static char admin_path[sizeof(data_path)];
static int listeners[2] = {-1, -1}, signal_fd = -1;
static bool bound[2];
static unsigned admin_client_limit = ADMIN_CLIENTS;
static unsigned data_client_limit = MAX_CLIENTS - ADMIN_CLIENTS;

static const char *backend_name(void) {
    return backend == HUGETLB ? "hugetlb" : backend == THP ? "thp" : "plain";
}

static void log_errno(const char *what) {
    fprintf(stderr, "hugekeeperd: %s: %s\n", what, strerror(errno));
}

static bool parse_uint(const char *s, uint64_t maximum, uint64_t *out) {
    if (!*s) return false;
    uint64_t n = 0;
    for (; *s; s++) {
        if (*s < '0' || *s > '9') return false;
        unsigned digit = (unsigned)(*s - '0');
        if (n > maximum / 10 || (n == maximum / 10 && digit > maximum % 10))
            return false;
        n = n * 10 + digit;
    }
    *out = n;
    return true;
}

static bool is_allowed(uid_t uid) {
    for (size_t i = 0; i < allowed_count; i++) if (allowed[i] == uid) return true;
    return false;
}

static bool allow_uid(uid_t uid) {
    if (is_allowed(uid)) return true;
    if (allowed_count == MAX_UIDS) return false;
    allowed[allowed_count++] = uid;
    return true;
}

/* Never access this mapping after it has been shared with a client. Clients
 * may shrink their own file. Keeping the VMA retains prefault/optional mlock. */
static bool allocate_slot(struct slot *s) {
    unsigned flags = MFD_CLOEXEC | MFD_ALLOW_SEALING;
    if (backend == HUGETLB) flags |= MFD_HUGETLB | MFD_HUGE_2MB;
    int fd = memfd_create("hugekeeper", flags);
    if (fd < 0) return false;
    void *mapping = MAP_FAILED;
    if (ftruncate(fd, (off_t)slot_bytes) < 0) goto fail;
    mapping = mmap(NULL, slot_bytes, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    if (mapping == MAP_FAILED) goto fail;
    if (backend != HUGETLB && madvise(mapping, slot_bytes,
            backend == THP ? MADV_HUGEPAGE : MADV_NOHUGEPAGE) < 0) goto fail;
    /* Unlike a user-space page-touch loop, POPULATE_WRITE reports allocation
     * failure as errno instead of crashing the broker with SIGBUS. Linux 5.14+. */
    if (madvise(mapping, slot_bytes, MADV_POPULATE_WRITE) < 0) goto fail;
    if (lock_pages && mlock(mapping, slot_bytes) < 0) goto fail;
    if (fcntl(fd, F_ADD_SEALS, F_SEAL_GROW | F_SEAL_SEAL) < 0) goto fail;
    s->fd = fd;
    s->mapping = mapping;
    s->lease = 0;
    s->owner = -1;
    return true;
fail:;
    int saved = errno;
    if (mapping != MAP_FAILED) munmap(mapping, slot_bytes);
    close(fd);
    errno = saved;
    return false;
}

/* Destructive revoke is intentional. An old FD must NEVER refer to the next
 * tenant's pages. If truncate fails, retain the FD and stop serving requests. */
static bool discard_slot(struct slot *s) {
    if (s->fd >= 0) {
        if (ftruncate(s->fd, 0) < 0) {
            log_errno("revocation failed; stopping");
            fatal_revoke = true;
            return false;
        }
        if (s->mapping != MAP_FAILED) munmap(s->mapping, slot_bytes);
        close(s->fd);
    }
    s->fd = -1;
    s->mapping = MAP_FAILED;
    s->lease = 0;
    s->owner = -1;
    return true;
}

static bool recycle_slot(struct slot *s) {
    if (!discard_slot(s)) return false;
    if (!allocate_slot(s)) {
        log_errno("refill failed; slot is degraded (use REFILL)");
        /* Revocation succeeded. Capacity stays configured but unavailable. */
    }
    return true;
}

static void close_client(unsigned index) {
    if (clients[index].fd < 0) return;
    close(clients[index].fd);
    clients[index].fd = -1;
    for (unsigned i = 0; i < MAX_SLOTS; i++)
        if (slots[i].enabled && slots[i].lease && slots[i].owner == (int)index)
            recycle_slot(&slots[i]);
}

static bool reply(unsigned index, const char *json, int fd) {
    struct iovec iov = {.iov_base = (void *)json, .iov_len = strlen(json)};
    union { struct cmsghdr alignment; char bytes[CMSG_SPACE(sizeof(int))]; } control;
    struct msghdr msg = {.msg_iov = &iov, .msg_iovlen = 1};
    if (fd >= 0) {
        memset(&control, 0, sizeof(control));
        msg.msg_control = control.bytes;
        msg.msg_controllen = sizeof(control.bytes);
        struct cmsghdr *c = CMSG_FIRSTHDR(&msg);
        c->cmsg_level = SOL_SOCKET;
        c->cmsg_type = SCM_RIGHTS;
        c->cmsg_len = CMSG_LEN(sizeof(int));
        memcpy(CMSG_DATA(c), &fd, sizeof(fd));
    }
    ssize_t n;
    do { n = sendmsg(clients[index].fd, &msg, MSG_NOSIGNAL | MSG_DONTWAIT); }
    while (n < 0 && errno == EINTR);
    if (n != (ssize_t)iov.iov_len) {
        close_client(index);
        return false;
    }
    return true;
}

static void error_reply(unsigned i, const char *error, const char *message) {
    char buf[512];
    snprintf(buf, sizeof(buf), "{\"ok\":false,\"error\":\"%s\",\"message\":\"%s\"}", error, message);
    reply(i, buf, -1);
}

static void ok_reply(unsigned i) { reply(i, "{\"ok\":true}", -1); }

static bool append(char *buf, size_t *used, const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    int n = vsnprintf(buf + *used, RESPONSE_MAX - *used, fmt, ap);
    va_end(ap);
    if (n < 0 || (size_t)n >= RESPONSE_MAX - *used) return false;
    *used += (size_t)n;
    return true;
}

/* Query on demand only. RSS excludes explicit HugeTLB, so account for it
 * separately. ShmemPmdMapped is observed THP coverage, not a promise. */
static bool memory_stats(size_t *resident, size_t *hugetlb, size_t *thp) {
    FILE *f = fopen("/proc/self/smaps", "re");
    if (!f) return false;
    char line[512];
    bool ours = false;
    size_t rss = 0;
    while (fgets(line, sizeof(line), f)) {
        /* A mapping header starts with a hex address immediately followed by
         * '-'. All metric lines have a colon. Avoid scanf on every smaps row. */
        size_t hex = strspn(line, "0123456789abcdefABCDEF");
        if (hex && line[hex] == '-') {
            ours = strstr(line, "/memfd:hugekeeper (deleted)") != NULL;
            continue;
        }
        if (!ours) continue;
        const char *value = NULL;
        size_t *counter = NULL;
        if (!strncmp(line, "Rss:", 4)) { value = line + 4; counter = &rss; }
        else if (!strncmp(line, "Shared_Hugetlb:", 15)) { value = line + 15; counter = hugetlb; }
        else if (!strncmp(line, "Private_Hugetlb:", 16)) { value = line + 16; counter = hugetlb; }
        else if (!strncmp(line, "ShmemPmdMapped:", 15)) { value = line + 15; counter = thp; }
        if (counter) {
            char *end;
            unsigned long long kb = strtoull(value, &end, 10);
            if (end != value && kb <= (SIZE_MAX - *counter) / 1024)
                *counter += (size_t)kb * 1024;
        }
    }
    bool success = !ferror(f);
    fclose(f);
    *resident = rss + *hugetlb;
    return success;
}

static void status_reply(unsigned index) {
    unsigned ready = 0, leased = 0, degraded = 0;
    for (unsigned i = 0; i < MAX_SLOTS; i++) {
        if (!slots[i].enabled) continue;
        if (slots[i].lease) leased++;
        else if (slots[i].fd >= 0) ready++;
        else degraded++;
    }
    char buf[RESPONSE_MAX];
    size_t used = 0;
    size_t resident = 0, hugetlb = 0, thp = 0;
    bool memory_observed = memory_stats(&resident, &hugetlb, &thp);
#define ADD(...) do { if (!append(buf, &used, __VA_ARGS__)) goto overflow; } while (0)
    ADD("{\"ok\":true,\"backend\":\"%s\",\"slot_bytes\":%zu,\"capacity\":%u,"
        "\"ready\":%u,\"leased\":%u,\"degraded\":%u,\"pool_bytes\":%zu,"
        "\"pid\":%ld,\"locked\":%s,\"memory_observed\":%s,"
        "\"resident_bytes\":%zu,\"hugetlb_bytes\":%zu,\"thp_mapped_bytes\":%zu,"
        "\"page_bytes\":2097152,\"total_pages\":%zu,\"ready_pages\":%zu,\"leased_pages\":%zu,\"allowed_uids\":[", backend_name(), slot_bytes,
        capacity, ready, leased, degraded, (size_t)(ready + leased) * slot_bytes,
        (long)getpid(), lock_pages || backend == HUGETLB ? "true" : "false",
        memory_observed ? "true" : "false", resident, hugetlb, thp,
        (size_t)capacity * slot_bytes / (2 * MIB), (size_t)ready * slot_bytes / (2 * MIB),
        (size_t)leased * slot_bytes / (2 * MIB));
    for (size_t i = 0; i < allowed_count; i++)
        ADD("%s%lu", i ? "," : "", (unsigned long)allowed[i]);
    ADD("],\"leases\":[");
    bool first = true;
    for (unsigned i = 0; i < MAX_SLOTS; i++) {
        struct slot *s = &slots[i];
        if (!s->enabled || !s->lease) continue;
        struct ucred c = clients[s->owner].cred;
        ADD("%s{\"lease\":%" PRIu64 ",\"uid\":%lu,\"pid\":%ld}", first ? "" : ",",
            s->lease, (unsigned long)c.uid, (long)c.pid);
        first = false;
    }
    ADD("]}");
    reply(index, buf, -1);
    return;
overflow:
    error_reply(index, "internal", "Status exceeds protocol limit");
#undef ADD
}

static bool resize_pool(unsigned target) {
    if (target > capacity) {
        unsigned added[MAX_SLOTS], count = 0;
        for (unsigned i = 0; i < MAX_SLOTS && capacity + count < target; i++) {
            if (slots[i].enabled) continue;
            if (!allocate_slot(&slots[i])) {
                int saved = errno;
                for (unsigned j = 0; j < count; j++) discard_slot(&slots[added[j]]);
                errno = saved;
                return false;
            }
            added[count++] = i;
        }
        for (unsigned j = 0; j < count; j++) slots[added[j]].enabled = true;
    } else {
        unsigned count = capacity - target;
        for (unsigned i = MAX_SLOTS; i > 0 && count; ) {
            struct slot *s = &slots[--i];
            if (!s->enabled || s->lease) continue;
            if (!discard_slot(s)) return false;
            s->enabled = false;
            count--;
        }
    }
    capacity = target;
    return true;
}

static bool number_arg(const char *request, const char *command, uint64_t maximum, uint64_t *value) {
    size_t n = strlen(command);
    return strncmp(request, command, n) == 0 && request[n] == ' ' &&
           parse_uint(request + n + 1, maximum, value);
}

static void handle_data(unsigned index, const char *request) {
    if (strcmp(request, "PING") == 0) { ok_reply(index); return; }
    if (strcmp(request, "ACQUIRE") == 0) {
        if (!is_allowed(clients[index].cred.uid)) {
            error_reply(index, "denied", "UID is not authorized"); return;
        }
        for (unsigned i = 0; i < MAX_SLOTS; i++) {
            if (slots[i].lease && slots[i].owner == (int)index) {
                error_reply(index, "busy", "Connection already owns a lease"); return;
            }
        }
        if (!next_lease) { error_reply(index, "internal", "Lease identifiers exhausted"); return; }
        for (unsigned i = 0; i < MAX_SLOTS; i++) {
            struct slot *s = &slots[i];
            if (!s->enabled || s->fd < 0 || s->lease) continue;
            s->lease = next_lease++;
            s->owner = (int)index;
            char buf[256];
            snprintf(buf, sizeof(buf), "{\"ok\":true,\"lease\":%" PRIu64 ",\"size\":%zu,\"backend\":\"%s\"}",
                     s->lease, slot_bytes, backend_name());
            reply(index, buf, s->fd);
            return;
        }
        error_reply(index, "empty", "No ready slots; release, resize, or refill"); return;
    }
    uint64_t value;
    if (number_arg(request, "RELEASE", UINT64_MAX, &value)) {
        for (unsigned i = 0; i < MAX_SLOTS; i++) {
            struct slot *s = &slots[i];
            if (s->lease && s->lease == value && s->owner == (int)index) {
                if (recycle_slot(s)) ok_reply(index);
                else error_reply(index, "internal", "Revocation failed; daemon stopping");
                return;
            }
        }
        error_reply(index, "not_found", "Lease is not owned by this connection"); return;
    }
    error_reply(index, "invalid", "Unknown data command or invalid arguments");
}

static void handle_admin(unsigned index, const char *request) {
    uint64_t value;
    if (strcmp(request, "STATUS") == 0) { status_reply(index); return; }
    if (strcmp(request, "FREE") == 0) {
        for (unsigned i = 0; i < MAX_SLOTS; i++) {
            if (!discard_slot(&slots[i])) {
                error_reply(index, "internal", "Revocation failed; daemon stopping"); return;
            }
            slots[i].enabled = false;
        }
        capacity = 0;
        ok_reply(index); return;
    }
    if (number_arg(request, "ALLOW", UINT32_MAX - 1, &value)) {
        if (allow_uid((uid_t)value)) ok_reply(index);
        else error_reply(index, "invalid", "UID policy limit reached (32)");
        return;
    }
    if (number_arg(request, "DENY", UINT32_MAX - 1, &value)) {
        for (size_t i = 0; i < allowed_count; i++) {
            if (allowed[i] == (uid_t)value) { allowed[i] = allowed[--allowed_count]; break; }
        }
        unsigned revoked[MAX_SLOTS], count = 0;
        for (unsigned i = 0; i < MAX_SLOTS; i++) {
            struct slot *s = &slots[i];
            if (s->lease && clients[s->owner].cred.uid == (uid_t)value) {
                if (!discard_slot(s)) {
                    error_reply(index, "internal", "Revocation failed; daemon stopping"); return;
                }
                revoked[count++] = i;
            }
        }
        /* Invalidate every affected capability before paying any allocation
         * cost. No client keeps access while an earlier slot is refilled. */
        for (unsigned i = 0; i < count; i++) {
            if (!allocate_slot(&slots[revoked[i]]))
                log_errno("refill failed; slot is degraded (use REFILL)");
        }
        ok_reply(index); return;
    }
    if (number_arg(request, "REVOKE", UINT64_MAX, &value)) {
        for (unsigned i = 0; i < MAX_SLOTS; i++) {
            if (slots[i].lease && slots[i].lease == value) {
                if (recycle_slot(&slots[i])) ok_reply(index);
                else error_reply(index, "internal", "Revocation failed; daemon stopping");
                return;
            }
        }
        error_reply(index, "not_found", "Lease does not exist"); return;
    }
    if (number_arg(request, "RESIZE", MAX_SLOTS, &value)) {
        if (value > max_bytes / slot_bytes) {
            error_reply(index, "invalid", "Pool would exceed --max-mib"); return;
        }
        unsigned leased = 0;
        for (unsigned i = 0; i < MAX_SLOTS; i++) if (slots[i].lease) leased++;
        if (value < leased) { error_reply(index, "busy", "Target below active lease count"); return; }
        if (resize_pool((unsigned)value)) ok_reply(index);
        else { log_errno("resize"); error_reply(index, "allocation", "Resize allocation failed; inspect daemon log"); }
        return;
    }
    if (strcmp(request, "REFILL") == 0) {
        bool success = true;
        for (unsigned i = 0; i < MAX_SLOTS; i++) {
            if (slots[i].enabled && slots[i].fd < 0 && !allocate_slot(&slots[i])) {
                log_errno("refill"); success = false;
            }
        }
        if (success) ok_reply(index);
        else error_reply(index, "allocation", "Some slots remain degraded");
        return;
    }
    error_reply(index, "invalid", "Unknown admin command or invalid arguments");
}

static void receive_request(unsigned index) {
    char buf[REQUEST_MAX + 1];
    union { struct cmsghdr alignment; char bytes[CMSG_SPACE(16 * sizeof(int))]; } control;
    struct iovec iov = {.iov_base = buf, .iov_len = REQUEST_MAX};
    struct msghdr msg = {.msg_iov = &iov, .msg_iovlen = 1,
                         .msg_control = control.bytes, .msg_controllen = sizeof(control.bytes)};
    ssize_t n = recvmsg(clients[index].fd, &msg, MSG_DONTWAIT | MSG_CMSG_CLOEXEC);
    if (n < 0) {
        if (errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR) close_client(index);
        return;
    }
    bool ancillary = false;
    for (struct cmsghdr *c = CMSG_FIRSTHDR(&msg); c; c = CMSG_NXTHDR(&msg, c)) {
        ancillary = true;
        if (c->cmsg_level == SOL_SOCKET && c->cmsg_type == SCM_RIGHTS && c->cmsg_len >= CMSG_LEN(0)) {
            size_t count = (c->cmsg_len - CMSG_LEN(0)) / sizeof(int);
            for (size_t j = 0; j < count; j++) {
                int fd; memcpy(&fd, CMSG_DATA(c) + j * sizeof(int), sizeof(fd)); close(fd);
            }
        }
    }
    if (n == 0) { close_client(index); return; }
    if (ancillary || (msg.msg_flags & (MSG_TRUNC | MSG_CTRUNC))) {
        error_reply(index, "invalid", "Oversized packet or unexpected ancillary data"); return;
    }
    if (memchr(buf, '\0', (size_t)n)) { error_reply(index, "invalid", "NUL is not allowed"); return; }
    if (buf[n - 1] == '\n') n--;
    buf[n] = '\0';
    if (clients[index].admin) handle_admin(index, buf);
    else handle_data(index, buf);
}

static void accept_clients(unsigned listener) {
    /* Bounded work per wakeup prevents a connection flood starving leases. */
    for (unsigned tries = 0; tries < 16; tries++) {
        int fd = accept4(listeners[listener], NULL, NULL, SOCK_CLOEXEC | SOCK_NONBLOCK);
        if (fd < 0) {
            if (errno == EMFILE || errno == ENFILE) {
                log_errno("descriptor exhaustion accepting client; stopping cleanly");
                fatal_accept = true;
            }
            return;
        }
        struct ucred cred;
        socklen_t len = sizeof(cred);
        if (getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &cred, &len) < 0 ||
            len != sizeof(cred) || (listener == 1 && cred.uid != geteuid())) {
            close(fd); continue;
        }
        unsigned start = listener == 1 ? 0 : ADMIN_CLIENTS;
        unsigned end = start + (listener == 1 ? admin_client_limit : data_client_limit);
        unsigned index;
        for (index = start; index < end; index++) if (clients[index].fd < 0) break;
        if (index == end) { close(fd); continue; }
        clients[index] = (struct client){.fd = fd, .admin = listener == 1, .cred = cred};
    }
}

/* Reserve real OS descriptors for administration and pool replacement. A
 * client-array reservation alone does not protect accept4 from RLIMIT_NOFILE.
 * Called after opening listeners/signalfd and before allocating any slots. */
static bool configure_fd_budget(void) {
    struct rlimit limit;
    if (getrlimit(RLIMIT_NOFILE, &limit) < 0) return false;
    DIR *directory = opendir("/proc/self/fd");
    if (!directory) return false;
    rlim_t baseline = 0;
    errno = 0;
    struct dirent *entry;
    while ((entry = readdir(directory)) != NULL) {
        if (entry->d_name[0] != '.') baseline++;
    }
    int saved = errno;
    if (closedir(directory) < 0 && !saved) saved = errno;
    if (saved) { errno = saved; return false; }
    if (baseline) baseline--; /* The directory FD has now been closed. */
    rlim_t reserved = baseline + MAX_SLOTS + 4;
    if (limit.rlim_cur <= reserved || limit.rlim_cur - reserved < 5) {
        errno = EMFILE;
        return false;
    }
    rlim_t available = limit.rlim_cur - reserved;
    if (available > MAX_CLIENTS) available = MAX_CLIENTS;
    admin_client_limit = (unsigned)available / 8;
    if (admin_client_limit < 4) admin_client_limit = 4;
    if (admin_client_limit > ADMIN_CLIENTS) admin_client_limit = ADMIN_CLIENTS;
    data_client_limit = (unsigned)available - admin_client_limit;
    if (data_client_limit > MAX_CLIENTS - ADMIN_CLIENTS)
        data_client_limit = MAX_CLIENTS - ADMIN_CLIENTS;
    return true;
}

static bool configure_paths(const char *path) {
    if (!path || path[0] != '/' || strlen(path) + 6 >= sizeof(data_path)) return false;
    char parent[PATH_MAX];
    strcpy(parent, path);
    char *slash = strrchr(parent, '/');
    if (!slash || !slash[1]) return false;
    if (slash == parent) slash[1] = '\0'; else *slash = '\0';
    struct stat st;
    if (lstat(parent, &st) < 0 || !S_ISDIR(st.st_mode) ||
        st.st_uid != geteuid() || (st.st_mode & 0022)) return false;
    strcpy(data_path, path);
    snprintf(admin_path, sizeof(admin_path), "%s.admin", path);
    return true;
}

static bool setup_listener(unsigned i) {
    const char *path = i ? admin_path : data_path;
    int fd = socket(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC | SOCK_NONBLOCK, 0);
    if (fd < 0) return false;
    listeners[i] = fd;
    struct sockaddr_un addr = {.sun_family = AF_UNIX};
    strcpy(addr.sun_path, path);
    if (bind(fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) return false;
    bound[i] = true;
    if (chmod(path, i ? 0600 : 0666) < 0 || listen(fd, 64) < 0) return false;
    return true;
}

static void cleanup(void) {
    for (unsigned i = 0; i < MAX_CLIENTS; i++) if (clients[i].fd >= 0) close(clients[i].fd);
    for (unsigned i = 0; i < MAX_SLOTS; i++) discard_slot(&slots[i]);
    for (unsigned i = 0; i < 2; i++) {
        if (listeners[i] >= 0) close(listeners[i]);
        if (bound[i]) unlink(i ? admin_path : data_path);
    }
    if (signal_fd >= 0) close(signal_fd);
}

static void usage(FILE *stream) {
    fprintf(stream,
        "Usage: hugekeeperd --socket /owned/directory/pool.sock [options]\n"
        "  --pages N                    TOTAL pool: N pages of 2 MiB each\n"
        "  --backend hugetlb|thp|plain  Default hugetlb; never silently falls back\n"
        "  --slots N                    Split total pages into N equal leases (default 1)\n"
        "  --max-mib N                  Optional ceiling, including maximum mode\n"
        "  --allow-uid UID              Explicit data authorization, repeatable\n"
        "  --lock                       Require mlock for THP/plain memory\n"
        "  --slot-mib N                 Advanced legacy per-slot size; replaces --pages\n"
        "  --help                       Show help\n"
        "No --pages: explain omission and ask [y/N] on a terminal. Only y/yes\n"
        "requests the current feasible maximum. Redirected input never confirms.\n"
        "THP/plain maximum leaves max(128 MiB, 10%%) operating headroom.\n"
        "Linux 5.14+. HugeTLB mode requires a reserved 2 MiB hugepage pool.\n"
        "No UID is allowed by default. SIGTERM invalidates active mappings.\n");
}

/* This is an application confirmation, not an agent approval request. The
 * default is always no, and scripts must specify an explicit page count. */
static int confirm_maximum(void) {
    fprintf(stderr, "No --pages parameter supplied. Reserve the maximum currently available 2 MiB pages? [y/N] ");
    fflush(stderr);
    if (!isatty(STDIN_FILENO)) {
        fprintf(stderr, "\nNon-interactive input: specify --pages N. No memory allocated.\n");
        return -1;
    }
    char answer[32];
    if (!fgets(answer, sizeof(answer), stdin)) {
        fprintf(stderr, "\nCancelled. No memory allocated.\n"); return 0;
    }
    char *start = answer;
    while (isspace((unsigned char)*start)) start++;
    char *end = start + strlen(start);
    while (end > start && isspace((unsigned char)end[-1])) *--end = '\0';
    if (!strcasecmp(start, "y") || !strcasecmp(start, "yes")) return 1;
    fprintf(stderr, "Cancelled. No memory allocated.\n");
    return 0;
}

int main(int argc, char **argv) {
    for (unsigned i = 0; i < MAX_SLOTS; i++) {
        slots[i].fd = -1; slots[i].mapping = MAP_FAILED; slots[i].owner = -1;
    }
    for (unsigned i = 0; i < MAX_CLIENTS; i++) clients[i].fd = -1;
    unsigned initial_slots = 4;
    uint64_t requested_pages = 0;
    bool pages_given = false, slots_given = false, slot_size_given = false, max_given = false;
    bool maximum_mode = false;
    const char *socket_path = NULL;
    static const struct option options[] = {
        {"socket", required_argument, NULL, 's'}, {"backend", required_argument, NULL, 'b'},
        {"pages", required_argument, NULL, 'p'},
        {"slots", required_argument, NULL, 'n'}, {"slot-mib", required_argument, NULL, 'm'},
        {"max-mib", required_argument, NULL, 'x'}, {"allow-uid", required_argument, NULL, 'u'},
        {"lock", no_argument, NULL, 'l'}, {"help", no_argument, NULL, 'h'}, {NULL, 0, NULL, 0}
    };
    int opt;
    while ((opt = getopt_long(argc, argv, "", options, NULL)) != -1) {
        uint64_t v;
        switch (opt) {
        case 's': socket_path = optarg; break;
        case 'p':
            if (!parse_uint(optarg, INT64_MAX / (2 * MIB), &requested_pages) || !requested_pages) goto invalid;
            pages_given = true; break;
        case 'b':
            if (!strcmp(optarg, "hugetlb")) backend = HUGETLB;
            else if (!strcmp(optarg, "thp")) backend = THP;
            else if (!strcmp(optarg, "plain")) backend = PLAIN;
            else goto invalid;
            break;
        case 'n':
            if (!parse_uint(optarg, MAX_SLOTS, &v)) goto invalid;
            initial_slots = (unsigned)v; slots_given = true; break;
        case 'm':
            if (!parse_uint(optarg, 1048576, &v) || !v || v % 2) goto invalid;
            slot_bytes = (size_t)v * MIB; slot_size_given = true; break;
        case 'x':
            if (!parse_uint(optarg, 1048576, &v) || !v) goto invalid;
            max_bytes = (size_t)v * MIB; max_given = true; break;
        case 'u': if (!parse_uint(optarg, UINT32_MAX - 1, &v) || !allow_uid((uid_t)v)) goto invalid; break;
        case 'l': lock_pages = true; break;
        case 'h': usage(stdout); return 0;
        default: goto invalid;
        }
    }
    if (optind != argc || (pages_given && slot_size_given) || !configure_paths(socket_path)) {
        fprintf(stderr, "hugekeeperd: invalid options or socket directory; use an absolute path in an owned directory without group/other write access\n");
        return 2;
    }
    if (!pages_given && !slot_size_given) {
        int confirmation = confirm_maximum();
        if (confirmation <= 0) return confirmation < 0 ? 2 : 0;
        char reason[1024];
        requested_pages = hk_available_pages(backend == HUGETLB, lock_pages,
                                             max_given ? max_bytes / (2 * MIB) : 0,
                                             reason, sizeof(reason));
        /* A sub-page explicit cap is zero pages, not an unlimited budget. */
        if (max_given && max_bytes < 2 * MIB) requested_pages = 0;
        fprintf(stderr, "Maximum estimate: %" PRIu64 " pages (%" PRIu64 " MiB). %s\n",
                requested_pages, requested_pages * 2, reason);
        maximum_mode = true;
        pages_given = true;
    }
    if (pages_given) {
        if (!slots_given) initial_slots = 1;
        if (!initial_slots) goto invalid;
        if (maximum_mode) requested_pages -= requested_pages % initial_slots;
        if (!requested_pages || requested_pages > INT64_MAX / (2 * MIB)) {
            fprintf(stderr, "hugekeeperd: no usable 2 MiB pages within current limits; no memory allocated\n");
            return 1;
        }
        if (requested_pages % initial_slots) {
            fprintf(stderr, "hugekeeperd: --pages must divide evenly into --slots\n"); return 2;
        }
        slot_bytes = (size_t)(requested_pages / initial_slots) * 2 * MIB;
        size_t total_bytes = (size_t)requested_pages * 2 * MIB;
        if (!max_given && total_bytes > max_bytes) max_bytes = total_bytes;
    }
    if (initial_slots > max_bytes / slot_bytes) {
        fprintf(stderr, "hugekeeperd: requested pages exceed --max-mib\n"); return 2;
    }
    umask(0077);
    if (prctl(PR_SET_DUMPABLE, 0) < 0 || prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0) {
        log_errno("process hardening"); return 1;
    }
    sigset_t signals;
    sigemptyset(&signals); sigaddset(&signals, SIGINT); sigaddset(&signals, SIGTERM);
    if (sigprocmask(SIG_BLOCK, &signals, NULL) < 0 ||
        (signal_fd = signalfd(-1, &signals, SFD_CLOEXEC | SFD_NONBLOCK)) < 0) {
        log_errno("signal setup"); cleanup(); return 1;
    }
    if (!setup_listener(0) || !setup_listener(1)) {
        log_errno("socket setup (existing paths are never removed automatically)"); cleanup(); return 1;
    }
    if (!configure_fd_budget()) {
        log_errno("descriptor budget (requires /proc/self/fd and room for pool/admin descriptors)");
        cleanup(); return 1;
    }
    if (!resize_pool(initial_slots)) {
        log_errno("pool preallocation");
        if (backend == HUGETLB)
            fprintf(stderr, "hugekeeperd: reserve 2 MiB HugeTLB pages and configure permission, or explicitly choose --backend thp for best-effort hugepages\n");
        cleanup(); return 1;
    }
    printf("READY backend=%s pages=%zu page_bytes=2097152 pool_bytes=%zu slots=%u slot_bytes=%zu pid=%ld socket=%s\n",
           backend_name(), (size_t)capacity * slot_bytes / (2 * MIB),
           (size_t)capacity * slot_bytes, capacity, slot_bytes, (long)getpid(), data_path);
    fflush(stdout);
    bool running = true, io_failed = false;
    while (running && !fatal_revoke && !fatal_accept) {
        struct pollfd fds[3 + MAX_CLIENTS];
        unsigned client_index[MAX_CLIENTS];
        nfds_t count = 3;
        fds[0] = (struct pollfd){.fd = signal_fd, .events = POLLIN};
        fds[1] = (struct pollfd){.fd = listeners[0], .events = POLLIN};
        fds[2] = (struct pollfd){.fd = listeners[1], .events = POLLIN};
        for (unsigned i = 0; i < MAX_CLIENTS; i++) {
            if (clients[i].fd < 0) continue;
            client_index[count - 3] = i;
            fds[count++] = (struct pollfd){.fd = clients[i].fd, .events = POLLIN};
        }
        int n = poll(fds, count, -1);
        if (n < 0) { if (errno == EINTR) continue; log_errno("poll"); io_failed = true; break; }
        if (fds[0].revents) { running = false; continue; }
        /* Handle only clients from the poll snapshot before reusing entries. */
        for (nfds_t j = 3; j < count && !fatal_revoke; j++) {
            unsigned i = client_index[j - 3];
            short events = fds[j].revents;
            if (events & POLLIN) receive_request(i);
            else if (events & (POLLHUP | POLLERR | POLLNVAL)) close_client(i);
        }
        if (fds[2].revents & POLLIN) accept_clients(1);
        if (fds[1].revents & POLLIN) accept_clients(0);
    }
    cleanup();
    return fatal_revoke || fatal_accept || io_failed ? 1 : 0;
invalid:
    usage(stderr); return 2;
}
