# Hugekeeper protocol v1

Linux Unix `SOCK_SEQPACKET`. One ASCII request per packet, maximum 255 bytes,
optional trailing newline. Replies are UTF-8 JSON, at most 4096 bytes.
Every reply has `ok` (boolean); errors have `error` and `message` strings.
There are two filesystem sockets: PATH (data, mode 0666) and PATH.admin
(admin, mode 0600). The parent directory must be owned by the daemon user
and not writable by group/others. Clients authenticate with `SO_PEERCRED`.
Only the daemon UID can use the admin socket. Data acquisition requires
explicit UID authorization, including for the daemon UID.

Data commands:

- `ACQUIRE`: at most one lease per connection. Successful reply:
  `{"ok":true,"lease":1,"size":4194304,"backend":"thp"}` and exactly one
  `SCM_RIGHTS` file descriptor. Map using MAP_SHARED. Keep connection alive.
- `RELEASE <lease>`: only releases this connection's lease. Unmap BEFORE
  release. Response `{"ok":true}`. Disconnect also releases the lease.
- `PING`: response `{"ok":true}`.

Admin commands:

- `STATUS`: reply includes `backend`, `slot_bytes`, `capacity`, `ready`,
  `leased`, `degraded`, `pool_bytes`, `pid`, `allowed_uids`, and `leases`
  (list of objects with `lease`, `uid`, `pid`). Also includes `page_bytes`
  (2097152), `total_pages`, `ready_pages`, `leased_pages`, `memory_observed`,
  `resident_bytes`, `hugetlb_bytes`, `thp_mapped_bytes`, and `locked`.
- `ALLOW <uid>`: enables future acquisitions.
- `DENY <uid>`: disables acquisitions AND immediately revokes that UID's leases.
- `REVOKE <lease>`: immediately invalidates a particular lease.
- `RESIZE <slots>`: changes capacity. Shrinking only removes idle/degraded
  slots, failing with `busy` if target is below current leased count.
  Growing allocates all extra slots before committing; failure rolls back.
- `REFILL`: retries allocating degraded slots.
- `FREE`: immediately invalidates all active leases and returns the entire
  pool to the OS, setting capacity to zero without refilling. Authorization
  policies and slot size remain. `RESIZE` can allocate slots again later.

Each command replies once. Admin operations return `{"ok":true}` except
STATUS. Error names include `denied`, `empty`, `busy`, `invalid`, `not_found`,
`allocation`, `internal`. Unknown commands and malformed/oversized packets
return an error. Unexpected ancillary FDs are closed and request rejected.

Revocation truncates the old inode to zero and replaces it. The old file is
sealed against growth and further seals. Stale mapping access receives
SIGBUS; stale file descriptors cannot grow back. Never reuse an old inode.
An admin revoke leaves the data connection open; its holder may acquire again
if still authorized. Release of an already revoked lease returns not_found.

The socket is a capability: an authorized process can deliberately pass its
FD or connection to another process. UIDs, not individual PIDs, form the
authorization boundary. Abrupt daemon death does not revoke existing mappings.
Normal SIGINT/SIGTERM shutdown revokes every lease before closing sockets.
