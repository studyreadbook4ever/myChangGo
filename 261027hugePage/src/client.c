#define _GNU_SOURCE
#include "hugekeeper.h"

#include <errno.h>
#include <inttypes.h>
#include <stdbool.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <sys/un.h>
#include <unistd.h>

#define RESPONSE_MAX 4096

struct response {
    bool ok;
    unsigned fields;
    uint64_t lease, size;
    char backend[16], error[32];
};

enum { HAS_OK = 1, HAS_LEASE = 2, HAS_SIZE = 4, HAS_BACKEND = 8,
       HAS_ERROR = 16, HAS_MESSAGE = 32 };

static void whitespace(const char **p) {
    while (**p == ' ' || **p == '\t' || **p == '\r' || **p == '\n') (*p)++;
}

static bool token(const char **p, const char *value) {
    whitespace(p);
    size_t n = strlen(value);
    if (strncmp(*p, value, n)) return false;
    *p += n;
    return true;
}

/* Small bounded parser for the protocol's flat ACQUIRE/RELEASE responses.
 * It accepts arbitrary field ordering and JSON whitespace. Known identifiers
 * are ASCII; message text is skipped and may contain escaped Unicode. */
static bool string_value(const char **p, char *out, size_t capacity) {
    if (!token(p, "\"")) return false;
    size_t used = 0;
    while (**p && **p != '"') {
        unsigned char c = (unsigned char)*(*p)++;
        if (c < 0x20) return false;
        if (c == '\\') {
            c = (unsigned char)*(*p)++;
            if (!c) return false;
            if (c == 'u') {
                for (int i = 0; i < 4; i++) {
                    char h = **p;
                    if (!((h >= '0' && h <= '9') || (h >= 'a' && h <= 'f') ||
                          (h >= 'A' && h <= 'F'))) return false;
                    (*p)++;
                }
                if (out) return false;
                continue;
            }
            if (!strchr("\"\\/bfnrt", c)) return false;
            if (out) return false; /* Identifiers never require escapes. */
        }
        if (out) {
            if (used + 1 >= capacity) return false;
            out[used++] = (char)c;
        }
    }
    if (**p != '"') return false;
    (*p)++;
    if (out) out[used] = '\0';
    return true;
}

static bool number_value(const char **p, uint64_t *out) {
    whitespace(p);
    if (**p < '0' || **p > '9') return false;
    if (**p == '0' && (*p)[1] >= '0' && (*p)[1] <= '9') return false;
    uint64_t value = 0;
    while (**p >= '0' && **p <= '9') {
        unsigned digit = (unsigned)(*(*p)++ - '0');
        if (value > UINT64_MAX / 10 ||
            (value == UINT64_MAX / 10 && digit > UINT64_MAX % 10)) return false;
        value = value * 10 + digit;
    }
    *out = value;
    return true;
}

static bool parse_response(const char *p, struct response *r) {
    memset(r, 0, sizeof(*r));
    if (!token(&p, "{")) return false;
    do {
        char key[16];
        unsigned field;
        if (!string_value(&p, key, sizeof(key)) || !token(&p, ":")) return false;
        if (!strcmp(key, "ok")) {
            field = HAS_OK;
            if (token(&p, "true")) r->ok = true;
            else if (!token(&p, "false")) return false;
        } else if (!strcmp(key, "lease")) {
            field = HAS_LEASE;
            if (!number_value(&p, &r->lease)) return false;
        } else if (!strcmp(key, "size")) {
            field = HAS_SIZE;
            if (!number_value(&p, &r->size)) return false;
        } else if (!strcmp(key, "backend")) {
            field = HAS_BACKEND;
            if (!string_value(&p, r->backend, sizeof(r->backend))) return false;
        } else if (!strcmp(key, "error")) {
            field = HAS_ERROR;
            if (!string_value(&p, r->error, sizeof(r->error))) return false;
        } else if (!strcmp(key, "message")) {
            field = HAS_MESSAGE;
            if (!string_value(&p, NULL, 0)) return false;
        } else return false;
        if (r->fields & field) return false;
        r->fields |= field;
    } while (token(&p, ","));
    if (!token(&p, "}")) return false;
    whitespace(&p);
    return *p == '\0' && (r->fields & HAS_OK);
}

static int daemon_errno(const char *code) {
    if (!strcmp(code, "denied")) return EACCES;
    if (!strcmp(code, "empty")) return EAGAIN;
    if (!strcmp(code, "busy")) return EBUSY;
    if (!strcmp(code, "invalid")) return EINVAL;
    if (!strcmp(code, "not_found")) return ENOENT;
    if (!strcmp(code, "allocation")) return ENOMEM;
    return EIO;
}

