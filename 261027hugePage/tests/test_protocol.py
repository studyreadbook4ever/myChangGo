"""Black-box protocol and memory-lifetime checks; no SDK dependencies.

Run: python3 -m unittest discover -s tests -v
HUGEKEEPER_BIN and HUGEKEEPER_TEST_BACKEND can select another daemon/backend.
"""
from __future__ import annotations

import array
import concurrent.futures
import errno
import fcntl
import json
import mmap
import os
from pathlib import Path
import resource
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
DAEMON = Path(os.environ.get("HUGEKEEPER_BIN", ROOT / "build/hugekeeperd"))
BACKEND = os.environ.get("HUGEKEEPER_TEST_BACKEND", "plain")
MIB = 1024 * 1024


def connect(path):
    s = socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET)
    try:
        s.settimeout(3)
        s.connect(str(path))
    except BaseException:
        s.close()
        raise
    return s


def receive(s):
    payload, ancillary, flags, _ = s.recvmsg(4096, socket.CMSG_SPACE(256 * 4))
    descriptors = []
    for level, kind, data in ancillary:
        if level == socket.SOL_SOCKET and kind == socket.SCM_RIGHTS:
            values = array.array("i")
            values.frombytes(data[:len(data) - len(data) % values.itemsize])
            descriptors.extend(values)
    try:
        if flags & (socket.MSG_TRUNC | socket.MSG_CTRUNC):
            raise AssertionError("daemon reply was truncated")
        return json.loads(payload), descriptors
    except BaseException:
        for fd in descriptors:
            os.close(fd)
        raise


def request(s, command):
    s.send(command.encode() if isinstance(command, str) else command)
    return receive(s)


class DaemonTest(unittest.TestCase):
    def setUp(self):
        if not DAEMON.exists():
            self.fail(f"build the daemon first: {DAEMON}")
        self.tmp = tempfile.TemporaryDirectory(prefix="hugekeeper-test-")
        self.path = Path(self.tmp.name) / "pool.sock"
        self.log = tempfile.TemporaryFile(mode="w+b")
        self.process = subprocess.Popen(
            [str(DAEMON), "--socket", str(self.path), "--backend", BACKEND,
             "--pages", "2", "--slots", "2", "--max-mib", "8"],
            stdout=self.log, stderr=self.log,
            preexec_fn=lambda: resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64)),
        )
        self.sockets = []
        self.descriptors = []
        self.maps = []
        self.expected_returncode = 0
        deadline = time.monotonic() + 10
        while not self.path.with_name(self.path.name + ".admin").exists():
            if self.process.poll() is not None or time.monotonic() > deadline:
                self.log.seek(0)
                output = self.log.read().decode(errors="replace")
                self.tearDown()
                self.fail(f"daemon did not start: {output}")
            time.sleep(0.01)

    def tearDown(self):
        for m in getattr(self, "maps", []):
            if not m.closed:
                m.close()
        for fd in getattr(self, "descriptors", []):
            try:
                os.close(fd)
            except OSError:
                pass
        for s in getattr(self, "sockets", []):
            s.close()
        if getattr(self, "process", None) and self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(5)
        if getattr(self, "log", None):
            self.log.seek(0)
            daemon_log = self.log.read().decode(errors="replace")
            self.log.close()
        else:
            daemon_log = ""
        if getattr(self, "tmp", None):
            self.tmp.cleanup()
        for failure in ("ERROR: AddressSanitizer", "ERROR: LeakSanitizer", "runtime error:"):
            self.assertNotIn(failure, daemon_log, daemon_log)
        if getattr(self, "process", None):
            self.assertEqual(self.process.returncode, self.expected_returncode, daemon_log)

    def client(self, admin=False):
        s = connect(str(self.path) + (".admin" if admin else ""))
        self.sockets.append(s)
        return s

    def admin(self, command):
        with connect(str(self.path) + ".admin") as s:
            reply, fds = request(s, command)
            for fd in fds:
                os.close(fd)
            self.assertFalse(fds, "admin response must never contain a descriptor")
            return reply

    def allow(self):
        self.assertTrue(self.admin(f"ALLOW {os.getuid()}")["ok"])

    def acquire(self, s=None):
        s = s or self.client()
        reply, fds = request(s, "ACQUIRE")
        self.descriptors.extend(fds)
        self.assertTrue(reply["ok"], reply)
        self.assertEqual(len(fds), 1)
        self.assertEqual(reply["size"], 2 * MIB)
        self.assertEqual(reply["backend"], BACKEND)
        return s, reply, fds[0]

    def mapping(self, fd):
        m = mmap.mmap(fd, 2 * MIB, flags=mmap.MAP_SHARED,
                      prot=mmap.PROT_READ | mmap.PROT_WRITE)
        self.maps.append(m)
        return m

    def await_status(self, **expected):
        deadline = time.monotonic() + 3
        while True:
            result = self.admin("STATUS")
            if all(result.get(key) == value for key, value in expected.items()):
                return result
            if time.monotonic() >= deadline:
                self.fail(f"status never reached {expected}: {result}")
            time.sleep(0.01)


