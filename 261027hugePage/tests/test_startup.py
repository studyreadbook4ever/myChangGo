"""Startup sizing and real-terminal confirmation, bounded to at most 8 MiB."""
from __future__ import annotations

import errno
import json
import os
from pathlib import Path
import pty
import resource
import select
import socket
import subprocess
import tempfile
import time
import unittest

from test_protocol import BACKEND, DAEMON, MIB


class StartupTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(DAEMON.is_file(), f"build the daemon first: {DAEMON}")
        self.directory = tempfile.TemporaryDirectory(prefix="hk-startup-")
        self.path = Path(self.directory.name) / "pool.sock"
        self.children = []

    def tearDown(self):
        for child in self.children:
            self.stop(child)
            self.read_available(child)
            if child["master"] is not None:
                os.close(child["master"])
                child["master"] = None
            if child["log"] is not None:
                child["log"].seek(0)
                child["output"].extend(child["log"].read())
                child["log"].close()
            output = child["output"].decode(errors="replace")
            for marker in ("ERROR: AddressSanitizer", "ERROR: LeakSanitizer", "runtime error:"):
                self.assertNotIn(marker, output, output)
        self.directory.cleanup()

    def arguments(self, *extra):
        return [str(DAEMON), "--socket", str(self.path), "--backend", BACKEND, *extra]

    def start(self, *extra, terminal=False):
        child = {"master": None, "log": None, "output": bytearray()}
        if terminal:
            master, slave = pty.openpty()
            child["master"] = master
            try:
                process = subprocess.Popen(self.arguments(*extra), stdin=slave, stdout=slave, stderr=slave)
            finally:
                os.close(slave)
        else:
            child["log"] = tempfile.TemporaryFile(mode="w+b")
            process = subprocess.Popen(self.arguments(*extra), stdin=subprocess.DEVNULL,
                                       stdout=child["log"], stderr=child["log"])
        child["process"] = process
        self.children.append(child)
        return child

    @staticmethod
    def stop(child):
        process = child["process"]
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(5)

    @staticmethod
    def read_available(child, timeout=0):
        master = child["master"]
        if master is None:
            log = child["log"]
            child["output"][:] = os.pread(log.fileno(), 1024 * 1024, 0)
            return
        while select.select([master], [], [], timeout)[0]:
            try:
                data = os.read(master, 65536)
            except OSError as error:
                if error.errno == errno.EIO:
                    break
                raise
            if not data:
                break
            child["output"].extend(data)
            timeout = 0

    def await_output(self, child, token):
        deadline = time.monotonic() + 5
        while token not in child["output"]:
            self.read_available(child, 0.05)
            if token in child["output"]:
                break
            if child["process"].poll() is not None or time.monotonic() >= deadline:
                self.fail(f"missing {token!r}: {child['output'].decode(errors='replace')}")
            if child["master"] is None:
                time.sleep(0.01)

    def status(self, child):
        self.await_output(child, b"READY ")
        with socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET) as connection:
            connection.settimeout(3)
            connection.connect(str(self.path) + ".admin")
            connection.send(b"STATUS")
            result = json.loads(connection.recv(4096))
        self.assertTrue(result["ok"], result)
        return result

    def assert_prompt(self, child):
        self.await_output(child, b"[y/N]")
        self.assertIn(b"--pages", child["output"])
        self.assertNotIn(b"READY ", child["output"])
        self.assertIsNone(child["process"].poll())
        self.assertFalse(self.path.exists(), "confirmation must happen before socket creation/allocation")
        self.assertFalse(Path(str(self.path) + ".admin").exists())

    def test_missing_page_count_defaults_to_no_on_empty_answer(self):
        child = self.start("--max-mib", "4", terminal=True)
        self.assert_prompt(child)
        os.write(child["master"], b"\n")
        child["process"].wait(5)
        self.read_available(child)
        self.assertNotIn(b"READY ", child["output"])
        self.assertFalse(self.path.exists())

    def test_missing_page_count_rejects_explicit_no_and_unknown_answer(self):
        for answer in (b"n\n", b"no\n", b"maybe\n"):
            with self.subTest(answer=answer):
                child = self.start("--max-mib", "4", terminal=True)
                self.assert_prompt(child)
                os.write(child["master"], answer)
                child["process"].wait(5)
                self.read_available(child)
                self.assertNotIn(b"READY ", child["output"])
                self.assertFalse(self.path.exists())

    def test_terminal_y_and_yes_allocate_only_the_configured_maximum(self):
        for answer in (b"y\n", b"yes\n"):
            with self.subTest(answer=answer):
                child = self.start("--max-mib", "4", terminal=True)
                self.assert_prompt(child)
                os.write(child["master"], answer)
                status = self.status(child)
                self.assertEqual(status["pool_bytes"], 4 * MIB, status)
                self.assertEqual(status["slot_bytes"] * status["capacity"], 4 * MIB, status)
                self.assertEqual(status["ready"], status["capacity"], status)
                self.assertEqual(status["degraded"], 0, status)
                self.stop(child)
                self.assertEqual(child["process"].returncode, 0)

    def test_piped_yes_cannot_authorize_an_unspecified_allocation(self):
        for answer in ("", "yes\n"):
            with self.subTest(answer=answer):
                result = subprocess.run(self.arguments("--max-mib", "4"), input=answer,
                                        text=True, capture_output=True, timeout=5)
                output = result.stdout + result.stderr
                self.assertNotEqual(result.returncode, 0, output)
                self.assertIn("--pages", output)
                self.assertNotIn("READY ", output)
                self.assertFalse(self.path.exists())
                self.assertFalse(Path(str(self.path) + ".admin").exists())

    def test_two_pages_create_one_four_mib_slot_without_confirmation(self):
        child = self.start("--pages", "2", "--max-mib", "4")
        status = self.status(child)
        self.assertEqual((status["capacity"], status["ready"]), (1, 1), status)
        self.assertEqual(status["slot_bytes"], 4 * MIB, status)
        self.assertEqual(status["pool_bytes"], 4 * MIB, status)
        self.assertNotIn(b"[y/N]", child["output"])

    def test_four_pages_split_into_two_four_mib_slots(self):
        child = self.start("--pages", "4", "--slots", "2", "--max-mib", "8")
        status = self.status(child)
        self.assertEqual((status["capacity"], status["ready"]), (2, 2), status)
        self.assertEqual(status["slot_bytes"], 4 * MIB, status)
        self.assertEqual(status["pool_bytes"], 8 * MIB, status)
        self.assertNotIn(b"[y/N]", child["output"])

    def test_invalid_or_indivisible_page_counts_fail_before_startup(self):
        cases = [
            ("--pages", "0"),
            ("--pages", "-1"),
            ("--pages", "1.5"),
            ("--pages", "two"),
            ("--pages", "18446744073709551616"),
            ("--pages", "3", "--slots", "2"),
            ("--pages", "2", "--slots", "0"),
            ("--pages", "1", "--slots", "2"),
        ]
        for arguments in cases:
            with self.subTest(arguments=arguments):
                result = subprocess.run(self.arguments(*arguments, "--max-mib", "8"),
                                        stdin=subprocess.DEVNULL, capture_output=True, timeout=5)
                self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertNotIn(b"READY ", result.stdout + result.stderr)
                self.assertFalse(self.path.exists())

    def test_explicit_legacy_slot_sizing_remains_noninteractive(self):
        child = self.start("--slots", "2", "--slot-mib", "2", "--max-mib", "4")
        status = self.status(child)
        self.assertEqual((status["capacity"], status["slot_bytes"]), (2, 2 * MIB), status)
        self.assertNotIn(b"[y/N]", child["output"])

    def test_too_few_file_descriptors_rejects_startup_and_cleans_sockets(self):
        result = subprocess.run(
            self.arguments("--pages", "2", "--max-mib", "4"),
            stdin=subprocess.DEVNULL, capture_output=True, timeout=5,
            preexec_fn=lambda: resource.setrlimit(resource.RLIMIT_NOFILE, (32, 32)),
        )
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertNotIn(b"READY ", result.stdout + result.stderr)
        self.assertFalse(self.path.exists())
        self.assertFalse(Path(str(self.path) + ".admin").exists())


if __name__ == "__main__":
    unittest.main()
