#!/usr/bin/env python3
"""Alternating native A/B benchmark; maximum configured pool is 256 MiB.

Latency samples are taken in C with CLOCK_MONOTONIC, over a persistent control
connection. Python orchestrates runs and records provenance, never individual
request latency. The two source directories must describe the binaries supplied.
"""
from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import statistics
import subprocess
import tempfile
import time

from benchmark import admin, binary_info, host_info, process_memory

ROOT = Path(__file__).resolve().parents[1]
SOURCE_FILES = ("src/daemon.c", "src/capacity.c", "src/capacity.h")
METRICS = ("acquire", "map_touch_edges_unmap", "release_and_replace", "whole_cycle", "status")


def source_info(directory):
    directory = Path(directory).resolve()
    files = {}
    for name in SOURCE_FILES:
        path = directory / name
        if not path.is_file():
            path = directory / Path(name).name
        files[name] = hashlib.sha256(path.read_bytes()).hexdigest()
    encoded = json.dumps(files, sort_keys=True, separators=(",", ":")).encode()
    return {"path": str(directory), "files": files,
            "manifest_sha256": hashlib.sha256(encoded).hexdigest(),
            "manifest_encoding": "SHA256 of sorted compact JSON mapping relative file paths to SHA256"}


class Daemon:
    def __init__(self, executable, backend, slot_mib, cpu=None, trace=False):
        self.tmp = tempfile.TemporaryDirectory(prefix="hk-ab-")
        self.path = Path(self.tmp.name) / "pool.sock"
        self.trace_path = Path(self.tmp.name) / "strace.txt"
        self.log = tempfile.TemporaryFile(mode="w+b")
        self.usage = None
        self.trace = None
        self.pid = None
        self.process = None
        command = [str(executable), "--socket", str(self.path), "--backend", backend,
                   "--pages", str(slot_mib), "--slots", "2", "--max-mib", "256",
                   "--allow-uid", str(os.getuid())]
        if trace:
            command = ["strace", "-f", "-qq", "-c", "-o", str(self.trace_path), *command]
        try:
            self.process = subprocess.Popen(command, stdout=self.log, stderr=self.log)
            self.pid = self.process.pid
            if cpu is not None:
                os.sched_setaffinity(self.process.pid, {cpu})
            deadline = time.monotonic() + 20
            while not Path(str(self.path) + ".admin").exists():
                if self.process.poll() is not None or time.monotonic() >= deadline:
                    self.log.seek(0)
                    raise RuntimeError("daemon startup failed: " + self.log.read().decode(errors="replace"))
                time.sleep(.01)
            if trace:
                children = Path(f"/proc/{self.process.pid}/task/{self.process.pid}/children").read_text().split()
                if len(children) != 1:
                    raise RuntimeError("expected one traced daemon child")
                self.pid = int(children[0])
                if cpu is not None:
                    os.sched_setaffinity(self.pid, {cpu})
        except BaseException:
            self.close()
            raise

    def close(self):
        if self.process is not None and self.process.returncode is None:
            try:
                os.kill(self.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            deadline = time.monotonic() + 10
            while True:
                pid, status, usage = os.wait4(self.process.pid, os.WNOHANG)
                if pid:
                    self.process.returncode = os.waitstatus_to_exitcode(status)
                    self.usage = {"user_seconds": usage.ru_utime, "system_seconds": usage.ru_stime,
                                  "total_seconds": usage.ru_utime + usage.ru_stime,
                                  "max_rss_kib": usage.ru_maxrss,
                                  "minor_faults": usage.ru_minflt, "major_faults": usage.ru_majflt,
                                  "voluntary_context_switches": usage.ru_nvcsw,
                                  "involuntary_context_switches": usage.ru_nivcsw}
                    break
                if time.monotonic() >= deadline:
                    for target in {self.pid, self.process.pid}:
                        try:
                            os.kill(target, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                time.sleep(.01)
        if self.trace_path.exists():
            self.trace = self.trace_path.read_text()
        self.log.close()
        self.tmp.cleanup()


def run_once(executable, native, backend, slot_mib, args, trace=False):
    daemon = Daemon(executable, backend, slot_mib, args.daemon_cpu, trace)
    try:
        status = admin(daemon.path, "STATUS")
        if not status.get("ok"):
            raise RuntimeError(f"STATUS failed: {status}")
        memory = process_memory(daemon.pid)
        command = [str(native), str(daemon.path), str(daemon.pid),
                   str(args.trace_iterations if trace else args.iterations),
                   "0" if trace else str(args.warmup), str(slot_mib * 1024 * 1024)]
        # Only the native child is pinned; orchestration does not consume its CPU.
        affinity = ((lambda: os.sched_setaffinity(0, {args.client_cpu}))
                    if args.client_cpu is not None else None)
        probe = json.loads(subprocess.check_output(command, timeout=args.run_timeout,
                                                   preexec_fn=affinity))
        command[1] = str(daemon.path) + ".admin"
        status_probe = json.loads(subprocess.check_output([*command, "status"], timeout=args.run_timeout,
                                                          preexec_fn=affinity))
        final_status = admin(daemon.path, "STATUS")
        if final_status.get("leased") != 0 or final_status.get("ready") != 2:
            raise RuntimeError(f"pool did not recover after benchmark: {final_status}")
    finally:
        daemon.close()
    if daemon.process.returncode != 0:
        raise RuntimeError(f"daemon exited with status {daemon.process.returncode}")
    result = {"status": status, "memory": memory, "native": probe, "native_status": status_probe,
              "final_status": final_status, "daemon_lifetime_rusage": daemon.usage}
    if trace:
        result["syscall_counts"] = parse_strace(daemon.trace)
        result["strace_summary"] = daemon.trace
        result["note"] = ("Separate traced run: includes startup, STATUS, native loop and shutdown. "
                          "Its latencies are excluded from all A/B timing summaries. "
                          "Native loops include lease lifecycle and STATUS. Lifetime rusage includes tracer CPU.")
    return result


def parse_strace(output):
    calls = {}
    for line in output.splitlines():
        fields = line.split()
        if len(fields) not in (5, 6) or fields[-1] == "total":
            continue
        try:
            float(fields[0])
            seconds = float(fields[1])
            count = int(fields[3])
            errors = int(fields[4]) if len(fields) == 6 else 0
        except ValueError:
            continue
        calls[fields[-1]] = {"calls": count, "errors": errors, "seconds": seconds}
    return calls


def summarize(rounds):
    summary = {}
    for metric in METRICS:
        values = {}
        source = "native_status" if metric == "status" else "native"
        for percentile in ("p50_us", "p95_us", "p99_us", "mean_us"):
            before = [r["before"][source][metric][percentile] for r in rounds]
            after = [r["after"][source][metric][percentile] for r in rounds]
            ratios = [a / b for a, b in zip(after, before)]
            values[percentile] = {"before_round_median": statistics.median(before),
                                  "after_round_median": statistics.median(after),
                                  "paired_ratio_median": statistics.median(ratios),
                                  "paired_reduction_percent_median": 100 * (1 - statistics.median(ratios)),
                                  "paired_ratio_min": min(ratios), "paired_ratio_max": max(ratios)}
        summary[metric] = values
    for source in ("native", "native_status"):
        for metric in ("daemon_cpu_seconds", "client_cpu_seconds", "wall_seconds"):
            before = [r["before"][source][metric] for r in rounds]
            after = [r["after"][source][metric] for r in rounds]
            ratios = [a / b for a, b in zip(after, before) if b > 0]
            label = ("status_" if source == "native_status" else "") + metric
            summary[label] = {"before_round_median": statistics.median(before),
                              "after_round_median": statistics.median(after),
                              "paired_ratio_median": statistics.median(ratios) if ratios else None}
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--before", type=Path, default=ROOT / "build/hugekeeperd-before-opt")
    parser.add_argument("--after", type=Path, default=ROOT / "build/hugekeeperd")
    parser.add_argument("--before-source", type=Path, required=True,
                        help="immutable source snapshot used to build --before")
    parser.add_argument("--after-source", type=Path, default=ROOT)
    parser.add_argument("--backends", nargs="+", choices=("plain", "thp", "hugetlb"), default=["plain", "thp"])
    parser.add_argument("--slot-mib", nargs="+", type=int, default=[2, 16])
    parser.add_argument("--iterations", type=int, default=250)
    parser.add_argument("--warmup", type=int, default=20)
    parser.add_argument("--rounds", type=int, default=6)
    parser.add_argument("--daemon-cpu", type=int)
    parser.add_argument("--client-cpu", type=int)
    parser.add_argument("--strace", action="store_true", help="collect separate syscall count runs")
    parser.add_argument("--trace-iterations", type=int, default=25)
    parser.add_argument("--run-timeout", type=int, default=180)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if any(size < 2 or size > 64 or size % 2 for size in args.slot_mib):
        parser.error("slot sizes must be even numbers of MiB in 2..64")
    if not 1 <= args.iterations <= 1000000 or not 0 <= args.warmup <= 100000 or args.rounds < 1:
        parser.error("iterations must be 1..1000000, warmup 0..100000, rounds >= 1")
    if not 1 <= args.trace_iterations <= 1000000 or args.run_timeout < 1:
        parser.error("trace iterations must be 1..1000000 and run timeout must be positive")
    available = os.sched_getaffinity(0)
    if any(cpu is not None and cpu not in available for cpu in (args.daemon_cpu, args.client_cpu)):
        parser.error(f"CPU affinity must be selected from {sorted(available)}")
    if args.strace and shutil.which("strace") is None:
        parser.error("--strace requested but strace is not installed")
    result = {"schema_version": 1,
              "recorded_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
              "host": host_info(),
              "config": {"backends": args.backends, "slot_mib": args.slot_mib,
                         "slots": 2, "pool_ceiling_mib": 256, "rounds": args.rounds,
                         "iterations_per_round": args.iterations, "warmup_per_round": args.warmup,
                         "daemon_cpu": args.daemon_cpu, "client_cpu": args.client_cpu},
              "variants": {}, "cases": [],
              "methodology": [
                  "Sequential A/B runs with reversed order in alternating rounds; fresh daemon each run.",
                  "Native C CLOCK_MONOTONIC latency samples, persistent SOCK_SEQPACKET; no Python request timing.",
                  "Acquire includes send/recvmsg and bounded protocol parsing. Mapping touches first/last bytes only.",
                  "Release includes revocation and replacement preallocation; no old allocation is reused across tenants.",
                  "Each native sample validates first/last bytes are zero before writing.",
                  "Separate native STATUS loop preserves full daemon STATUS semantics; full JSON parsing is excluded from its timer.",
                  "Native daemon CPU is /proc stat tick delta over measured loop, excluding warmup; resolution reported.",
                  "wait4 lifetime rusage includes daemon startup, warmup, STATUS, measured loop and shutdown.",
                  "Summaries report medians of per-round percentiles and paired after/before ratios, not pooled percentiles.",
                  "Shared-host scheduling, frequency and cache variation remain; no database throughput claim.",
                  "THP is a hint. STATUS records actual backing; this benchmark does not alter host HugeTLB reservations.",
              ]}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="hk-ab-binaries-") as directory:
        directory = Path(directory)
        native = directory / "native-benchmark"
        compile_command = ["cc", "-O2", "-std=c11", "-Wall", "-Wextra", "-Wpedantic", "-Werror",
                           "-D_FORTIFY_SOURCE=3", "-fstack-protector-strong", "-I", str(ROOT / "include"),
                           str(ROOT / "scripts/native_benchmark.c"), "-o", str(native)]
        subprocess.run(compile_command, check=True, capture_output=True, timeout=30)
        result["native_probe"] = {"binary": binary_info(native),
                                  "source_sha256": hashlib.sha256((ROOT / "scripts/native_benchmark.c").read_bytes()).hexdigest(),
                                  "protocol_parser_sha256": hashlib.sha256((ROOT / "src/client.c").read_bytes()).hexdigest(),
                                  "header_sha256": hashlib.sha256((ROOT / "include/hugekeeper.h").read_bytes()).hexdigest(),
                                  "driver_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                                  "compiler": subprocess.check_output(["cc", "--version"], text=True).splitlines()[0],
                                  "compile_command": compile_command}
        binaries = {}
        for label, original, source in (("before", args.before, args.before_source),
                                         ("after", args.after, args.after_source)):
            binaries[label] = directory / label
            shutil.copy2(original, binaries[label])
            result["variants"][label] = {"binary": binary_info(binaries[label]),
                                         "original_path": str(original.resolve()), "source": source_info(source)}
        for backend in args.backends:
            for slot_mib in args.slot_mib:
                case = {"backend": backend, "slot_mib": slot_mib, "rounds": []}
                result["cases"].append(case)
                for index in range(args.rounds):
                    order = ["before", "after"] if index % 2 == 0 else ["after", "before"]
                    sample = {"round": index + 1, "order": order}
                    for label in order:
                        print(f"{backend} {slot_mib} MiB round {index + 1}/{args.rounds}: {label}", flush=True)
                        sample[label] = run_once(binaries[label], native, backend, slot_mib, args)
                    case["rounds"].append(sample)
                    # Preserve completed rounds if a later diagnostic fails.
                    args.output.write_text(json.dumps(result, indent=2) + "\n")
                case["summary"] = summarize(case["rounds"])
                if args.strace:
                    case["syscall_runs"] = {}
                    for label in ("before", "after"):
                        print(f"{backend} {slot_mib} MiB separate strace run: {label}", flush=True)
                        case["syscall_runs"][label] = run_once(binaries[label], native, backend, slot_mib, args, trace=True)
                args.output.write_text(json.dumps(result, indent=2) + "\n")
        result["completed_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        args.output.write_text(json.dumps(result, indent=2) + "\n")
    print(f"Recorded complete native A/B comparison: {args.output}")


if __name__ == "__main__":
    main()
