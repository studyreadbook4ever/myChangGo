/* Native control-path benchmark. The Python driver only manages processes.
 * Reuse the SDK's bounded protocol parser for both daemon variants; the
 * persistent-connection measurements below do not use hk_acquire/hk_release.
 * This file is a benchmark executable, not part of the public library. */
#include "../src/client.c"

#include <stdlib.h>
#include <time.h>

static void die(const char *what) {
    perror(what);
    exit(2);
}

static uint64_t nanoseconds(clockid_t clock) {
    struct timespec ts;
    if (clock_gettime(clock, &ts) < 0) die("clock_gettime");
    return (uint64_t)ts.tv_sec * UINT64_C(1000000000) + (uint64_t)ts.tv_nsec;
}

static uint64_t daemon_ticks(unsigned long pid) {
    char path[64], line[4096];
    snprintf(path, sizeof(path), "/proc/%lu/stat", pid);
    FILE *file = fopen(path, "r");
    if (!file) die("daemon stat open");
    if (!fgets(line, sizeof(line), file)) die("daemon stat read");
    if (fclose(file)) die("daemon stat close");
    char *p = strrchr(line, ')');
    if (!p) { errno = EPROTO; die("daemon stat format"); }
    p += 2;
    /* The first token after ')' is field 3; utime and stime are 14 and 15. */
    for (unsigned field = 3; field < 14; field++) {
        p = strchr(p, ' ');
        if (!p) { errno = EPROTO; die("daemon stat fields"); }
        p++;
    }
    unsigned long long user_ticks, system_ticks;
    if (sscanf(p, "%llu %llu", &user_ticks, &system_ticks) != 2) {
        errno = EPROTO; die("daemon stat cpu");
    }
    return user_ticks + system_ticks;
}

static int compare_u64(const void *a, const void *b) {
    uint64_t x = *(const uint64_t *)a, y = *(const uint64_t *)b;
    return (x > y) - (x < y);
}

static void distribution(const char *name, uint64_t *values, size_t n) {
    long double total = 0;
    for (size_t i = 0; i < n; i++) total += values[i];
    qsort(values, n, sizeof(*values), compare_u64);
    /* Nearest-rank percentiles; median is the average of the center pair. */
    double median = n % 2 ? (double)values[n / 2]
        : ((double)values[n / 2 - 1] + (double)values[n / 2]) / 2;
    size_t p95 = (n * 95 + 99) / 100 - 1;
    size_t p99 = (n * 99 + 99) / 100 - 1;
    printf("\"%s\":{\"samples\":%zu,\"mean_us\":%.6Lf,\"p50_us\":%.6f,"
           "\"p95_us\":%.6f,\"p99_us\":%.6f,\"min_us\":%.6f,\"max_us\":%.6f}",
           name, n, total / n / 1000, median / 1000,
           (double)values[p95] / 1000, (double)values[p99] / 1000,
           (double)values[0] / 1000, (double)values[n - 1] / 1000);
}

static size_t argument(const char *s, size_t minimum, size_t maximum) {
    char *end;
    errno = 0;
    unsigned long long value = strtoull(s, &end, 10);
    if (!*s || *end || errno || *s == '-' || value < minimum || value > maximum) {
        fprintf(stderr, "Invalid numeric argument: %s\n", s);
        exit(2);
    }
    return (size_t)value;
}

