#ifndef HUGEKEEPER_H
#define HUGEKEEPER_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Linux only. Do not copy a live lease or use it across fork. The descriptors
 * are implementation details; application reads/writes go directly through
 * data. Administrative revocation makes further data access raise SIGBUS. */
struct hk_lease {
    void *data;
    size_t size;
    uint64_t id;
    char backend[16];
    int fd;
    int socket_fd;
};

#define HK_LEASE_INIT {NULL, 0, 0, {0}, -1, -1}

/* Acquire one slot. out must not already own a lease. On failure, out is reset
 * to HK_LEASE_INIT. Returns 0 or -1 with errno set. Daemon errors map to EACCES
 * (denied), EAGAIN (empty), EBUSY, EINVAL, ENOENT, ENOMEM or EIO; malformed
 * responses use EPROTO. Control socket send/receive timeout is five seconds. */
int hk_acquire(const char *socket_path, struct hk_lease *out);

/* Stop all pointer/buffer users before release. Unmaps first, then sends
 * RELEASE and closes both descriptors even if that exchange fails. A lease
 * already revoked by the administrator is released successfully. If munmap
 * fails, the lease remains intact for retry. Repeated release is harmless.
 * Initialize an unused lease with HK_LEASE_INIT before releasing it. */
int hk_release(struct hk_lease *lease);

#ifdef __cplusplus
}
#endif

#endif
