"""Python SDK integration checks against the real daemon."""
import gc
import json
import os
import subprocess
import sys
import weakref

from test_protocol import BACKEND, DaemonTest, ROOT

sys.path.insert(0, str(ROOT / "python"))
from hugekeeper import BrokerError, Lease, acquire, admin_request


class SdkTests(DaemonTest):
    def test_denied_then_context_manager_roundtrip(self):
        with self.assertRaises(BrokerError) as caught:
            Lease(self.path)
        self.assertEqual(caught.exception.code, "denied")
        self.allow()
        with acquire(self.path) as lease:
            self.assertFalse(lease.closed)
            self.assertEqual(lease.backend, BACKEND)
            self.assertEqual(lease.size, 2 * 1024 * 1024)
            lease.mapping[:8] = b"sqltable"
            self.assertEqual(lease.mapping[:8], b"sqltable")
            self.assertFalse(os.get_inheritable(lease._fd))
            self.assertEqual(admin_request(self.path, "STATUS")["leased"], 1)
        self.assertTrue(lease.closed)
        lease.close()
        self.await_status(leased=0, ready=2)

    def test_exported_buffer_prevents_unsafe_close_and_pins_owner(self):
        self.allow()
        lease = Lease(self.path)
        view = memoryview(lease.mapping)
        view[:4] = b"live"
        owner = weakref.ref(lease)
        fd = lease._fd
        with self.assertRaises(BufferError):
            lease.close()
        self.assertFalse(lease.closed)
        self.assertEqual(os.fstat(fd).st_size, lease.size)
        del lease
        gc.collect()
        self.assertIsNotNone(owner())
        self.assertEqual(view[:4].tobytes(), b"live")
        self.assertEqual(admin_request(self.path, "STATUS")["leased"], 1)
        lease = owner()
        view.release()
        lease.close()
        self.assertTrue(lease.closed)
        self.await_status(leased=0, ready=2)

    def test_revoked_lease_can_be_closed_without_reading_stale_mapping(self):
        self.allow()
        lease = Lease(self.path)
        admin_request(self.path, f"REVOKE {lease.lease_id}")
        lease.close()
        self.assertTrue(lease.closed)
        self.await_status(leased=0)

    def test_context_manager_releases_on_body_exception(self):
        self.allow()
        with self.assertRaisesRegex(RuntimeError, "body error"):
            with Lease(self.path):
                raise RuntimeError("body error")
        self.await_status(leased=0, ready=2)

    def test_unreachable_unclosed_lease_closes_received_descriptor(self):
        self.allow()
        lease = Lease(self.path)
        owner = weakref.ref(lease)
        fd = lease._fd
        del lease
        gc.collect()
        self.assertIsNone(owner())
        with self.assertRaises(OSError):
            os.fstat(fd)
        self.await_status(leased=0, ready=2)

    def test_gc_keeps_exported_buffer_live_then_reclaims_dropped_lease(self):
        self.allow()
        lease = Lease(self.path)
        view = memoryview(lease.mapping)
        view[:4] = b"live"
        owner = weakref.ref(lease)
        fd = lease._fd
        del lease
        gc.collect()
        self.assertIsNotNone(owner())
        self.assertEqual(view[:4].tobytes(), b"live")
        view.release()
        gc.collect()
        self.assertIsNone(owner())
        with self.assertRaises(OSError):
            os.fstat(fd)
        self.await_status(leased=0, ready=2)

    def test_cli_status_and_demo(self):
        env = dict(os.environ, PYTHONPATH=str(ROOT / "python"))
        result = subprocess.run([sys.executable, "-m", "hugekeeper", "--socket", str(self.path), "status"],
                                env=env, capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('"capacity"', result.stdout)
        self.allow()
        result = subprocess.run([sys.executable, "-m", "hugekeeper", "--socket", str(self.path), "demo"],
                                env=env, capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.await_status(leased=0, ready=2)

    def test_native_static_table_load_lookup_scan_and_release(self):
        executable = ROOT / "build/table-demo"
        if not executable.exists():
            self.skipTest("build/table-demo unavailable; run make all to include the C example")
        self.allow()
        result = subprocess.run([str(executable), str(self.path), "2"],
                                capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)
        summary = json.loads(result.stdout)
        self.assertEqual(summary["backend"], BACKEND)
        self.assertEqual(summary["rows"], 2 * 1024 * 1024 // 16)
        self.assertEqual(summary["scan_rounds"], 2)
        rows = summary["rows"]
        self.assertEqual(summary["checksum"], rows * (rows - 1) // 2 * 10 * 2)
        self.await_status(leased=0, ready=2)


if __name__ == "__main__":
    import unittest
    unittest.main()
