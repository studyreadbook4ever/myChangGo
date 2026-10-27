"""Native client protocol and descriptor lifetime checks against a fake broker."""

import array
import ctypes
import errno
import json
import os
from pathlib import Path
import shlex
import socket
import subprocess
import tempfile
import threading
import unittest


ROOT = Path(__file__).resolve().parents[1]


class NativeLease(ctypes.Structure):
    _fields_ = [
        ("data", ctypes.c_void_p),
        ("size", ctypes.c_size_t),
        ("id", ctypes.c_uint64),
        ("backend", ctypes.c_char * 16),
        ("fd", ctypes.c_int),
        ("socket_fd", ctypes.c_int),
    ]


class NativeClientTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.build_directory = tempfile.TemporaryDirectory(prefix="hk-native-build-")
        cls.addClassCleanup(cls.build_directory.cleanup)
        library = Path(cls.build_directory.name) / "libhugekeeper.so"
        command = shlex.split(os.environ.get("CC", "cc")) + [
            "-I" + str(ROOT / "include"), "-std=c11", "-Wall", "-Wextra",
            "-Wpedantic", "-Werror", "-O2", "-fPIC", "-shared",
            str(ROOT / "src/client.c"), "-o", str(library),
        ]
        subprocess.run(command, check=True, capture_output=True, text=True)
        cls.library = ctypes.CDLL(str(library), use_errno=True)
        cls.library.hk_acquire.argtypes = [ctypes.c_char_p, ctypes.POINTER(NativeLease)]
        cls.library.hk_acquire.restype = ctypes.c_int
        cls.library.hk_release.argtypes = [ctypes.POINTER(NativeLease)]
        cls.library.hk_release.restype = ctypes.c_int

    def exchange(self, packet, descriptor_count, expected_errno=0, *, revoked=False):
        """One acquisition and optional release, asserting no received FD leaks."""
        with tempfile.TemporaryDirectory(prefix="hk-native-") as directory:
            path = directory + "/socket"
            server = socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET)
            self.addCleanup(server.close)
            server.settimeout(3)
            server.bind(path)
            server.listen()
            failures = []

            def broker():
                try:
                    connection, _ = server.accept()
                    with connection:
                        connection.settimeout(3)
                        self.assertEqual(connection.recv(255), b"ACQUIRE")
                        fd = os.memfd_create("native-client-test", os.MFD_CLOEXEC)
                        try:
                            os.ftruncate(fd, 4096)
                            controls = []
                            if descriptor_count:
                                controls = [(socket.SOL_SOCKET, socket.SCM_RIGHTS,
                                             array.array("i", [fd] * descriptor_count))]
                            connection.sendmsg([packet], controls)
                            if not expected_errno:
                                self.assertEqual(connection.recv(255), b"RELEASE 17")
                                self.assertEqual(os.pread(fd, 4, 0), b"test")
                                response = {"ok": True}
                                if revoked:
                                    response = {"ok": False, "error": "not_found", "message": "revoked"}
                                connection.send(json.dumps(response).encode())
                        finally:
                            os.close(fd)
                except BaseException as exc:
                    failures.append(exc)

            baseline_fds = len(os.listdir("/proc/self/fd"))
            thread = threading.Thread(target=broker, daemon=True)
            thread.start()
            lease = NativeLease()
            try:
                result = self.library.hk_acquire(os.fsencode(path), ctypes.byref(lease))
                if expected_errno:
                    self.assertEqual(result, -1)
                    self.assertEqual(ctypes.get_errno(), expected_errno)
                    self.assertIsNone(lease.data)
                    self.assertEqual(lease.fd, -1)
                    self.assertEqual(lease.socket_fd, -1)
                else:
                    self.assertEqual(result, 0, os.strerror(ctypes.get_errno()))
                    self.assertEqual(lease.size, 4096)
                    self.assertEqual(lease.id, 17)
                    self.assertEqual(lease.backend, b"plain")
                    self.assertFalse(os.get_inheritable(lease.fd))
                    self.assertFalse(os.get_inheritable(lease.socket_fd))
                    ctypes.memmove(lease.data, b"test", 4)
                    self.assertEqual(self.library.hk_release(ctypes.byref(lease)), 0)
                    self.assertEqual(self.library.hk_release(ctypes.byref(lease)), 0)
            finally:
                # Also cleans up on an assertion failure without leaving the
                # fake broker or its descriptor behind in the test process.
                if lease.socket_fd >= 0:
                    self.library.hk_release(ctypes.byref(lease))
                thread.join(4)
            self.assertFalse(thread.is_alive(), "fake broker did not terminate")
            self.assertEqual(failures, [])
            self.assertEqual(len(os.listdir("/proc/self/fd")), baseline_fds)
            server.close()

    @staticmethod
    def normal_packet():
        # Intentionally reordered, with whitespace: the client is not coupled
        # to the daemon's current serialization layout.
        return json.dumps({"backend": "plain", "size": 4096, "lease": 17, "ok": True}).encode()

    def test_shared_mapping_and_idempotent_release(self):
        self.exchange(self.normal_packet(), 1)

    def test_release_after_revoke(self):
        self.exchange(self.normal_packet(), 1, revoked=True)

    def test_daemon_error_to_errno(self):
        codes = {"denied": errno.EACCES, "empty": errno.EAGAIN, "busy": errno.EBUSY,
                 "invalid": errno.EINVAL, "not_found": errno.ENOENT,
                 "allocation": errno.ENOMEM, "internal": errno.EIO}
        for code, expected in codes.items():
            with self.subTest(code=code):
                self.exchange(json.dumps({"message": "error", "error": code, "ok": False}).encode(),
                              0, expected)

    def test_rejects_bad_ancillary_data_without_leaks(self):
        for descriptor_count in (0, 2, 40):
            with self.subTest(descriptor_count=descriptor_count):
                self.exchange(self.normal_packet(), descriptor_count, errno.EPROTO)

    def test_rejects_malformed_metadata_without_leaks(self):
        packets = [
            b"{bad}",
            b"x" * 5000,
            b'{"ok":true,"lease":18446744073709551616,"size":4096,"backend":"plain"}',
            b'{"ok":true,"lease":17,"size":0,"backend":"plain"}',
            b'{"ok":true,"lease":17,"size":8192,"backend":"plain"}',
            b'{"ok":true,"lease":17,"size":4096,"backend":"plain","ok":true}',
            self.normal_packet() + b"\0",
        ]
        for packet in packets:
            with self.subTest(packet=packet[:100]):
                self.exchange(packet, 1, errno.EPROTO)


if __name__ == "__main__":
    unittest.main()
