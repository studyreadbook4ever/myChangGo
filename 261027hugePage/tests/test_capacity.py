"""Read-only capacity estimation against mocked proc/sys/cgroup snapshots."""

import ctypes
from pathlib import Path
import shlex
import os
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
MIB = 1024 * 1024
UNLIMITED = (1 << 64) - 1


class CapacityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.build = tempfile.TemporaryDirectory(prefix="hk-capacity-build-")
        cls.addClassCleanup(cls.build.cleanup)
        source = Path(cls.build.name) / "capacity_test.c"
        source.write_text('''
#define _GNU_SOURCE
#include <sys/resource.h>
#include <stdint.h>
static uint64_t mock_as, mock_locked;
static int snapshot_getrlimit(int resource, struct rlimit *out) {
    uint64_t value = resource == RLIMIT_AS ? mock_as : mock_locked;
    out->rlim_cur = value == UINT64_MAX ? RLIM_INFINITY : (rlim_t)value;
    out->rlim_max = out->rlim_cur;
    return 0;
}
#define getrlimit snapshot_getrlimit
#include "''' + str(ROOT / "src/capacity.c") + '''"
#undef getrlimit
uint64_t estimate(const char *proc, const char *sys, bool huge, bool lock,
                  uint64_t cap, uint64_t as, uint64_t locked, char *reason, size_t size) {
    mock_as = as;
    mock_locked = locked;
    return available_pages_at(proc, sys, huge, lock, cap, reason, size);
}
''')
        library = Path(cls.build.name) / "capacity_test.so"
        subprocess.run(shlex.split(os.environ.get("CC", "cc")) + [
            "-std=c11", "-Wall", "-Wextra", "-Wpedantic", "-Werror", "-O2",
            "-shared", "-fPIC", str(source), "-o", str(library),
        ], check=True, capture_output=True, text=True)
        cls.lib = ctypes.CDLL(str(library))
        cls.lib.estimate.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_bool,
                                    ctypes.c_bool, ctypes.c_uint64, ctypes.c_uint64,
                                    ctypes.c_uint64, ctypes.c_char_p, ctypes.c_size_t]
        cls.lib.estimate.restype = ctypes.c_uint64

    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="hk-capacity-")
        self.addCleanup(directory.cleanup)
        self.base = Path(directory.name)
        self.proc = self.base / "proc"
        self.sys = self.base / "sys"
        self.cgroup = self.sys / "fs/cgroup"
        self.leaf = self.cgroup / "team/work"
        self.leaf.mkdir(parents=True)
        self.write(self.proc / "self/cgroup", "0::/team/work\n")
        self.write_mountinfo()
        self.write(self.proc / "meminfo", "MemTotal: 2097152 kB\nMemAvailable: 1048576 kB\n")
        self.write(self.proc / "self/status", "VmSize: 4096 kB\nVmLck: 1024 kB\n")
        huge = self.sys / "kernel/mm/hugepages/hugepages-2048kB"
        self.write(huge / "free_hugepages", "12\n")
        self.write(huge / "resv_hugepages", "2\n")
        self.limit(self.leaf, "memory", "max", 0)

    @staticmethod
    def write(path, value):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(str(value))

    def write_mountinfo(self, *, options="rw", root="/", extra=""):
        point = str(self.cgroup).replace("\\", "\\134").replace(" ", "\\040")
        self.write(self.proc / "self/mountinfo",
                   f"40 30 0:28 {root} {point} rw - cgroup2 cgroup2 {options}\n" + extra)

    def limit(self, path, controller, maximum, current):
        self.write(path / (controller + ".max"), str(maximum) + "\n")
        self.write(path / (controller + ".current"), str(current) + "\n")

    def estimate(self, *, huge=False, lock=False, cap=0, as_limit=UNLIMITED, lock_limit=UNLIMITED):
        reason = ctypes.create_string_buffer(512)
        pages = self.lib.estimate(os.fsencode(self.proc), os.fsencode(self.sys), huge,
                                  lock, cap, as_limit, lock_limit, reason, len(reason))
        return pages, reason.value.decode()

    def test_host_safety_reserve_and_explicit_cap(self):
        self.assertEqual(self.estimate()[0], 448)  # 1 GiB - 128 MiB.
        self.assertEqual(self.estimate(cap=2)[0], 2)
        self.assertIn("Snapshot only", self.estimate()[1])
        self.write(self.proc / "meminfo", "MemAvailable: 10485760 kB\n")
        self.assertEqual(self.estimate()[0], 4608)  # 10 GiB - 10 percent.

    def test_ancestor_cgroup_limit_reserves_room_inside_cgroup(self):
        self.limit(self.cgroup / "team", "memory", 512 * MIB, 64 * MIB)
        self.assertEqual(self.estimate()[0], 160)  # 448 MiB headroom - 128 MiB.
        self.assertIn("cgroup memory.max", self.estimate()[1])
        self.limit(self.cgroup / "team", "memory", 100 * MIB, 0)
        self.assertEqual(self.estimate()[0], 0)

    def test_hugetlb_free_reservations_and_both_controller_limits(self):
        self.assertEqual(self.estimate(huge=True)[0], 10)
        self.limit(self.cgroup / "team", "hugetlb.2MB", 12 * MIB, 4 * MIB)
        self.assertEqual(self.estimate(huge=True)[0], 4)
        self.limit(self.leaf, "hugetlb.2MB.rsvd", 8 * MIB, 2 * MIB)
        self.assertEqual(self.estimate(huge=True)[0], 3)
        self.write(self.sys / "kernel/mm/hugepages/hugepages-2048kB/resv_hugepages", "15\n")
        self.assertEqual(self.estimate(huge=True)[0], 0)

    def test_hugetlb_memory_controller_accounting_mount_option(self):
        self.limit(self.leaf, "memory", 8 * MIB, 4 * MIB)
        self.assertEqual(self.estimate(huge=True)[0], 10)
        self.write_mountinfo(options="rw,memory_hugetlb_accounting")
        self.assertEqual(self.estimate(huge=True)[0], 2)

    def test_address_space_and_memlock_residuals(self):
        self.assertEqual(self.estimate(as_limit=10 * MIB)[0], 3)
        self.assertEqual(self.estimate(as_limit=3 * MIB)[0], 0)
        self.assertEqual(self.estimate(lock=True, lock_limit=8 * MIB)[0], 3)
        self.assertEqual(self.estimate(lock=False, lock_limit=0)[0], 448)

    def test_missing_or_malformed_required_data_fails_closed(self):
        self.limit(self.leaf, "memory", "not-a-limit", 0)
        pages, reason = self.estimate()
        self.assertEqual(pages, 0)
        self.assertIn("Cannot read cgroup", reason)
        self.limit(self.leaf, "memory", 256 * MIB, 0)
        (self.leaf / "memory.current").unlink()
        self.assertEqual(self.estimate()[0], 0)
        self.write(self.proc / "self/cgroup", "2:memory:/team/work\n")
        self.assertIn("cgroup v2", self.estimate()[1])

    def test_mount_root_and_escaped_mount_point(self):
        self.cgroup = self.sys / "a space"
        self.cgroup.mkdir()
        self.write_mountinfo(root="/team")
        self.limit(self.cgroup / "work", "memory", 512 * MIB, 0)
        self.assertEqual(self.estimate()[0], 192)
        self.write(self.proc / "self/cgroup", "0::/\n")
        self.limit(self.cgroup, "memory", 256 * MIB, 0)
        self.assertEqual(self.estimate()[0], 64)

    def test_widest_mount_keeps_visible_parent_limits(self):
        self.limit(self.cgroup / "team", "memory", 256 * MIB, 0)
        narrow = self.sys / "narrow"
        (narrow / "work").mkdir(parents=True)
        self.write_mountinfo(extra=f"41 30 0:28 /team {narrow} rw - cgroup2 cgroup2 rw\n")
        self.assertEqual(self.estimate()[0], 64)


if __name__ == "__main__":
    unittest.main()
