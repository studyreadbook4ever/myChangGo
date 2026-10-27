#!/usr/bin/env python3
"""Bounded concurrent acquire/release/disconnect/revoke exercise, emitting JSON."""
from __future__ import annotations

import argparse
import concurrent.futures
import datetime
import json
import mmap
import os
from pathlib import Path
import random
import threading
import time

from benchmark import ROOT, Broker, admin, binary_info, connect, cpu_ticks, exchange, process_memory


def stress(args):
    result = {"schema_version": 1, "recorded_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
              "backend": args.backend, "daemon": binary_info(args.daemon), "workers": args.workers,
              "cycles_per_worker": args.cycles, "seed": args.seed}
    with Broker(args.daemon, args.backend, slots=4, slot_mib=2, max_mib=16, fd_limit=256) as broker:
        # Readiness barrier before descriptor measurements.
        admin(broker.path, "STATUS")
        time.sleep(.02)
        try:
            initial_fds = len(os.listdir(f"/proc/{broker.process.pid}/fd"))
        except PermissionError:
            initial_fds = None
        before_ticks = cpu_ticks(broker.process.pid)
        barrier = threading.Barrier(args.workers)

        def worker(index):
            rng = random.Random(args.seed + index)
            counters = {"release": 0, "disconnect": 0, "revoke": 0, "empty_retries": 0}
            barrier.wait(timeout=10)
            s = connect(broker.path)
            try:
                for iteration in range(args.cycles):
                    deadline = time.monotonic() + 15
                    while True:
                        lease, fds = exchange(s, "ACQUIRE")
                        if lease.get("ok"):
                            break
                        if fds or lease.get("error") != "empty" or time.monotonic() >= deadline:
                            raise AssertionError((lease, fds))
                        counters["empty_retries"] += 1
                        time.sleep(rng.uniform(.0001, .002))
                    if len(fds) != 1:
                        raise AssertionError(f"expected one descriptor, received {fds}")
                    fd = fds[0]
                    try:
                        with mmap.mmap(fd, lease["size"]) as region:
                            if region[:4096] != bytes(4096) or region[-4096:] != bytes(4096):
                                raise AssertionError("fresh lease leaked prior contents")
                            pattern = bytes([(index + iteration) % 255 + 1]) * 4096
                            region[:4096] = pattern
                            region[-4096:] = pattern
                            if rng.random() < .15:
                                time.sleep(.001)
                            if region[:4096] != pattern or region[-4096:] != pattern:
                                raise AssertionError("concurrent lease modified owned memory")
                        operation = rng.choices(["release", "disconnect", "revoke"], [6, 3, 1])[0]
                        if operation == "release":
                            reply, extra = exchange(s, f"RELEASE {lease['lease']}")
                            if not reply["ok"] or extra:
                                raise AssertionError((reply, extra))
                        elif operation == "disconnect":
                            s.close()
                            s = connect(broker.path)
                            # Disconnect cleanup is asynchronous.
                            deadline = time.monotonic() + 5
                            while os.fstat(fd).st_size and time.monotonic() < deadline:
                                time.sleep(.001)
                        else:
                            reply = admin(broker.path, f"REVOKE {lease['lease']}")
                            if not reply["ok"]:
                                raise AssertionError(reply)
                        if os.fstat(fd).st_size != 0:
                            raise AssertionError("old inode survived lease termination")
                        try:
                            os.ftruncate(fd, lease["size"])
                        except OSError:
                            pass
                        else:
                            raise AssertionError("revoked descriptor allowed regrowth")
                        counters[operation] += 1
                    finally:
                        os.close(fd)
            finally:
                s.close()
            return counters

        started = time.monotonic()
        with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as executor:
            runs = list(executor.map(worker, range(args.workers)))
        elapsed = time.monotonic() - started
        deadline = time.monotonic() + 5
        while True:
            status = admin(broker.path, "STATUS")
            if status["leased"] == 0 and status["ready"] == 4:
                break
            if time.monotonic() >= deadline:
                raise AssertionError(status)
            time.sleep(.01)
        time.sleep(.02)
        final_fds = len(os.listdir(f"/proc/{broker.process.pid}/fd")) if initial_fds is not None else None
        if final_fds != initial_fds:
            raise AssertionError(f"daemon descriptor count changed {initial_fds} -> {final_fds}")
        result.update({"ok": True, "elapsed_seconds": elapsed,
                       "operations": {key: sum(run[key] for run in runs) for key in runs[0]},
                       "leases_per_second": args.workers * args.cycles / elapsed,
                       "daemon_cpu_seconds": (cpu_ticks(broker.process.pid) - before_ticks) / os.sysconf("SC_CLK_TCK"),
                       "daemon_memory": process_memory(broker.process.pid),
                       "daemon_fds_before": initial_fds, "daemon_fds_after": final_fds,
                       "daemon_fd_limit": 256,
                       "fd_verification": "bounded RLIMIT_NOFILE; proc count unavailable when dumpability disabled" if initial_fds is None else "proc descriptor counts and bounded RLIMIT_NOFILE",
                       "final_status": status})
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--daemon", type=Path, default=ROOT / "build/hugekeeperd")
    parser.add_argument("--backend", choices=("plain", "thp", "hugetlb"), default="plain")
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--cycles", type=int, default=100)
    parser.add_argument("--seed", type=int, default=261027)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if not 1 <= args.workers <= 32 or not 1 <= args.cycles <= 10000:
        parser.error("workers must be 1..32 and cycles 1..10000")
    result = stress(args)
    output = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(output)
    print(output, end="")


if __name__ == "__main__":
    main()
