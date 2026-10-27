#!/usr/bin/env python3
"""Bounded host benchmark. Output is JSON, and never claims database speedups."""
from __future__ import annotations

import argparse
import array
import datetime
import hashlib
import json
import mmap
import os
from pathlib import Path
import platform
import resource
import shutil
import socket
import statistics
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]


def connect(path):
    s = socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET)
    s.settimeout(5)
    s.connect(str(path))
    return s


def exchange(s, command):
    s.send(command.encode())
    payload, ancillary, flags, _ = s.recvmsg(4096, socket.CMSG_SPACE(4))
    fds = []
    for level, kind, data in ancillary:
        if level == socket.SOL_SOCKET and kind == socket.SCM_RIGHTS:
            values = array.array("i")
            values.frombytes(data[:len(data) - len(data) % values.itemsize])
            fds.extend(values)
    try:
        if flags & (socket.MSG_TRUNC | socket.MSG_CTRUNC):
            raise RuntimeError("truncated response")
        reply = json.loads(payload)
    except BaseException:
        for fd in fds:
            os.close(fd)
        raise
    return reply, fds


def admin(path, command):
    with connect(str(path) + ".admin") as s:
        result, fds = exchange(s, command)
        for fd in fds:
            os.close(fd)
        if fds:
            raise RuntimeError("unexpected admin descriptor")
        return result


def cpu_ticks(pid):
    fields = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
    return int(fields[11]) + int(fields[12])


def process_memory(pid):
    result = {}
    for line in Path(f"/proc/{pid}/status").read_text().splitlines():
        key, _, value = line.partition(":")
        if key in {"VmRSS", "VmSize", "VmLck", "RssAnon", "RssFile", "RssShmem"}:
            result[key + "_kib"] = int(value.split()[0])
    smaps = Path(f"/proc/{pid}/smaps_rollup")
    try:
        smaps_content = smaps.read_text()
    except PermissionError:
        result["smaps_access"] = "restricted by daemon PR_SET_DUMPABLE=0; use STATUS backing counters"
    except FileNotFoundError:
        pass
    else:
        for line in smaps_content.splitlines():
            key, _, value = line.partition(":")
            if key in {"AnonHugePages", "ShmemPmdMapped", "FilePmdMapped", "Private_Hugetlb", "Shared_Hugetlb"}:
                result[key + "_kib"] = int(value.split()[0])
    return result


def host_info():
    info = {"platform": platform.platform(), "machine": platform.machine(),
            "cpu_count": os.cpu_count(), "uid": os.getuid(),
            "clock_ticks_per_second": os.sysconf("SC_CLK_TCK"),
            "load_average": list(os.getloadavg()),
            "cpu_affinity": sorted(os.sched_getaffinity(0))}
    for line in Path("/proc/cpuinfo").read_text().splitlines():
        if line.startswith("model name"):
            info["cpu_model"] = line.split(":", 1)[1].strip()
            break
    info["hugepage_meminfo"] = {line.split(":", 1)[0]: line.split(":", 1)[1].strip()
        for line in Path("/proc/meminfo").read_text().splitlines()
        if line.startswith(("Huge", "AnonHuge", "ShmemHuge", "ShmemPmd"))}
    for filename in ("enabled", "shmem_enabled", "defrag"):
        p = Path("/sys/kernel/mm/transparent_hugepage") / filename
        if p.exists():
            info["thp_" + filename] = p.read_text().strip()
    return info


def binary_info(path):
    return {"path": str(Path(path).resolve()),
            "sha256": hashlib.sha256(Path(path).read_bytes()).hexdigest()}


