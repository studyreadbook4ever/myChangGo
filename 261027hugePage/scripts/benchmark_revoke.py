#!/usr/bin/env python3
"""Compare DENY last-lease invalidation and full-refill latency with bounded memory."""
from __future__ import annotations

import argparse
import datetime
import json
import os
from pathlib import Path
import statistics
import time

from benchmark import ROOT, Broker, admin, binary_info, connect, exchange, host_info, latency_summary


def measure(executable, backend, slots, slot_mib):
    clients, descriptors = [], []
    with Broker(executable, backend, slots=slots, slot_mib=slot_mib,
                max_mib=slots * slot_mib) as broker:
        try:
            initial = admin(broker.path, "STATUS")  # Wait for complete startup.
            for _ in range(slots):
                client = connect(broker.path)
                clients.append(client)
                lease, fds = exchange(client, "ACQUIRE")
                descriptors.extend(fds)
                if not lease.get("ok") or len(fds) != 1:
                    raise RuntimeError((lease, fds))
            with connect(str(broker.path) + ".admin") as control:
                # Admit the control connection before timing either binary.
                status, extra = exchange(control, "STATUS")
                for fd in extra:
                    os.close(fd)
                if extra or status.get("leased") != slots:
                    raise RuntimeError((status, extra))
                packet = f"DENY {os.getuid()}".encode()
                started = time.perf_counter_ns()
                if control.send(packet) != len(packet):
                    raise RuntimeError("short DENY request")
                polls = 0
                # Acquisitions select slots in allocation order. The last FD
                # therefore observes the last matching slot in DENY's pass.
                while os.fstat(descriptors[-1]).st_size:
                    polls += 1
                    if polls % 128 == 0 and time.perf_counter_ns() - started > 10_000_000_000:
                        raise TimeoutError("DENY did not invalidate the last lease")
                invalidated = time.perf_counter_ns()
                reply = json.loads(control.recv(4096))
                completed = time.perf_counter_ns()
                if reply != {"ok": True}:
                    raise RuntimeError(reply)
                if any(os.fstat(fd).st_size for fd in descriptors):
                    raise AssertionError("DENY left an old lease valid")
                final, extra = exchange(control, "STATUS")
                for fd in extra:
                    os.close(fd)
                if (extra or final.get("ready") != slots or final.get("leased") != 0
                        or final.get("degraded") != 0 or os.getuid() in final.get("allowed_uids", [])):
                    raise AssertionError(final)
            return {"last_lease_invalidated_ns": invalidated - started,
                    "deny_reply_after_refill_ns": completed - started,
                    "fd_size_polls": polls,
                    "initial_resident_bytes": initial["resident_bytes"],
                    "initial_hugetlb_bytes": initial["hugetlb_bytes"],
                    "initial_thp_mapped_bytes": initial["thp_mapped_bytes"],
                    "ready_after": final["ready"], "degraded_after": final["degraded"]}
        finally:
            for fd in descriptors:
                os.close(fd)
            for client in clients:
                client.close()


def benchmark(args):
    binaries = {"before": args.baseline.resolve(), "after": args.daemon.resolve()}
    result = {
        "schema_version": 1,
        "recorded_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "host": host_info(),
        "binaries": {label: binary_info(binary) for label, binary in binaries.items()},
        "backend": args.backend,
        "config": {"slots": args.slots, "slot_mib": args.slot_mib,
                   "pool_mib": args.slots * args.slot_mib, "rounds": args.rounds,
                   "warmup_runs_per_binary": 1},
        "method": "Alternate before/after order each round; start one fresh daemon per sample. "
                  "Hold every slot, issue DENY, observe the last stale FD's size becoming zero, "
                  "then await the reply after replacement prefaults finish.",
        "limitations": [
            "Single-host control-plane benchmark; no claim about SQL or memory traversal speed.",
            "Observer polls fstat in Python and consumes one CPU while waiting; scheduling and "
            "IPC overhead are included in both variants.",
            "The last-FD timing measures its size becoming zero; DENY still replies only after refilling.",
            "Timed leases hold FDs without client mmap views. The observer detects file size zero, "
            "not the completion of TLB invalidation in arbitrary client mappings.",
            "THP remains a hint. Initial observed backing is recorded for each sample.",
        ],
        "samples": [],
    }
    for binary in binaries.values():
        measure(binary, args.backend, args.slots, args.slot_mib)
    for round_index in range(args.rounds):
        order = ("before", "after") if round_index % 2 == 0 else ("after", "before")
        for label in order:
            sample = measure(binaries[label], args.backend, args.slots, args.slot_mib)
            sample.update({"round": round_index + 1, "variant": label})
            result["samples"].append(sample)
    result["summary"] = {}
    for label in binaries:
        runs = [sample for sample in result["samples"] if sample["variant"] == label]
        result["summary"][label] = {
            field.removesuffix("_ns"): latency_summary([run[field] for run in runs])
            for field in ("last_lease_invalidated_ns", "deny_reply_after_refill_ns")
        }
    before = statistics.median([run["last_lease_invalidated_ns"] for run in result["samples"]
                                if run["variant"] == "before"])
    after = statistics.median([run["last_lease_invalidated_ns"] for run in result["samples"]
                               if run["variant"] == "after"])
    result["last_lease_invalidation_median_reduction_percent"] = (1 - after / before) * 100
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", type=Path, default=ROOT / "build/hugekeeperd-before-opt")
    parser.add_argument("--daemon", type=Path, default=ROOT / "build/hugekeeperd")
    parser.add_argument("--backend", choices=("plain", "thp", "hugetlb"), default="plain")
    parser.add_argument("--slots", type=int, default=8)
    parser.add_argument("--slot-mib", type=int, default=16)
    parser.add_argument("--rounds", type=int, default=8)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if (not 2 <= args.slots <= 32 or not 2 <= args.slot_mib <= 32 or args.slot_mib % 2
            or args.slots * args.slot_mib > 256 or not 1 <= args.rounds <= 100):
        parser.error("slots must be 2..32, slot-mib even and 2..32, pool <= 256 MiB, rounds 1..100")
    result = benchmark(args)
    output = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(output)
    print(output, end="")


if __name__ == "__main__":
    main()