int main(int argc, char **argv) {
    if (argc != 6 && !(argc == 7 && !strcmp(argv[6], "status"))) {
        fprintf(stderr, "Usage: %s SOCKET DAEMON_PID ITERATIONS WARMUP SLOT_BYTES [status]\n", argv[0]);
        return 2;
    }
    bool status_mode = argc == 7;
    unsigned long pid = (unsigned long)argument(argv[2], 1, INT32_MAX);
    size_t count = argument(argv[3], 1, 1000000);
    size_t warmup = argument(argv[4], 0, 100000);
    size_t expected_size = argument(argv[5], 2097152, 134217728);
    uint64_t *acquire = calloc(count, sizeof(*acquire));
    uint64_t *mapping = calloc(count, sizeof(*mapping));
    uint64_t *release = calloc(count, sizeof(*release));
    uint64_t *cycle = calloc(count, sizeof(*cycle));
    if (!acquire || !mapping || !release || !cycle) die("calloc");
    struct sockaddr_un address = {.sun_family = AF_UNIX};
    if (strlen(argv[1]) >= sizeof(address.sun_path)) {
        errno = ENAMETOOLONG; die("socket path");
    }
    memcpy(address.sun_path, argv[1], strlen(argv[1]) + 1);
    int sock = socket(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC, 0);
    if (sock < 0) die("socket");
    struct timeval timeout = {.tv_sec = 5};
    if (setsockopt(sock, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout)) < 0 ||
        setsockopt(sock, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout)) < 0 ||
        connect(sock, (struct sockaddr *)&address, sizeof(address)) < 0) die("connect");

    uint64_t cpu_start = 0, wall_start = 0, ticks_start = 0;
    for (size_t i = 0; i < count + warmup; i++) {
        if (i == warmup) {
            ticks_start = daemon_ticks(pid);
            cpu_start = nanoseconds(CLOCK_PROCESS_CPUTIME_ID);
            wall_start = nanoseconds(CLOCK_MONOTONIC);
        }
        uint64_t started = nanoseconds(CLOCK_MONOTONIC);
        if (status_mode) {
            char packet[RESPONSE_MAX + 1];
            struct iovec iov = {.iov_base = packet, .iov_len = RESPONSE_MAX};
            struct msghdr message = {.msg_iov = &iov, .msg_iovlen = 1};
            if (send_request(sock, "STATUS") < 0) die("status send");
            ssize_t received;
            do { received = recvmsg(sock, &message, 0); } while (received < 0 && errno == EINTR);
            if (received < 0) die("status receive");
            /* STATUS contains no descriptors. With no ancillary buffer,
             * unexpected descriptors are discarded by the kernel and CTRUNC
             * below rejects the response. Semantic status is checked by the
             * driver outside the timing loop. */
            if (received < 12 || (message.msg_flags & (MSG_TRUNC | MSG_CTRUNC)) ||
                memchr(packet, '\0', (size_t)received) ||
                strncmp(packet, "{\"ok\":true,", 11) || packet[received - 1] != '}') {
                errno = EPROTO; die("status response");
            }
            uint64_t finished = nanoseconds(CLOCK_MONOTONIC);
            if (i >= warmup) acquire[i - warmup] = finished - started;
            continue;
        }
        struct response reply;
        int fd = -1;
        if (send_request(sock, "ACQUIRE") < 0 ||
            receive_response(sock, true, &reply, &fd) < 0) die("acquire");
        uint64_t acquired = nanoseconds(CLOCK_MONOTONIC);
        if (reply.size != expected_size) { errno = EPROTO; die("unexpected slot size"); }
        uint64_t map_started = nanoseconds(CLOCK_MONOTONIC);
        volatile unsigned char *region = mmap(NULL, expected_size, PROT_READ | PROT_WRITE,
                                             MAP_SHARED, fd, 0);
        if (region == MAP_FAILED) die("mmap");
        if (region[0] || region[expected_size - 1]) {
            errno = EPROTO; die("fresh slot is not zero initialized");
        }
        region[0] = 1;
        region[expected_size - 1] = 2;
        if (munmap((void *)region, expected_size) < 0) die("munmap");
        uint64_t mapped = nanoseconds(CLOCK_MONOTONIC);
        if (close(fd) < 0) die("close lease fd");
        char request[64];
        snprintf(request, sizeof(request), "RELEASE %" PRIu64, reply.lease);
        uint64_t release_started = nanoseconds(CLOCK_MONOTONIC);
        if (send_request(sock, request) < 0 ||
            receive_response(sock, false, &reply, &fd) < 0) die("release");
        uint64_t released = nanoseconds(CLOCK_MONOTONIC);
        if (i >= warmup) {
            size_t sample = i - warmup;
            acquire[sample] = acquired - started;
            mapping[sample] = mapped - map_started;
            release[sample] = released - release_started;
            cycle[sample] = released - started;
        }
    }
    uint64_t wall_ns = nanoseconds(CLOCK_MONOTONIC) - wall_start;
    uint64_t cpu_ns = nanoseconds(CLOCK_PROCESS_CPUTIME_ID) - cpu_start;
    uint64_t ticks = daemon_ticks(pid) - ticks_start;
    long tick_rate = sysconf(_SC_CLK_TCK);
    if (tick_rate <= 0) die("sysconf clock ticks");
    if (close(sock) < 0) die("close socket");
    printf("{\"iterations\":%zu,\"warmup\":%zu,\"slot_bytes\":%zu,"
           "\"wall_seconds\":%.9f,\"client_cpu_seconds\":%.9f,"
           "\"daemon_cpu_ticks\":%" PRIu64 ",\"daemon_cpu_seconds\":%.9f,"
           "\"daemon_cpu_resolution_seconds\":%.9f,",
           count, warmup, expected_size, (double)wall_ns / 1e9, (double)cpu_ns / 1e9,
           ticks, (double)ticks / tick_rate, 1.0 / tick_rate);
    if (status_mode) {
        distribution("status", acquire, count);
    } else {
        distribution("acquire", acquire, count); putchar(',');
        distribution("map_touch_edges_unmap", mapping, count); putchar(',');
        distribution("release_and_replace", release, count); putchar(',');
        distribution("whole_cycle", cycle, count);
    }
    puts("}");
    free(acquire); free(mapping); free(release); free(cycle);
    return 0;
}
