"""Low-overhead Linux shared huge-page leases.

Keep the lease alive while using its mapping. Release every exported buffer
(including memoryviews and NumPy arrays) before calling ``close``. An admin can
revoke a lease at any time; accessing a revoked mapping causes SIGBUS, which
cannot safely be recovered from as a Python exception.
"""

from __future__ import annotations

import array
import json
import mmap
import os
import socket
import sys
import weakref
from typing import Any

__all__ = ["BrokerError", "Lease", "acquire", "admin_request"]

_MAX_REQUEST = 255
_MAX_RESPONSE = 4096
_ANCILLARY_BYTES = socket.CMSG_SPACE(16 * array.array("i").itemsize)


class BrokerError(RuntimeError):
    """A daemon error or a malformed protocol response.

    ``code`` is a stable error name, and ``response`` is the decoded reply when
    one is available. Network errors are raised as their original OSError.
    """

    def __init__(
        self, code: str, message: str, response: dict[str, Any] | None = None
    ) -> None:
        self.code = code
        self.message = message
        self.response = response
        super().__init__(f"{code}: {message}")


def _request_bytes(command: str) -> bytes:
    try:
        packet = command.encode("ascii")
    except UnicodeEncodeError as exc:
        raise ValueError("commands must be ASCII") from exc
    if not packet or len(packet) > _MAX_REQUEST or any(c in packet for c in (0, 10, 13)):
        raise ValueError("command must be one nonempty ASCII line of at most 255 bytes")
    return packet


def _send(sock: socket.socket, packet: bytes) -> None:
    # SOCK_SEQPACKET preserves this write as one request.
    if sock.send(packet) != len(packet):
        raise OSError("short SOCK_SEQPACKET send")


def _close_fds(fds: list[int]) -> None:
    for fd in fds:
        try:
            os.close(fd)
        except OSError:
            pass


def _finalize_connection(fd: int, sock: socket.socket) -> None:
    # The mapping owns a reference to its Lease, so a live exported buffer
    # prevents this finalizer from running. It sends no protocol messages.
    _close_fds([fd])
    sock.close()


def _receive(sock: socket.socket, *, expect_fd: bool = False) -> tuple[dict[str, Any], list[int]]:
    packet, controls, flags, _ = sock.recvmsg(
        _MAX_RESPONSE, _ANCILLARY_BYTES, socket.MSG_CMSG_CLOEXEC
    )
    fds: list[int] = []
    try:
        unexpected_control = False
        for level, kind, data in controls:
            if level != socket.SOL_SOCKET or kind != socket.SCM_RIGHTS:
                unexpected_control = True
                continue
            values = array.array("i")
            complete = len(data) - (len(data) % values.itemsize)
            values.frombytes(data[:complete])
            fds.extend(values)
            if complete != len(data):
                unexpected_control = True
        if flags & (socket.MSG_TRUNC | socket.MSG_CTRUNC):
            raise BrokerError("protocol", "truncated daemon response")
        if unexpected_control:
            raise BrokerError("protocol", "unexpected ancillary response data")
        if not packet:
            raise BrokerError("protocol", "daemon closed the connection without replying")
        try:
            reply = json.loads(packet.decode("utf-8"))
        except (UnicodeError, ValueError) as exc:
            raise BrokerError("protocol", "daemon response is not valid UTF-8 JSON") from exc
        if not isinstance(reply, dict) or type(reply.get("ok")) is not bool:
            raise BrokerError("protocol", "daemon response requires a boolean 'ok'")
        if not reply["ok"]:
            if fds or not isinstance(reply.get("error"), str) or not isinstance(reply.get("message"), str):
                raise BrokerError("protocol", "malformed daemon error response", reply)
            raise BrokerError(reply["error"], reply["message"], reply)
        if len(fds) != int(expect_fd):
            raise BrokerError("protocol", "unexpected number of received file descriptors", reply)
        # MSG_CMSG_CLOEXEC applies at receipt, avoiding an exec inheritance race.
        return reply, fds
    except BaseException:
        _close_fds(fds)
        raise


class _LeaseMapping(mmap.mmap):
    """An exported buffer keeps its owning lease and connection alive."""


