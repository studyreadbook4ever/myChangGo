#define _GNU_SOURCE
#include "capacity.h"

#include <errno.h>
#include <inttypes.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/stat.h>

#define PAGE_BYTES (UINT64_C(2) * 1024 * 1024)
#define MIN_RESERVE (UINT64_C(128) * 1024 * 1024)

enum scalar_status { SCALAR_ERROR = -1, SCALAR_MISSING = 0, SCALAR_NUMBER = 1, SCALAR_MAX = 2 };

struct estimate {
    uint64_t bytes;
    char limiting[128];
};

struct cgroup_mount {
    char point[PATH_MAX];
    char current[PATH_MAX];
    bool memory_accounts_hugetlb;
};

static void message(char *reason, size_t size, const char *text) {
    if (reason && size) snprintf(reason, size, "%s", text);
}

static bool join_path(char *out, size_t size, const char *root, const char *suffix) {
    int n = snprintf(out, size, "%s%s", root, suffix);
    return n >= 0 && (size_t)n < size;
}

static void skip_space(const char **p) {
    while (**p == ' ' || **p == '\t' || **p == '\n' || **p == '\r') (*p)++;
}

static bool unsigned_number(const char **p, uint64_t *number) {
    skip_space(p);
    if (**p < '0' || **p > '9') return false;
    uint64_t value = 0;
    do {
        unsigned digit = (unsigned)(*(*p)++ - '0');
        if (value > UINT64_MAX / 10 ||
            (value == UINT64_MAX / 10 && digit > UINT64_MAX % 10)) return false;
        value = value * 10 + digit;
    } while (**p >= '0' && **p <= '9');
    *number = value;
    return true;
}

static enum scalar_status read_scalar(const char *path, uint64_t *number) {
    FILE *file = fopen(path, "re");
    if (!file) return errno == ENOENT ? SCALAR_MISSING : SCALAR_ERROR;
    char line[128];
    bool read = fgets(line, sizeof(line), file) != NULL;
    bool more = read && !strchr(line, '\n') && !feof(file);
    bool failed = ferror(file);
    fclose(file);
    if (!read || more || failed) return SCALAR_ERROR;
    const char *p = line;
    skip_space(&p);
    if (!strncmp(p, "max", 3)) {
        p += 3;
        skip_space(&p);
        return *p ? SCALAR_ERROR : SCALAR_MAX;
    }
    if (!unsigned_number(&p, number)) return SCALAR_ERROR;
    skip_space(&p);
    return *p ? SCALAR_ERROR : SCALAR_NUMBER;
}

static bool read_named_kib(const char *path, const char *name, uint64_t *bytes) {
    FILE *file = fopen(path, "re");
    if (!file) return false;
    char line[512];
    bool success = false;
    size_t name_size = strlen(name);
    while (fgets(line, sizeof(line), file)) {
        if (strncmp(line, name, name_size)) continue;
        const char *p = line + name_size;
        uint64_t kib;
        if (!unsigned_number(&p, &kib) || kib > UINT64_MAX / 1024) break;
        skip_space(&p);
        if (strncmp(p, "kB", 2)) break;
        p += 2;
        skip_space(&p);
        if (*p) break;
        *bytes = kib * 1024;
        success = true;
        break;
    }
    if (ferror(file)) success = false;
    fclose(file);
    return success;
}

static void constrain(struct estimate *estimate, uint64_t bytes, const char *limiting) {
    if (bytes >= estimate->bytes) return;
    estimate->bytes = bytes;
    snprintf(estimate->limiting, sizeof(estimate->limiting), "%s", limiting);
}

static bool absolute_clean_path(const char *path) {
    if (*path != '/') return false;
    const char *p = path;
    while (*p) {
        while (*p == '/') p++;
        const char *start = p;
        while (*p && *p != '/') p++;
        size_t length = (size_t)(p - start);
        if ((length == 1 && *start == '.') ||
            (length == 2 && start[0] == '.' && start[1] == '.')) return false;
    }
    return true;
}

static bool decode_mount_path(const char *input, char *out, size_t size) {
    size_t used = 0;
    while (*input) {
        unsigned char c = (unsigned char)*input++;
        if (c == '\\') {
            unsigned value = 0;
            for (int i = 0; i < 3; i++) {
                if (*input < '0' || *input > '7') return false;
                value = value * 8 + (unsigned)(*input++ - '0');
            }
            if (!value || value > 255) return false;
            c = (unsigned char)value;
        }
        if (used + 1 >= size) return false;
        out[used++] = (char)c;
    }
    out[used] = '\0';
    return absolute_clean_path(out);
}

