"""DENY must invalidate every matching lease before replacement prefaulting."""

import os
from pathlib import Path
import select
import shlex
import subprocess
import tempfile
import time
import unittest

from test_protocol import BACKEND, DAEMON, ROOT, connect, request


GATE_SOURCE = r'''
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>

/* Gate only the first refill: the two startup prefaults run normally. */
int madvise(void *address, size_t length, int advice) {
    static int (*original)(void *, size_t, int);
    static unsigned prefaults;
    if (!original) {
        void *symbol = dlsym(RTLD_NEXT, "madvise");
        if (!symbol) { errno = ENOSYS; return -1; }
        memcpy(&original, &symbol, sizeof(original));
    }
    if (advice == MADV_POPULATE_WRITE && ++prefaults == 3) {
        const char *entered = getenv("HK_TEST_ENTERED_FD");
        const char *resume = getenv("HK_TEST_RESUME_FD");
        char ack;
        if (!entered || !resume || write(atoi(entered), "1", 1) != 1 ||
            read(atoi(resume), &ack, 1) != 1) {
            errno = ECANCELED;
            return -1;
        }
    }
    return original(address, length, advice);
}
'''


class DenyBatchTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if b"__asan_init" in DAEMON.read_bytes():
            raise unittest.SkipTest("LD_PRELOAD allocation gate is incompatible with ASan load ordering")
        cls.build = tempfile.TemporaryDirectory(prefix="hk-deny-gate-build-")
        cls.addClassCleanup(cls.build.cleanup)
        source = Path(cls.build.name) / "gate.c"
        source.write_text(GATE_SOURCE)
        cls.library = Path(cls.build.name) / "gate.so"
        subprocess.run(shlex.split(os.environ.get("CC", "cc")) + [
            "-std=c11", "-Wall", "-Wextra", "-Wpedantic", "-Werror", "-O2",
            "-fPIC", "-shared", str(source), "-o", str(cls.library), "-ldl",
        ], check=True, capture_output=True, text=True)

    def test_all_matching_leases_are_invalid_before_first_refill(self):
        entered_read, entered_write = os.pipe()
        resume_read, resume_write = os.pipe()
        sockets, descriptors = [], []
        process = None
        with tempfile.TemporaryDirectory(prefix="hk-deny-batch-") as directory, tempfile.TemporaryFile() as log:
            path = Path(directory) / "pool.sock"
            env = dict(os.environ, LD_PRELOAD=str(self.library),
                       HK_TEST_ENTERED_FD=str(entered_write), HK_TEST_RESUME_FD=str(resume_read))
            try:
                process = subprocess.Popen([
                    str(DAEMON), "--socket", str(path), "--backend", BACKEND,
                    "--pages", "2", "--slots", "2", "--allow-uid", str(os.getuid()),
                ], env=env, stdout=log, stderr=log, pass_fds=(entered_write, resume_read))
                os.close(entered_write)
                entered_write = -1
                os.close(resume_read)
                resume_read = -1
                deadline = time.monotonic() + 5
                while not Path(str(path) + ".admin").exists():
                    if process.poll() is not None or time.monotonic() >= deadline:
                        log.seek(0)
                        self.fail("daemon startup failed: " + log.read().decode(errors="replace"))
                    time.sleep(.005)
                control = connect(str(path) + ".admin")
                sockets.append(control)
                self.assertTrue(request(control, "STATUS")[0]["ok"])
                for _ in range(2):
                    client = connect(path)
                    sockets.append(client)
                    reply, fds = request(client, "ACQUIRE")
                    descriptors.extend(fds)
                    self.assertTrue(reply["ok"], reply)
                    self.assertEqual(len(fds), 1)
                control.send(f"DENY {os.getuid()}".encode())
                ready, _, _ = select.select([entered_read], [], [], 5)
                self.assertTrue(ready, "DENY never reached the first replacement prefault")
                self.assertEqual(os.read(entered_read, 1), b"1")
                # The daemon is now paused inside the first replacement's
                # prefault. Assertions depend on ordering, not elapsed time.
                for fd in descriptors:
                    self.assertEqual(os.fstat(fd).st_size, 0,
                                     "DENY left a later lease live while refilling an earlier slot")
                os.write(resume_write, b"1")
                os.close(resume_write)
                resume_write = -1
                self.assertEqual(control.recv(4096), b'{"ok":true}')
                status, extra = request(control, "STATUS")
                self.assertEqual(extra, [])
                self.assertEqual((status["ready"], status["leased"], status["degraded"]), (2, 0, 0))
                self.assertNotIn(os.getuid(), status["allowed_uids"])
            finally:
                # Always release a blocked shim before waiting for shutdown,
                # including when the ordering assertion deliberately fails.
                if resume_write >= 0:
                    try:
                        os.write(resume_write, b"1")
                    except BrokenPipeError:
                        pass
                for fd in (entered_read, entered_write, resume_read, resume_write):
                    if fd >= 0:
                        os.close(fd)
                for client in sockets:
                    client.close()
                for fd in descriptors:
                    os.close(fd)
                if process is not None and process.poll() is None:
                    process.terminate()
                    try:
                        process.wait(5)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait(5)
                if process is not None:
                    log.seek(0)
                    self.assertEqual(process.returncode, 0, log.read().decode(errors="replace"))


if __name__ == "__main__":
    unittest.main()