class Lease:
    """Acquire and map one pool slot over a dedicated Unix socket.

    ``mapping`` is a writable MAP_SHARED mmap. ``size``, ``lease_id`` and
    ``backend`` describe the acquired slot. The control socket stays idle until
    release; ordinary reads and writes do not involve the daemon.

    ``close`` first unmaps, then releases the slot and closes the descriptors.
    If a memoryview or other exported buffer is alive, it raises BufferError
    and preserves the lease for a later close. No destructor sends RELEASE.
    Always close explicitly, preferably with a context manager. Do not close
    internal socket/descriptors yourself or use a lease across fork.

    Administrative revocation invalidates the mapping immediately and causes
    SIGBUS on subsequent memory access. Coordinate revocation with users of
    the mapping; this class cannot turn that signal into a safe exception.
    """

    def __init__(self, socket_path: str | os.PathLike[str], *, timeout: float = 5.0) -> None:
        self.socket_path = os.fspath(socket_path)
        self._socket: socket.socket | None = None
        self._fd: int | None = None
        self._finalizer: weakref.finalize | None = None
        self._closed = False
        self.mapping: mmap.mmap
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET)
        self._socket = sock
        try:
            sock.settimeout(timeout)
            sock.connect(self.socket_path)
            _send(sock, b"ACQUIRE")
            reply, fds = _receive(sock, expect_fd=True)
            self._fd = fds[0]
            size = reply.get("size")
            lease_id = reply.get("lease")
            backend = reply.get("backend")
            if (
                type(size) is not int
                or not 0 < size <= sys.maxsize
                or type(lease_id) is not int
                or lease_id <= 0
                or not isinstance(backend, str)
                or os.fstat(self._fd).st_size != size
            ):
                raise BrokerError("protocol", "invalid lease metadata", reply)
            self.size = size
            self.lease_id = lease_id
            self.backend = backend
            mapped = _LeaseMapping(
                self._fd, size, flags=mmap.MAP_SHARED, prot=mmap.PROT_READ | mmap.PROT_WRITE
            )
            # A surviving memoryview pins mapped, which pins this lease. In
            # particular, BufferError during context exit cannot silently
            # disconnect the lease while the exported view remains live.
            mapped._lease_owner = self
            self.mapping = mapped
            self._finalizer = weakref.finalize(self, _finalize_connection, self._fd, sock)
            # Interpreter shutdown closes descriptors itself. Running an exit
            # finalizer while another atexit callback still uses a live view
            # would bypass the ownership guarantee above.
            self._finalizer.atexit = False
        except BaseException:
            self._dispose_connection()
            self._closed = True
            raise

    @property
    def closed(self) -> bool:
        return self._closed

    def _dispose_connection(self) -> None:
        if self._finalizer is not None:
            self._finalizer.detach()
            self._finalizer = None
        fd, self._fd = self._fd, None
        sock, self._socket = self._socket, None
        try:
            if fd is not None:
                os.close(fd)
        finally:
            if sock is not None:
                sock.close()

    def close(self) -> None:
        """Unmap and release; retry after dropping views if BufferError is raised."""
        if self._closed:
            return
        # Never release or disconnect when this raises: a live exported view
        # must not point into a slot that the broker is allowed to reclaim.
        self.mapping.close()
        self.mapping._lease_owner = None
        self._closed = True
        try:
            assert self._socket is not None
            _send(self._socket, _request_bytes(f"RELEASE {self.lease_id}"))
            try:
                _receive(self._socket)
            except BrokerError as exc:
                if exc.code != "not_found":
                    raise
                # Administrative revocation has already released this lease.
        finally:
            self._dispose_connection()

    def __enter__(self) -> Lease:
        if self._closed:
            raise ValueError("lease is closed")
        return self

    def __exit__(self, exc_type: Any, exc: Any, traceback: Any) -> None:
        self.close()


def acquire(socket_path: str | os.PathLike[str], *, timeout: float = 5.0) -> Lease:
    """Acquire one slot; equivalent to ``Lease(socket_path, timeout=timeout)``."""
    return Lease(socket_path, timeout=timeout)


def admin_request(
    socket_path: str | os.PathLike[str], command: str, *, timeout: float = 5.0
) -> dict[str, Any]:
    """Send one admin command to ``str(socket_path) + '.admin'``.

    Commands include STATUS, ALLOW uid, DENY uid, REVOKE lease, RESIZE slots,
    and REFILL. Only the daemon UID is permitted to use the admin socket.
    """
    packet = _request_bytes(command)
    with socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET) as sock:
        sock.settimeout(timeout)
        sock.connect(os.fspath(socket_path) + ".admin")
        _send(sock, packet)
        reply, _ = _receive(sock)
        return reply