static bool cgroup_location(const char *proc_root, struct cgroup_mount *mount) {
    char path[PATH_MAX], group[PATH_MAX] = "";
    if (!join_path(path, sizeof(path), proc_root, "/self/cgroup")) return false;
    FILE *file = fopen(path, "re");
    if (!file) return false;
    char *line = NULL;
    size_t allocated = 0;
    while (getline(&line, &allocated, file) >= 0) {
        if (strncmp(line, "0::", 3)) continue;
        line[strcspn(line, "\r\n")] = '\0';
        if (strlen(line + 3) < sizeof(group)) strcpy(group, line + 3);
        break;
    }
    bool failed = ferror(file);
    fclose(file);
    free(line);
    if (failed || !absolute_clean_path(group)) return false;
    if (!join_path(path, sizeof(path), proc_root, "/self/mountinfo")) return false;
    file = fopen(path, "re");
    if (!file) return false;
    line = NULL;
    allocated = 0;
    bool found = false;
    size_t best_root_size = SIZE_MAX;
    while (getline(&line, &allocated, file) >= 0) {
        char *separator = strstr(line, " - cgroup2 ");
        if (!separator) continue;
        bool accounts_hugetlb = strstr(separator, "memory_hugetlb_accounting") != NULL;
        char *save = NULL, *field = strtok_r(line, " ", &save);
        char *root_field = NULL, *point_field = NULL;
        for (unsigned index = 0; field && index <= 4; index++, field = strtok_r(NULL, " ", &save)) {
            if (index == 3) root_field = field;
            if (index == 4) point_field = field;
        }
        char root[PATH_MAX], point[PATH_MAX];
        if (!root_field || !point_field ||
            !decode_mount_path(root_field, root, sizeof(root)) ||
            !decode_mount_path(point_field, point, sizeof(point))) continue;
        size_t root_size = strlen(root);
        const char *suffix;
        if (!strcmp(root, "/")) suffix = !strcmp(group, "/") ? "" : group;
        else if (!strncmp(group, root, root_size) && (group[root_size] == '/' || !group[root_size]))
            suffix = group + root_size;
        else if (!strcmp(group, "/")) suffix = ""; /* A namespaced root. */
        else continue;
        /* Prefer the mount exposing the most ancestors, since a narrower
         * bind mount could conceal a limiting parent that is still readable. */
        if (found && root_size >= best_root_size) continue;
        if (!join_path(mount->current, sizeof(mount->current), point, suffix)) continue;
        strcpy(mount->point, point);
        mount->memory_accounts_hugetlb = accounts_hugetlb;
        found = true;
        best_root_size = root_size;
    }
    failed = ferror(file);
    fclose(file);
    free(line);
    return found && !failed;
}

static bool constrain_controller(struct estimate *estimate, const char *directory,
                                 const char *controller, char *reason, size_t reason_size) {
    char maximum_path[PATH_MAX], current_path[PATH_MAX];
    int n = snprintf(maximum_path, sizeof(maximum_path), "%s/%s.max", directory, controller);
    int m = snprintf(current_path, sizeof(current_path), "%s/%s.current", directory, controller);
    if (n < 0 || m < 0 || (size_t)n >= sizeof(maximum_path) || (size_t)m >= sizeof(current_path)) {
        message(reason, reason_size, "Cannot inspect a cgroup path longer than PATH_MAX");
        return false;
    }
    uint64_t maximum = 0, current = 0;
    enum scalar_status status = read_scalar(maximum_path, &maximum);
    /* The hierarchy root and disabled controllers legitimately omit these. */
    if (status == SCALAR_MISSING || status == SCALAR_MAX) return true;
    if (status != SCALAR_NUMBER || read_scalar(current_path, &current) != SCALAR_NUMBER) {
        if (reason && reason_size)
            snprintf(reason, reason_size, "Cannot read cgroup %s max/current; refusing an unbounded estimate", controller);
        return false;
    }
    char limiting[128];
    snprintf(limiting, sizeof(limiting), "cgroup %s.max headroom", controller);
    constrain(estimate, maximum > current ? maximum - current : 0, limiting);
    return true;
}

static bool constrain_cgroups(struct estimate *estimate, const char *proc_root, bool hugetlb,
                              char *reason, size_t reason_size) {
    struct cgroup_mount mount;
    if (!cgroup_location(proc_root, &mount)) {
        message(reason, reason_size, "Cannot locate the current cgroup v2 hierarchy; automatic maximum is unavailable");
        return false;
    }
    char current[PATH_MAX];
    strcpy(current, mount.current);
    for (;;) {
        struct stat directory;
        if (stat(current, &directory) < 0 || !S_ISDIR(directory.st_mode)) {
            message(reason, reason_size, "Current cgroup directory is unavailable; retry after migration settles");
            return false;
        }
        if ((!hugetlb || mount.memory_accounts_hugetlb) &&
            !constrain_controller(estimate, current, "memory", reason, reason_size)) return false;
        if (hugetlb &&
            (!constrain_controller(estimate, current, "hugetlb.2MB", reason, reason_size) ||
             !constrain_controller(estimate, current, "hugetlb.2MB.rsvd", reason, reason_size))) return false;
        if (!strcmp(current, mount.point)) break;
        char *slash = strrchr(current, '/');
        if (!slash || (slash < current + strlen(mount.point) && strcmp(mount.point, "/"))) {
            message(reason, reason_size, "Cgroup parent traversal escaped its mount; automatic maximum is unavailable");
            return false;
        }
        if (slash == current) slash[1] = '\0';
        else *slash = '\0';
    }
    return true;
}

