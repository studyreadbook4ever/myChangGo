"""Release failures must still dispose SDK mappings and received descriptors."""

import array
import ctypes
import errno
import json
import os
from pathlib import Path
import shlex
import socket
import subprocess
import sys
import tempfile
import threading
import unittest

from test_native import NativeLease

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))
from hugekeeper import BrokerError, Lease


class ReleaseFailureTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.build = tempfile.TemporaryDirectory(prefix="hk-review-build-")
        cls.addClassCleanup(cls.build.cleanup)
        library = Path(cls.build.name) / "libhugekeeper.so"
        subprocess.run(shlex.split(os.environ.get("CC", "cc")) + [
            "-std=c11", "-Wall", "-Wextra", "-Wpedantic", "-Werror", "-O2",
            "-fPIC", "-shared", "-I" + str(ROOT / "include"),
            str(ROOT / "src/client.c"), "-o", str(library),
        ], check=True, capture_output=True, text=True)
        cls.native = ctypes.CDLL(str(library), use_errno=True)
        cls.native.hk_acquire.argtypes = [ctypes.c_char_p, ctypes.POINTER(NativeLease)]
        cls.native.hk_acquire.restype = ctypes.c_int
        cls.native.hk_release.argtypes = [ctypes.POINTER(NativeLease)]
        cls.native.hk_release.restype = ctypes.c_int

    def exchange(self, packet, fd_count, client):
        with tempfile.TemporaryDirectory(prefix="hk-review-") as directory:
            path = directory + "/socket"
            with socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET) as server:
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
                            fd = os.memfd_create("review-release", os.MFD_CLOEXEC)
                            try:
                                os.ftruncate(fd, 4096)
                                connection.sendmsg([json.dumps({
                                    "ok": True, "lease": 9, "size": 4096,
                                    "backend": "plain",
                                }).encode()], [(socket.SOL_SOCKET, socket.SCM_RIGHTS,
                                               array.array("i", [fd]))])
                                self.assertEqual(connection.recv(255), b"RELEASE 9")
                                if packet is not None:
                                    controls = [(socket.SOL_SOCKET, socket.SCM_RIGHTS,
                                                 array.array("i", [fd] * fd_count))] if fd_count else []
                                    connection.sendmsg([packet], controls)
                            finally:
                                os.close(fd)
                    except BaseException as exc:
                        failures.append(exc)

                baseline = len(os.listdir("/proc/self/fd"))
                thread = threading.Thread(target=broker, daemon=True)
                thread.start()
                try:
                    client(path)
                finally:
                    thread.join(4)
                self.assertFalse(thread.is_alive(), "fake broker did not terminate")
                self.assertEqual(failures, [])
                self.assertEqual(len(os.listdir("/proc/self/fd")), baseline)

    def test_native_release_failure_unmaps_and_closes_every_descriptor(self):
        cases = [
            (None, 0, errno.EPROTO),
            (b"{invalid}", 0, errno.EPROTO),
            (b"x" * 5000, 0, errno.EPROTO),
            (b'{"ok":true}', 1, errno.EPROTO),
            (b'{"ok":true}', 40, errno.EPROTO),
            (b'{"ok":false,"error":"allocation","message":"failed"}', 0, errno.ENOMEM),
        ]
        for packet, count, expected in cases:
            with self.subTest(packet=packet and packet[:80], descriptors=count):
                def client(path):
                    lease = NativeLease()
                    self.assertEqual(self.native.hk_acquire(os.fsencode(path), ctypes.byref(lease)), 0)
                    address = lease.data
                    try:
                        self.assertEqual(self.native.hk_release(ctypes.byref(lease)), -1)
                        self.assertEqual(ctypes.get_errno(), expected)
                        self.assertIsNone(lease.data)
                        self.assertEqual((lease.size, lease.id, lease.fd, lease.socket_fd), (0, 0, -1, -1))
                        self.assertEqual(self.native.hk_release(ctypes.byref(lease)), 0)
                        # Inspect only this memfd: Python may reuse the unmapped
                        # address for an unrelated allocation before this read.
                        for line in Path("/proc/self/maps").read_text().splitlines():
                            if "/memfd:review-release " not in line:
                                continue
                            start, end = [int(value, 16) for value in line.split()[0].split("-")]
                            self.assertFalse(start <= address < end, "released mapping is still mapped")
                    finally:
                        if lease.socket_fd >= 0:
                            self.native.hk_release(ctypes.byref(lease))
                self.exchange(packet, count, client)

    def test_python_release_failure_still_closes_mapping_and_connection(self):
        for packet, count in [(None, 0), (b"{invalid}", 0), (b'{"ok":true}', 40)]:
            with self.subTest(packet=packet, descriptors=count):
                def client(path):
                    lease = Lease(path)
                    with self.assertRaises(BrokerError) as caught:
                        lease.close()
                    self.assertEqual(caught.exception.code, "protocol")
                    self.assertTrue(lease.closed)
                    self.assertTrue(lease.mapping.closed)
                    self.assertIsNone(lease._socket)
                    self.assertIsNone(lease._fd)
                    lease.close()
                self.exchange(packet, count, client)


if __name__ == "__main__":
    unittest.main()
