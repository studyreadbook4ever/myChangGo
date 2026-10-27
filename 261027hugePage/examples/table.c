#define _POSIX_C_SOURCE 200809L
#include "hugekeeper.h"

#include <errno.h>
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

struct row { uint64_t key, value; };

static double seconds(void) {
    struct timespec now;
    if (clock_gettime(CLOCK_MONOTONIC, &now) < 0) { perror("clock_gettime"); exit(1); }
    return (double)now.tv_sec + (double)now.tv_nsec / 1e9;
}

/* A realistic sorted, fixed-width static table: direct pointer loads only. */
static const struct row *lookup(const struct row *table, size_t rows, uint64_t key) {
    size_t left = 0, right = rows;
    while (left < right) {
        size_t middle = left + (right - left) / 2;
        if (table[middle].key == key) return &table[middle];
        if (table[middle].key < key) left = middle + 1;
        else right = middle;
    }
    return NULL;
}

int main(int argc, char **argv) {
    if (argc < 2 || argc > 3) {
        fprintf(stderr, "Usage: %s SOCKET [SCAN_ROUNDS]\n", argv[0]);
        return 2;
    }
    unsigned long rounds = 100;
    if (argc == 3) {
        char *end;
        errno = 0;
        rounds = strtoul(argv[2], &end, 10);
        if (errno || !*argv[2] || *end || argv[2][0] == '-' || !rounds || rounds > 1000000) {
            fprintf(stderr, "SCAN_ROUNDS must be between 1 and 1000000\n");
            return 2;
        }
    }
    struct hk_lease lease = HK_LEASE_INIT;
    if (hk_acquire(argv[1], &lease) < 0) { perror("hk_acquire"); return 1; }
    struct row *table = lease.data;
    size_t rows = lease.size / sizeof(*table);
    if (!rows) { fprintf(stderr, "slot cannot hold a row\n"); hk_release(&lease); return 1; }
    double started = seconds();
    for (size_t i = 0; i < rows; i++) table[i] = (struct row){i * 2, i * 10};
    double loaded = seconds();
    const struct row *match = lookup(table, rows, (rows / 2) * 2);
    if (!match || match->value != (rows / 2) * 10 || lookup(table, rows, 1)) {
        fprintf(stderr, "lookup verification failed\n"); hk_release(&lease); return 1;
    }
    /* Volatile reads ensure every round actually scans the shared mapping.
     * This is an illustrative throughput measurement, not a DB benchmark. */
    const volatile struct row *scan = table;
    uint64_t checksum = 0;
    double scan_started = seconds();
    for (unsigned long round = 0; round < rounds; round++)
        for (size_t i = 0; i < rows; i++) checksum += scan[i].value;
    double finished = seconds();
    uint64_t triangular = rows % 2 ? (uint64_t)rows * ((rows - 1) / 2) :
        ((uint64_t)rows / 2) * (rows - 1);
    uint64_t expected = triangular * 10 * rounds;
    if (checksum != expected) {
        fprintf(stderr, "scan verification failed\n"); hk_release(&lease); return 1;
    }
    double duration = finished - scan_started;
    printf("{\"backend\":\"%s\",\"rows\":%zu,\"bytes\":%zu,\"scan_rounds\":%lu,"
           "\"load_seconds\":%.9f,\"scan_seconds\":%.9f,\"scan_gib_per_second\":%.3f,"
           "\"checksum\":%" PRIu64 "}\n", lease.backend, rows, rows * sizeof(*table), rounds,
           loaded - started, duration, duration > 0 ? (double)rows * sizeof(*table) * rounds /
           duration / (1024.0 * 1024.0 * 1024.0) : 0.0, checksum);
    if (hk_release(&lease) < 0) { perror("hk_release"); return 1; }
    return 0;
}