class Broker:
    def __init__(self, executable, backend="plain", slots=2, slot_mib=2, max_mib=16,
                 fd_limit=None):
        self.tmp = tempfile.TemporaryDirectory(prefix="hugekeeper-measure-")
        self.path = Path(self.tmp.name) / "pool.sock"
        self.log = tempfile.TemporaryFile(mode="w+b")
        self.process = subprocess.Popen(
            [str(executable), "--socket", str(self.path), "--backend", backend,
             "--pages", str(slots * slot_mib // 2), "--slots", str(slots),
             "--max-mib", str(max_mib), "--allow-uid", str(os.getuid())],
            stdout=self.log, stderr=self.log,
            preexec_fn=(lambda: resource.setrlimit(resource.RLIMIT_NOFILE, (fd_limit, fd_limit)))
                       if fd_limit else None,
        )
        deadline = time.monotonic() + 15
        while not Path(str(self.path) + ".admin").exists():
            if self.process.poll() is not None or time.monotonic() >= deadline:
                self.log.seek(0)
                message = self.log.read().decode(errors="replace")
                self.close()
                raise RuntimeError("daemon startup failed: " + message)
            time.sleep(0.01)

    def close(self):
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(5)
        self.log.close()
        self.tmp.cleanup()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


def latency_summary(values):
    ordered = sorted(values)
    return {"samples": len(values), "p50_us": statistics.median(values) / 1000,
            "p95_us": ordered[min(len(ordered) - 1, int(len(ordered) * .95))] / 1000,
            "p99_us": ordered[min(len(ordered) - 1, int(len(ordered) * .99))] / 1000,
            "mean_us": statistics.mean(values) / 1000,
            "min_us": min(values) / 1000, "max_us": max(values) / 1000}


MEMORY_PROBE = r'''
#define _GNU_SOURCE
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <time.h>
#include <unistd.h>
static double now(void) {
    struct timespec t;
    if (clock_gettime(CLOCK_MONOTONIC, &t)) exit(3);
    return (double)t.tv_sec + (double)t.tv_nsec / 1e9;
}
int main(int argc, char **argv) {
    if (argc != 4) return 2;
    int fd = atoi(argv[1]);
    size_t size = strtoull(argv[2], 0, 10);
    unsigned passes = strtoul(argv[3], 0, 10);
    void *p = mmap(0, size, PROT_READ | PROT_WRITE,
        fd < 0 ? MAP_PRIVATE | MAP_ANONYMOUS : MAP_SHARED, fd, 0);
    if (p == MAP_FAILED) { perror("mmap"); return 3; }
    memset(p, 1, size);
    uint64_t sum = 0;
    volatile uint64_t *words = p;
    double start = now();
    for (unsigned pass = 0; pass < passes; ++pass)
        for (size_t i = 0; i < size / sizeof(uint64_t); i += 8)
            sum += words[i];
    double elapsed = now() - start;
    printf("{\"elapsed_seconds\":%.9f,\"checksum\":%llu,"
           "\"scanned_span_gib_per_second\":%.6f,\"loaded_gib_per_second\":%.6f}",
        elapsed, (unsigned long long)sum,
        ((double)size * passes) / elapsed / 1073741824.0,
        ((double)size * passes / 8) / elapsed / 1073741824.0);
    munmap(p, size);
    return 0;
}
'''


def traversal_benchmark(fd, size):
    compiler = shutil.which("cc")
    if compiler is None:
        return {"skipped": "C compiler unavailable"}
    with tempfile.TemporaryDirectory(prefix="hugekeeper-probe-") as directory:
        source = Path(directory) / "probe.c"
        executable = Path(directory) / "probe"
        source.write_text(MEMORY_PROBE)
        subprocess.run([compiler, "-O2", "-std=c11", "-Wall", "-Wextra", "-o", str(executable), str(source)],
                       check=True, capture_output=True, timeout=30)
        result = {"size_bytes": size, "passes": 256, "stride_bytes": 64,
                  "load_bytes_per_stride": 8, "repeats": 5,
                  "note": "Cache-hot microbenchmark; useful loads are one eighth of scanned span. Not a DB or DRAM bandwidth measurement. Anonymous comparison inherits host THP policy and is not a forced small-page baseline."}
        for label, descriptor in (("anonymous", -1), ("broker_shared", fd)):
            result[label] = [json.loads(subprocess.check_output(
                [str(executable), str(descriptor), str(size), "256"],
                pass_fds=(fd,), timeout=15)) for _ in range(5)]
        return result


def benchmark(args):
    result = {"schema_version": 1, "recorded_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
              "host": host_info(), "daemon": binary_info(args.daemon), "backend_requested": args.backend,
              "config": {"slots": 2, "slot_mib": args.slot_mib, "iterations": args.iterations},
              "limitations": ["Single machine and small pool; timings include Python and socket IPC.",
                              "THP is a kernel hint; actual huge-page mapping is reported separately.",
                              "Release replaces and prefaults a slot; this cost scales with slot size."]}
    with Broker(args.daemon, args.backend, slot_mib=args.slot_mib,
                max_mib=args.slot_mib * 4) as broker:
        result["status"] = admin(broker.path, "STATUS")
        result["daemon_memory"] = process_memory(broker.process.pid)
        before = cpu_ticks(broker.process.pid)
        start = time.monotonic()
        time.sleep(args.idle_seconds)
        elapsed = time.monotonic() - start
        ticks = cpu_ticks(broker.process.pid) - before
        result["idle"] = {"wall_seconds": elapsed, "cpu_ticks": ticks,
                          "cpu_seconds": ticks / os.sysconf("SC_CLK_TCK"),
                          "percent_of_one_cpu": ticks / os.sysconf("SC_CLK_TCK") / elapsed * 100,
                          "resolution_seconds": 1 / os.sysconf("SC_CLK_TCK")}
        acquired, released, mapped = [], [], []
        with connect(broker.path) as s:
            # Warm-up is excluded from the timing distributions.
            for index in range(args.iterations + 10):
                start = time.perf_counter_ns()
                lease, fds = exchange(s, "ACQUIRE")
                stop = time.perf_counter_ns()
                if not lease.get("ok") or len(fds) != 1:
                    raise RuntimeError((lease, fds))
                fd = fds[0]
                try:
                    map_start = time.perf_counter_ns()
                    with mmap.mmap(fd, lease["size"]) as region:
                        region[0] = 1
                        region[-1] = 2
                    map_end = time.perf_counter_ns()
                finally:
                    os.close(fd)
                release_start = time.perf_counter_ns()
                reply, extra = exchange(s, f"RELEASE {lease['lease']}")
                release_end = time.perf_counter_ns()
                if not reply.get("ok") or extra:
                    for extra_fd in extra:
                        os.close(extra_fd)
                    raise RuntimeError((reply, extra))
                if index >= 10:
                    acquired.append(stop - start)
                    mapped.append(map_end - map_start)
                    released.append(release_end - release_start)
            result["acquire"] = latency_summary(acquired)
            result["map_touch_edges_unmap"] = latency_summary(mapped)
            result["release_and_replace"] = latency_summary(released)
            lease, fds = exchange(s, "ACQUIRE")
            if not lease.get("ok") or len(fds) != 1:
                raise RuntimeError((lease, fds))
            try:
                result["direct_memory_traversal"] = traversal_benchmark(fds[0], lease["size"])
            finally:
                os.close(fds[0])
                exchange(s, f"RELEASE {lease['lease']}")
        result["final_status"] = admin(broker.path, "STATUS")
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--daemon", type=Path, default=ROOT / "build/hugekeeperd")
    parser.add_argument("--backend", choices=("plain", "thp", "hugetlb"), default="plain")
    parser.add_argument("--slot-mib", type=int, default=2)
    parser.add_argument("--iterations", type=int, default=300)
    parser.add_argument("--idle-seconds", type=float, default=2)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if not 2 <= args.slot_mib <= 32 or args.slot_mib % 2 or args.iterations < 1 or args.idle_seconds < .1:
        parser.error("slot-mib must be even and 2..32, iterations >= 1, idle-seconds >= 0.1")
    result = benchmark(args)
    output = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(output)
    print(output, end="")


if __name__ == "__main__":
    main()