static bool constrain_rlimit(struct estimate *estimate, const char *proc_root, int resource,
                             const char *status_name, const char *label,
                             char *reason, size_t reason_size) {
    struct rlimit limit;
    if (getrlimit(resource, &limit) < 0) {
        message(reason, reason_size, "Cannot read process resource limits");
        return false;
    }
    if (limit.rlim_cur == RLIM_INFINITY) return true;
    char status_path[PATH_MAX];
    uint64_t used;
    if (!join_path(status_path, sizeof(status_path), proc_root, "/self/status") ||
        !read_named_kib(status_path, status_name, &used)) {
        message(reason, reason_size, "Cannot read current process usage for its finite resource limit");
        return false;
    }
    uint64_t maximum = (uint64_t)limit.rlim_cur;
    constrain(estimate, maximum > used ? maximum - used : 0, label);
    return true;
}

/* Paths are parameters so unit tests can include this translation unit and
 * exercise kernel snapshots without changing host memory or cgroup settings. */
static uint64_t available_pages_at(const char *proc_root, const char *sys_root,
                                   bool hugetlb, bool lock_pages, uint64_t explicit_max_pages,
                                   char *reason, size_t reason_size) {
    struct estimate estimate = {.bytes = 0};
    char path[PATH_MAX];
    if (hugetlb) {
        uint64_t free_pages, reserved;
        if (!join_path(path, sizeof(path), sys_root, "/kernel/mm/hugepages/hugepages-2048kB/free_hugepages") ||
            read_scalar(path, &free_pages) != SCALAR_NUMBER ||
            !join_path(path, sizeof(path), sys_root, "/kernel/mm/hugepages/hugepages-2048kB/resv_hugepages") ||
            read_scalar(path, &reserved) != SCALAR_NUMBER) {
            message(reason, reason_size, "Cannot read the kernel's free/reserved 2 MiB HugeTLB page counts");
            return 0;
        }
        uint64_t pages = free_pages > reserved ? free_pages - reserved : 0;
        estimate.bytes = pages > UINT64_MAX / PAGE_BYTES ? UINT64_MAX : pages * PAGE_BYTES;
        strcpy(estimate.limiting, "free minus reserved 2 MiB HugeTLB pages");
    } else {
        if (!join_path(path, sizeof(path), proc_root, "/meminfo") ||
            !read_named_kib(path, "MemAvailable:", &estimate.bytes)) {
            message(reason, reason_size, "Cannot read MemAvailable; automatic maximum is unavailable");
            return 0;
        }
        strcpy(estimate.limiting, "host MemAvailable");
    }
    if (!constrain_cgroups(&estimate, proc_root, hugetlb, reason, reason_size)) return 0;
    uint64_t reserve = 0;
    if (!hugetlb) {
        reserve = estimate.bytes / 10;
        if (reserve < MIN_RESERVE) reserve = MIN_RESERVE;
        estimate.bytes = estimate.bytes > reserve ? estimate.bytes - reserve : 0;
    }
    if (!constrain_rlimit(&estimate, proc_root, RLIMIT_AS, "VmSize:", "RLIMIT_AS residual", reason, reason_size) ||
        (lock_pages && !constrain_rlimit(&estimate, proc_root, RLIMIT_MEMLOCK, "VmLck:",
                                       "RLIMIT_MEMLOCK residual", reason, reason_size))) return 0;
    uint64_t pages = estimate.bytes / PAGE_BYTES;
    if (explicit_max_pages && pages > explicit_max_pages) {
        pages = explicit_max_pages;
        strcpy(estimate.limiting, "explicit maximum page cap");
    }
    if (reason && reason_size) {
        snprintf(reason, reason_size,
            "%" PRIu64 " pages; limited by %s; safety reserve=%" PRIu64
            " MiB. Snapshot only: competing allocations, permissions or hidden ancestor limits may reduce it.",
            pages, estimate.limiting, reserve / (1024 * 1024));
    }
    return pages;
}

uint64_t hk_available_pages(bool hugetlb, bool lock_pages, uint64_t explicit_max_pages,
                            char *reason, size_t reason_size) {
    return available_pages_at("/proc", "/sys", hugetlb, lock_pages, explicit_max_pages, reason, reason_size);
}