class ProtocolTests(DaemonTest):
    def test_explicit_authorization_and_socket_permissions(self):
        self.assertEqual(stat.S_IMODE(self.path.stat().st_mode), 0o666)
        self.assertEqual(stat.S_IMODE(Path(str(self.path) + ".admin").stat().st_mode), 0o600)
        status = self.admin("STATUS")
        self.assertEqual(status["allowed_uids"], [])
        self.assertEqual((status["capacity"], status["ready"], status["leased"]), (2, 2, 0))
        s = self.client()
        reply, fds = request(s, "ACQUIRE")
        self.assertEqual(reply.get("error"), "denied")
        self.assertEqual(fds, [])
        self.assertEqual(request(s, "PING"), ({"ok": True}, []))
        self.allow()
        _, lease, _ = self.acquire(s)
        self.assertEqual(self.admin("STATUS")["leases"][0]["uid"], os.getuid())
        self.assertTrue(request(s, f"RELEASE {lease['lease']}")[0]["ok"])

    def test_data_and_admin_command_separation(self):
        self.allow()
        for command in ("ALLOW 0", "DENY 0", "STATUS", "RESIZE 0", "REFILL"):
            with self.subTest(command=command):
                reply, fds = request(self.client(), command)
                self.assertFalse(reply["ok"])
                self.assertEqual(fds, [])
        self.assertFalse(self.admin("ACQUIRE")["ok"])

    def test_lease_ownership_and_pool_exhaustion(self):
        self.allow()
        s1, first, _ = self.acquire()
        s2, second, _ = self.acquire()
        self.assertNotEqual(first["lease"], second["lease"])
        reply, fds = request(s1, "ACQUIRE")
        self.assertEqual(reply.get("error"), "busy")
        self.assertEqual(fds, [])
        reply, fds = request(self.client(), "ACQUIRE")
        self.assertEqual(reply.get("error"), "empty")
        self.assertEqual(fds, [])
        self.assertFalse(request(s2, f"RELEASE {first['lease']}")[0]["ok"])
        self.assertEqual(self.admin("STATUS")["leased"], 2)

    def test_release_zeroes_replacement_and_prevents_fd_regrowth(self):
        self.allow()
        s, lease, fd = self.acquire()
        old_inode = os.fstat(fd).st_ino
        m = self.mapping(fd)
        m[:] = b"\xa5" * len(m)
        m.close()
        self.assertTrue(request(s, f"RELEASE {lease['lease']}")[0]["ok"])
        self.assertEqual(os.fstat(fd).st_size, 0)
        seals = fcntl.fcntl(fd, fcntl.F_GET_SEALS)
        self.assertTrue(seals & fcntl.F_SEAL_GROW)
        self.assertTrue(seals & fcntl.F_SEAL_SEAL)
        with self.assertRaises(OSError):
            os.ftruncate(fd, 2 * MIB)
        # Consume both slots, so one must be the old slot's fresh inode.
        _, _, newfd1 = self.acquire(s)
        _, _, newfd2 = self.acquire()
        for newfd in (newfd1, newfd2):
            self.assertNotEqual(os.fstat(newfd).st_ino, old_inode)
            self.assertEqual(self.mapping(newfd)[:], bytes(2 * MIB))

    def test_client_cannot_grow_active_lease_or_block_revocation_with_seals(self):
        self.allow()
        _, lease, fd = self.acquire()
        with self.assertRaises(OSError):
            os.ftruncate(fd, 4 * MIB)
        with self.assertRaises(OSError):
            fcntl.fcntl(fd, fcntl.F_ADD_SEALS, fcntl.F_SEAL_SHRINK)
        self.assertTrue(self.admin(f"REVOKE {lease['lease']}")["ok"])
        self.assertEqual(os.fstat(fd).st_size, 0)

    def test_disconnect_releases_and_zeroes(self):
        self.allow()
        s, _, fd = self.acquire()
        m = self.mapping(fd)
        m[:4096] = b"s" * 4096
        m.close()
        s.close()
        self.await_status(leased=0, ready=2)
        self.assertEqual(os.fstat(fd).st_size, 0)
        for _ in range(2):
            _, _, fresh = self.acquire()
            self.assertEqual(self.mapping(fresh)[:4096], bytes(4096))

    def test_deny_revokes_all_leases_and_allow_restores(self):
        self.allow()
        s1, old, fd1 = self.acquire()
        _, _, fd2 = self.acquire()
        self.assertTrue(self.admin(f"DENY {os.getuid()}")["ok"])
        self.await_status(leased=0, ready=2)
        self.assertEqual(os.fstat(fd1).st_size, 0)
        self.assertEqual(os.fstat(fd2).st_size, 0)
        self.assertEqual(request(s1, "ACQUIRE")[0].get("error"), "denied")
        self.assertEqual(request(s1, f"RELEASE {old['lease']}")[0].get("error"), "not_found")
        self.allow()
        self.acquire(s1)

    def test_revocation_invalidates_a_live_mapping_with_sigbus(self):
        self.allow()
        s, lease, fd = self.acquire()
        code = """
import mmap, os, resource, sys
resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
m = mmap.mmap(int(sys.argv[1]), 2 * 1024 * 1024)
m[0] = 19
print('mapped', flush=True)
sys.stdin.readline()
print(m[0], flush=True)
"""
        child = subprocess.Popen([sys.executable, "-c", code, str(fd)],
                                 pass_fds=(fd,), stdin=subprocess.PIPE,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 text=True)
        try:
            self.assertEqual(child.stdout.readline().strip(), "mapped")
            self.assertTrue(self.admin(f"REVOKE {lease['lease']}")["ok"])
            stdout, stderr = child.communicate("go\n", timeout=5)
            self.assertEqual(child.returncode, -signal.SIGBUS, (stdout, stderr))
            self.assertEqual(os.fstat(fd).st_size, 0)
            self.acquire(s)
        finally:
            if child.poll() is None:
                child.kill()
                child.communicate()

    def test_free_returns_entire_pool_and_invalidates_active_mappings(self):
        self.allow()
        s, lease, fd = self.acquire()
        _, _, second_fd = self.acquire()
        code = """
import mmap, resource, sys
resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
m = mmap.mmap(int(sys.argv[1]), 2 * 1024 * 1024)
m[0] = 7
print('mapped', flush=True)
sys.stdin.readline()
print(m[0], flush=True)
"""
        child = subprocess.Popen([sys.executable, "-c", code, str(fd)],
                                 pass_fds=(fd,), stdin=subprocess.PIPE,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            self.assertEqual(child.stdout.readline().strip(), "mapped")
            self.assertTrue(self.admin("FREE")["ok"])
            stdout, stderr = child.communicate("go\n", timeout=5)
            self.assertEqual(child.returncode, -signal.SIGBUS, (stdout, stderr))
            status = self.admin("STATUS")
            for field in ("capacity", "ready", "leased", "degraded", "pool_bytes",
                          "resident_bytes", "hugetlb_bytes", "thp_mapped_bytes",
                          "total_pages", "ready_pages", "leased_pages"):
                self.assertEqual(status[field], 0, (field, status))
            for oldfd in (fd, second_fd):
                self.assertEqual(os.fstat(oldfd).st_size, 0)
                with self.assertRaises(OSError):
                    os.ftruncate(oldfd, 2 * MIB)
            self.assertEqual(request(s, f"RELEASE {lease['lease']}")[0].get("error"), "not_found")
            self.assertEqual(request(s, "ACQUIRE")[0].get("error"), "empty")
            self.assertTrue(self.admin("RESIZE 2")["ok"])
            self.acquire(s)
        finally:
            if child.poll() is None:
                child.kill()
                child.communicate()

    def test_resize_busy_and_allocation_rollback(self):
        self.allow()
        s1, first, _ = self.acquire()
        s2, second, _ = self.acquire()
        self.assertEqual(self.admin("RESIZE 1").get("error"), "busy")
        self.assertEqual(self.admin("STATUS")["capacity"], 2)
        result = self.admin("RESIZE 5")  # max_mib=8, each slot=2 MiB
        self.assertFalse(result["ok"])
        status = self.admin("STATUS")
        self.assertEqual((status["capacity"], status["leased"]), (2, 2))
        self.assertTrue(self.admin("RESIZE 4")["ok"])
        self.assertEqual(self.admin("STATUS")["pool_bytes"], 8 * MIB)
        request(s1, f"RELEASE {first['lease']}")
        request(s2, f"RELEASE {second['lease']}")
        self.assertTrue(self.admin("RESIZE 0")["ok"])
        self.assertEqual(self.admin("STATUS")["capacity"], 0)
        self.assertEqual(request(s1, "ACQUIRE")[0].get("error"), "empty")
        self.assertTrue(self.admin("RESIZE 1")["ok"])
        self.assertTrue(self.admin("REFILL")["ok"])
        self.acquire(s1)

    def test_malformed_packets_and_truncation_do_not_mutate(self):
        self.allow()
        commands = [b"UNKNOWN", b"ACQUIRE extra", b"PING\x00ACQUIRE",
                    b"\xff\xfe", b"RELEASE -1", b"RELEASE 1 trailing",
                    b"ACQUIRE\nPING", b"A" * 256, b"A" * 65536]
        for command in commands:
            with self.subTest(command=command[:60]):
                reply, fds = request(self.client(), command)
                self.assertFalse(reply["ok"], reply)
                self.assertEqual(fds, [])
        for command in ("ALLOW -1", "ALLOW 4294967296", "DENY x",
                        "RESIZE -1", "RESIZE 18446744073709551616",
                        "REVOKE 0", "REFILL extra", "STATUS extra"):
            with self.subTest(command=command):
                self.assertFalse(self.admin(command)["ok"])
        self.assertEqual(self.admin("STATUS")["leased"], 0)

    def test_ancillary_fd_rejection_and_no_descriptor_leak(self):
        self.allow()
        s = self.client()
        request(s, "PING")
        try:
            baseline = len(os.listdir(f"/proc/{self.process.pid}/fd"))
        except PermissionError:
            baseline = None  # PR_SET_DUMPABLE=0; the 64-FD limit still catches leaks.
        fd = os.open("/dev/null", os.O_RDONLY)
        try:
            # The large vector also exercises truncated control-message cleanup.
            for count in [1, 80] * 160:
                fds = array.array("i", [fd] * count)
                s.sendmsg([b"ACQUIRE"], [(socket.SOL_SOCKET, socket.SCM_RIGHTS, fds)])
                reply, received = receive(s)
                for got in received:
                    os.close(got)
                self.assertFalse(reply["ok"])
                self.assertEqual(received, [])
            self.assertEqual(request(s, "PING"), ({"ok": True}, []))
            if baseline is not None:
                after = len(os.listdir(f"/proc/{self.process.pid}/fd"))
                self.assertEqual(after, baseline)
            self.assertEqual(self.admin("STATUS")["leased"], 0)
            self.acquire(s)
        finally:
            os.close(fd)

    def test_nonreading_client_cannot_stall_other_clients(self):
        s = self.client()
        s.setblocking(False)
        for _ in range(10000):
            try:
                s.send(b"PING")
            except (BlockingIOError, BrokenPipeError, ConnectionResetError):
                break
        started = time.monotonic()
        self.assertTrue(self.admin("STATUS")["ok"])
        self.assertLess(time.monotonic() - started, 2)

    def test_data_connection_pressure_preserves_admin_and_idle_cpu(self):
        # The fixture gives the daemon only 64 FDs. Admission must reserve
        # descriptor headroom, not merely entries in a client array.
        deadline = time.monotonic() + 3
        for _ in range(80):
            while True:
                try:
                    self.client()
                    break
                except BlockingIOError as exc:
                    # Python timeout mode uses a nonblocking socket. A burst
                    # can fill the Unix listen backlog before the daemon runs;
                    # EAGAIN says to retry, not that its FD budget has failed.
                    if exc.errno not in (errno.EAGAIN, errno.EWOULDBLOCK):
                        raise
                    self.assertIsNone(self.process.poll(), "daemon exited under connection pressure")
                    if time.monotonic() >= deadline:
                        self.fail("daemon did not drain its listen backlog within 3 seconds")
                    time.sleep(.001)
        self.assertEqual(len(self.sockets), 80)
        started = time.monotonic()
        self.assertTrue(self.admin("STATUS")["ok"])
        self.assertLess(time.monotonic() - started, 2)
        time.sleep(.05)

        def ticks():
            values = Path(f"/proc/{self.process.pid}/stat").read_text().rsplit(")", 1)[1].split()
            return int(values[11]) + int(values[12])

        before = ticks()
        time.sleep(.2)
        self.assertLessEqual(ticks() - before, 5,
                             "idle connection pressure must not spin on accept4(EMFILE)")

    def test_concurrent_exclusive_slots_and_zeroing(self):
        self.allow()
        self.assertTrue(self.admin("RESIZE 4")["ok"])
        barrier = threading.Barrier(8)

        def worker(index):
            with connect(self.path) as s:
                barrier.wait(timeout=3)
                for turn in range(20):
                    deadline = time.monotonic() + 5
                    while True:
                        reply, fds = request(s, "ACQUIRE")
                        if reply["ok"]:
                            break
                        if reply.get("error") != "empty" or time.monotonic() > deadline:
                            raise AssertionError(reply)
                        time.sleep(0.001)
                    self.assertEqual(len(fds), 1)
                    try:
                        with mmap.mmap(fds[0], reply["size"]) as m:
                            self.assertEqual(m[:4096], bytes(4096))
                            pattern = bytes([index + 1]) * 4096
                            m[:4096] = pattern
                            time.sleep(0.0001)
                            self.assertEqual(m[:4096], pattern)
                    finally:
                        os.close(fds[0])
                    self.assertTrue(request(s, f"RELEASE {reply['lease']}")[0]["ok"])
            return 20

        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor:
            self.assertEqual(sum(executor.map(worker, range(8))), 160)
        self.await_status(leased=0, ready=4, degraded=0)

    def test_normal_shutdown_invalidates_and_removes_sockets(self):
        self.allow()
        _, _, fd = self.acquire()
        self.process.terminate()
        self.assertEqual(self.process.wait(5), 0)
        self.assertEqual(os.fstat(fd).st_size, 0)
        with self.assertRaises(OSError):
            os.ftruncate(fd, 2 * MIB)
        self.assertFalse(self.path.exists())
        self.assertFalse(Path(str(self.path) + ".admin").exists())

    def test_abrupt_daemon_death_does_not_claim_revocation(self):
        self.allow()
        _, _, fd = self.acquire()
        m = self.mapping(fd)
        m[:4] = b"live"
        self.expected_returncode = -signal.SIGKILL
        self.process.kill()
        self.assertEqual(self.process.wait(5), -signal.SIGKILL)
        self.assertEqual(os.fstat(fd).st_size, 2 * MIB)
        self.assertEqual(m[:4], b"live")


class StartupTests(unittest.TestCase):
    def test_resize_allocation_failure_rolls_back_partially_built_pool(self):
        if b"__asan_init" in DAEMON.read_bytes():
            self.skipTest("ASan reserves a large address space; RLIMIT_AS fault injection is incompatible")
        with tempfile.TemporaryDirectory(prefix="hugekeeper-rollback-") as directory:
            path = Path(directory) / "pool.sock"
            with tempfile.TemporaryFile() as log:
                process = subprocess.Popen(
                    [str(DAEMON), "--socket", str(path), "--backend", "plain",
                     "--slots", "1", "--slot-mib", "2", "--max-mib", "64"],
                    stdout=log, stderr=log,
                    preexec_fn=lambda: resource.setrlimit(resource.RLIMIT_AS, (20 * MIB, 20 * MIB)))
                try:
                    deadline = time.monotonic() + 5
                    while not Path(str(path) + ".admin").exists():
                        if process.poll() is not None or time.monotonic() >= deadline:
                            log.seek(0)
                            self.fail(log.read().decode(errors="replace"))
                        time.sleep(.01)
                    with connect(str(path) + ".admin") as s:
                        before, _ = request(s, "STATUS")
                        reply, fds = request(s, "RESIZE 12")
                        self.assertEqual(reply.get("error"), "allocation", reply)
                        self.assertEqual(fds, [])
                        after, _ = request(s, "STATUS")
                        for field in ("capacity", "ready", "leased", "degraded", "pool_bytes"):
                            self.assertEqual(after[field], before[field], (field, before, after))
                        self.assertTrue(request(s, "RESIZE 2")[0]["ok"])
                finally:
                    if process.poll() is None:
                        process.terminate()
                        process.wait(5)

    def test_strict_hugetlb_does_not_silently_fallback(self):
        meminfo = Path("/proc/meminfo").read_text()
        free_line = next(line for line in meminfo.splitlines() if line.startswith("HugePages_Free:"))
        if int(free_line.split()[1]) != 0:
            self.skipTest("host has reserved huge pages; unavailable-path test is inapplicable")
        with tempfile.TemporaryDirectory(prefix="hugekeeper-strict-") as directory:
            path = Path(directory) / "pool.sock"
            result = subprocess.run([str(DAEMON), "--socket", str(path), "--backend", "hugetlb",
                                     "--pages", "1", "--max-mib", "2"],
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=5)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(path.exists())
            self.assertFalse(Path(str(path) + ".admin").exists())

    def test_rejects_unsafe_socket_parent(self):
        with tempfile.TemporaryDirectory(prefix="hugekeeper-unsafe-") as directory:
            os.chmod(directory, 0o777)
            result = subprocess.run([str(DAEMON), "--socket", str(Path(directory) / "pool.sock"),
                                     "--backend", "plain", "--slots", "1", "--slot-mib", "2"],
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=5)
            self.assertNotEqual(result.returncode, 0)


if __name__ == "__main__":
    unittest.main()