static int receive_response(int sock, bool acquiring, struct response *response, int *out_fd) {
    char packet[RESPONSE_MAX + 1];
    union { struct cmsghdr align; char bytes[CMSG_SPACE(16 * sizeof(int))]; } controls;
    memset(&controls, 0, sizeof(controls));
    struct iovec iov = {.iov_base = packet, .iov_len = RESPONSE_MAX};
    struct msghdr msg = {.msg_iov = &iov, .msg_iovlen = 1,
        .msg_control = controls.bytes, .msg_controllen = sizeof(controls.bytes)};
    ssize_t received;
    do { received = recvmsg(sock, &msg, MSG_CMSG_CLOEXEC); }
    while (received < 0 && errno == EINTR);
    if (received < 0) return -1;
    int fd = -1;
    unsigned fd_count = 0;
    bool bad_control = false;
    for (struct cmsghdr *c = CMSG_FIRSTHDR(&msg); c; c = CMSG_NXTHDR(&msg, c)) {
        if (c->cmsg_level != SOL_SOCKET || c->cmsg_type != SCM_RIGHTS ||
            c->cmsg_len < CMSG_LEN(0)) {
            bad_control = true;
            continue;
        }
        size_t bytes = c->cmsg_len - CMSG_LEN(0);
        if (bytes % sizeof(int)) bad_control = true;
        for (size_t i = 0; i + sizeof(int) <= bytes; i += sizeof(int)) {
            int received_fd;
            memcpy(&received_fd, (char *)CMSG_DATA(c) + i, sizeof(received_fd));
            if (fd_count++ == 0) fd = received_fd;
            else close(received_fd);
        }
    }
    int error = EPROTO;
    if (received == 0 || bad_control || (msg.msg_flags & (MSG_TRUNC | MSG_CTRUNC))) goto fail;
    if (memchr(packet, '\0', (size_t)received)) goto fail;
    packet[received] = '\0';
    if (!parse_response(packet, response)) goto fail;
    if (!response->ok) {
        if (fd_count || response->fields != (HAS_OK | HAS_ERROR | HAS_MESSAGE)) goto fail;
        error = daemon_errno(response->error);
        goto fail;
    }
    if (fd_count != (unsigned)acquiring) goto fail;
    if (acquiring) {
        if (response->fields != (HAS_OK | HAS_LEASE | HAS_SIZE | HAS_BACKEND) ||
            !response->lease || !response->size || response->size > SIZE_MAX ||
            !response->backend[0]) goto fail;
    } else if (response->fields != HAS_OK) goto fail;
    *out_fd = fd;
    return 0;
fail:
    if (fd >= 0) close(fd);
    errno = error;
    return -1;
}

static int send_request(int fd, const char *request) {
    size_t length = strlen(request);
    ssize_t sent;
    do { sent = send(fd, request, length, MSG_NOSIGNAL); } while (sent < 0 && errno == EINTR);
    if (sent < 0) return -1;
    if ((size_t)sent != length) { errno = EIO; return -1; }
    return 0;
}

static void dispose(struct hk_lease *lease) {
    if (lease->fd >= 0) close(lease->fd);
    if (lease->socket_fd >= 0) close(lease->socket_fd);
    *lease = (struct hk_lease)HK_LEASE_INIT;
}

int hk_acquire(const char *socket_path, struct hk_lease *out) {
    if (!out) { errno = EINVAL; return -1; }
    *out = (struct hk_lease)HK_LEASE_INIT;
    if (!socket_path || !*socket_path) { errno = EINVAL; return -1; }
    struct sockaddr_un address = {.sun_family = AF_UNIX};
    size_t path_length = strlen(socket_path);
    if (path_length >= sizeof(address.sun_path)) { errno = ENAMETOOLONG; return -1; }
    memcpy(address.sun_path, socket_path, path_length + 1);
    out->socket_fd = socket(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC, 0);
    if (out->socket_fd < 0) return -1;
    struct timeval timeout = {.tv_sec = 5};
    if (setsockopt(out->socket_fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout)) < 0 ||
        setsockopt(out->socket_fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout)) < 0 ||
        connect(out->socket_fd, (struct sockaddr *)&address, sizeof(address)) < 0 ||
        send_request(out->socket_fd, "ACQUIRE") < 0) goto fail;
    struct response response;
    if (receive_response(out->socket_fd, true, &response, &out->fd) < 0) goto fail;
    struct stat stat;
    if (fstat(out->fd, &stat) < 0) goto fail;
    if (stat.st_size < 0 || (uintmax_t)stat.st_size != response.size) {
        errno = EPROTO;
        goto fail;
    }
    void *mapping = mmap(NULL, (size_t)response.size, PROT_READ | PROT_WRITE, MAP_SHARED, out->fd, 0);
    if (mapping == MAP_FAILED) goto fail;
    out->data = mapping;
    out->size = (size_t)response.size;
    out->id = response.lease;
    memcpy(out->backend, response.backend, sizeof(out->backend));
    return 0;
fail:;
    int saved = errno;
    dispose(out);
    errno = saved;
    return -1;
}

int hk_release(struct hk_lease *lease) {
    if (!lease) { errno = EINVAL; return -1; }
    if (lease->size && munmap(lease->data, lease->size) < 0) return -1;
    lease->data = NULL;
    int error = 0;
    if (lease->socket_fd >= 0 && lease->id) {
        char request[64];
        snprintf(request, sizeof(request), "RELEASE %" PRIu64, lease->id);
        if (send_request(lease->socket_fd, request) < 0) error = errno;
        else {
            struct response response;
            int unused_fd = -1;
            if (receive_response(lease->socket_fd, false, &response, &unused_fd) < 0 && errno != ENOENT)
                error = errno;
        }
    }
    dispose(lease);
    if (error) { errno = error; return -1; }
    return 0;
}
