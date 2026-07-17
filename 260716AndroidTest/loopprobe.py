#!/usr/bin/env python3
"""LoopProbe: run one bounded probe and return one honest three-valued result.

The implementation deliberately uses only the Python standard library.  It is
small enough to drop into an Android repository, but it does not guess Android
modules, variants, or tasks.  Those choices are part of the checked contract.
"""

from __future__ import annotations

import argparse
import contextlib
import ctypes
import dataclasses
import datetime as dt
import errno
import glob
import hashlib
import json
import os
import re
import selectors
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import uuid
import xml.etree.ElementTree as ET
from functools import lru_cache
from pathlib import Path, PurePosixPath
from typing import Any, Mapping, Sequence

try:  # POSIX is the primary target; the rest of the runner still works without it.
    import fcntl
except ImportError:  # pragma: no cover - exercised only on non-POSIX platforms
    fcntl = None  # type: ignore[assignment]


SCHEMA_VERSION = 1
PROGRAM_VERSION = "0.1.0"
CONFIG_SIZE_LIMIT = 256 * 1024
GIT_OUTPUT_LIMIT = 1024 * 1024
XML_FILE_LIMIT = 1000
XML_BYTES_LIMIT = 8 * 1024 * 1024

EXIT_PASS = 0
EXIT_FAIL = 1
EXIT_ERROR = 2
EXIT_CANCELLED = 130

ROOT_KEYS = {"version", "limits", "probes"}
LIMIT_KEYS = {
    "timeout_seconds",
    "kill_grace_seconds",
    "max_output_bytes",
    "output_tail_bytes",
    "min_free_memory_mb",
    "min_free_disk_mb",
}
PROBE_KEYS = {
    "name",
    "kind",
    "scope",
    "argv",
    "cwd",
    "env",
    "changes",
    "fallback",
    "cost",
    "timeout_seconds",
    "success_codes",
    "gradle_task",
    "junit_xml",
    "min_tests",
    "evidence_mode",
    "expected_test_class",
    "expected_test_name",
}

NAME_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
ENV_NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
GRADLE_TASK_RE = re.compile(r"^(?::[A-Za-z0-9_.-]+)+$")
ANSI_RE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
TASK_LINE_RE = re.compile(
    r"^\s*> Task (?P<task>\S+?)(?: "
    r"(?P<outcome>UP-TO-DATE|FROM-CACHE|NO-SOURCE|SKIPPED|FAILED))?\s*$"
)

HARD_RESOURCE_PATTERNS: dict[str, bytes] = {
    "jvm_oom": b"java.lang.outofmemoryerror",
    "heap_reservation_failed": b"could not reserve enough space for object heap",
    "native_allocation_failed": b"cannot allocate memory",
    "native_thread_exhausted": b"unable to create native thread",
    "disk_full": b"no space left on device",
}
SUSPECTED_RESOURCE_PATTERNS: dict[str, bytes] = {
    "gradle_daemon_disappeared": b"gradle build daemon disappeared unexpectedly",
    "resource_temporarily_unavailable": b"resource temporarily unavailable",
}
TOOLCHAIN_PATTERNS: dict[str, bytes] = {
    "android_sdk_missing": b"sdk location not found",
    "java_home_missing": b"java_home is not set",
    "android_licenses_missing": b"license agreements have not been accepted",
    "dependency_resolution": b"could not resolve all files",
    "network_unreachable": b"network is unreachable",
    "permission_denied": b"permission denied",
    "gradle_task_missing": b"task '",
}


class ConfigProblem(Exception):
    """A stable, user-facing configuration error."""


class DuplicateKeyProblem(ValueError):
    pass


@dataclasses.dataclass(frozen=True)
class Limits:
    timeout_seconds: float = 90.0
    kill_grace_seconds: float = 1.0
    max_output_bytes: int = 4 * 1024 * 1024
    output_tail_bytes: int = 64 * 1024
    min_free_memory_mb: int = 0
    min_free_disk_mb: int = 0


@dataclasses.dataclass(frozen=True)
class Probe:
    name: str
    kind: str
    scope: str
    argv: tuple[str, ...]
    cwd: str
    env: Mapping[str, str]
    changes: tuple[str, ...]
    fallback: bool
    cost: int
    timeout_seconds: float
    success_codes: tuple[int, ...]
    order: int
    gradle_task: str | None = None
    junit_xml: tuple[str, ...] = ()
    min_tests: int = 1
    evidence_mode: str = "gradle-cache-ok"
    expected_test_class: str | None = None
    expected_test_name: str | None = None


@dataclasses.dataclass(frozen=True)
class Config:
    path: Path
    root: Path
    digest: str
    limits: Limits
    probes: tuple[Probe, ...]


@dataclasses.dataclass(frozen=True)
class Selection:
    probe: Probe | None
    source: str
    changed_paths: tuple[str, ...]
    candidate_names: tuple[str, ...]
    discovery_note: str | None = None


@dataclasses.dataclass
class ProcessObservation:
    termination: str
    returncode: int | None
    duration_ms: int
    started_wall_ns: int
    output_bytes: int
    output_tail: str
    raw_output_tail: bytes = dataclasses.field(repr=False)
    output_truncated: bool
    hard_resource_hits: tuple[str, ...]
    suspected_resource_hits: tuple[str, ...]
    toolchain_hits: tuple[str, ...]
    gradle_outcomes: tuple[str, ...]
    spawn_errno: int | None = None
    spawn_message: str | None = None
    leaked_process_group: bool = False
    descendant_isolation: bool = False


@dataclasses.dataclass(frozen=True)
class TestEvidence:
    files: int
    tests: int
    failures: int
    errors: int
    skipped: int
    testcases: int
    source: str
    newest_mtime_ns: int

    @property
    def executed(self) -> int:
        return max(0, self.tests - self.skipped)


@dataclasses.dataclass(frozen=True)
class Decision:
    verdict: str
    check: str
    diagnosis: str
    confidence: str
    reason: str
    message: str
    next_action: str
    evidence: tuple[Mapping[str, Any], ...] = ()


def _reject_constant(value: str) -> None:
    raise ValueError(f"non-finite number {value!r} is not valid")


def _strict_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise DuplicateKeyProblem(f"duplicate JSON key {key!r}")
        result[key] = value
    return result


def _object(value: Any, where: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ConfigProblem(f"{where} must be an object")
    return value


def _unknown_keys(value: Mapping[str, Any], allowed: set[str], where: str) -> None:
    unknown = sorted(set(value) - allowed)
    if unknown:
        raise ConfigProblem(f"{where} has unknown key(s): {', '.join(unknown)}")


def _string(value: Any, where: str, *, nonempty: bool = True) -> str:
    if not isinstance(value, str):
        raise ConfigProblem(f"{where} must be a string")
    if nonempty and not value:
        raise ConfigProblem(f"{where} must not be empty")
    if "\x00" in value:
        raise ConfigProblem(f"{where} must not contain NUL")
    return value


def _bool(value: Any, where: str) -> bool:
    if type(value) is not bool:
        raise ConfigProblem(f"{where} must be a boolean")
    return value


def _int(value: Any, where: str, minimum: int, maximum: int) -> int:
    if type(value) is not int:
        raise ConfigProblem(f"{where} must be an integer")
    if not minimum <= value <= maximum:
        raise ConfigProblem(f"{where} must be between {minimum} and {maximum}")
    return value


def _number(value: Any, where: str, minimum: float, maximum: float) -> float:
    if type(value) not in (int, float):
        raise ConfigProblem(f"{where} must be a number")
    number = float(value)
    if not minimum <= number <= maximum:
        raise ConfigProblem(f"{where} must be between {minimum:g} and {maximum:g}")
    return number


def _string_list(value: Any, where: str, *, allow_empty: bool = True) -> tuple[str, ...]:
    if not isinstance(value, list):
        raise ConfigProblem(f"{where} must be an array")
    if not allow_empty and not value:
        raise ConfigProblem(f"{where} must not be empty")
    items = tuple(_string(item, f"{where}[{index}]") for index, item in enumerate(value))
    if len(items) != len(set(items)):
        raise ConfigProblem(f"{where} must not contain duplicates")
    return items


def _relative_path(value: str, where: str, *, pattern: bool = False) -> str:
    if "\\" in value:
        raise ConfigProblem(f"{where} must use '/' as the path separator")
    path = PurePosixPath(value)
    if path.is_absolute() or ".." in path.parts:
        raise ConfigProblem(f"{where} must stay inside the config root")
    if value in ("", "/"):
        raise ConfigProblem(f"{where} must not be empty")
    if not pattern and any(char in value for char in "*?["):
        raise ConfigProblem(f"{where} must not contain glob characters")
    return value[2:] if value.startswith("./") else value


def _load_limits(raw: Any) -> Limits:
    value = _object(raw, "limits")
    _unknown_keys(value, LIMIT_KEYS, "limits")
    timeout = _number(value.get("timeout_seconds", 90), "limits.timeout_seconds", 0.05, 86400)
    grace = _number(value.get("kill_grace_seconds", 1), "limits.kill_grace_seconds", 0.01, 30)
    maximum = _int(
        value.get("max_output_bytes", 4 * 1024 * 1024),
        "limits.max_output_bytes",
        1024,
        64 * 1024 * 1024,
    )
    tail = _int(
        value.get("output_tail_bytes", 64 * 1024),
        "limits.output_tail_bytes",
        256,
        min(maximum, 1024 * 1024),
    )
    memory = _int(value.get("min_free_memory_mb", 0), "limits.min_free_memory_mb", 0, 1024 * 1024)
    disk = _int(value.get("min_free_disk_mb", 0), "limits.min_free_disk_mb", 0, 1024 * 1024)
    return Limits(timeout, grace, maximum, tail, memory, disk)


def _load_probe(raw: Any, order: int, limits: Limits) -> Probe:
    where = f"probes[{order}]"
    value = _object(raw, where)
    _unknown_keys(value, PROBE_KEYS, where)
    for required in ("name", "kind", "scope", "argv"):
        if required not in value:
            raise ConfigProblem(f"{where}.{required} is required")

    name = _string(value["name"], f"{where}.name")
    if not NAME_RE.fullmatch(name):
        raise ConfigProblem(f"{where}.name must match {NAME_RE.pattern}")
    kind = _string(value["kind"], f"{where}.kind")
    if kind not in ("command", "gradle-test"):
        raise ConfigProblem(f"{where}.kind must be 'command' or 'gradle-test'")
    scope = _string(value["scope"], f"{where}.scope")
    if len(scope) > 500:
        raise ConfigProblem(f"{where}.scope must be at most 500 characters")
    argv = _string_list(value["argv"], f"{where}.argv", allow_empty=False)
    if len(argv) > 256:
        raise ConfigProblem(f"{where}.argv has too many arguments")
    cwd = _relative_path(_string(value.get("cwd", "."), f"{where}.cwd"), f"{where}.cwd")

    env_raw = _object(value.get("env", {}), f"{where}.env")
    env: dict[str, str] = {}
    for key, item in env_raw.items():
        if not ENV_NAME_RE.fullmatch(key):
            raise ConfigProblem(f"{where}.env has invalid variable name {key!r}")
        env[key] = _string(item, f"{where}.env.{key}", nonempty=False)

    changes = _string_list(value.get("changes", []), f"{where}.changes")
    changes = tuple(
        _relative_path(item, f"{where}.changes[{index}]", pattern=True)
        for index, item in enumerate(changes)
    )
    fallback = _bool(value.get("fallback", False), f"{where}.fallback")
    cost = _int(value.get("cost", 100), f"{where}.cost", 0, 1_000_000)
    timeout = _number(
        value.get("timeout_seconds", limits.timeout_seconds),
        f"{where}.timeout_seconds",
        0.05,
        limits.timeout_seconds,
    )

    raw_codes = value.get("success_codes", [0])
    if not isinstance(raw_codes, list) or not raw_codes:
        raise ConfigProblem(f"{where}.success_codes must be a non-empty array")
    codes = tuple(_int(item, f"{where}.success_codes[{i}]", 0, 255) for i, item in enumerate(raw_codes))
    if len(codes) != len(set(codes)):
        raise ConfigProblem(f"{where}.success_codes must not contain duplicates")

    gradle_task: str | None = None
    junit_xml: tuple[str, ...] = ()
    min_tests = 1
    evidence_mode = "gradle-cache-ok"
    expected_test_class: str | None = None
    expected_test_name: str | None = None
    gradle_fields = {
        "gradle_task", "junit_xml", "min_tests", "evidence_mode",
        "expected_test_class", "expected_test_name",
    }
    if kind == "command":
        present = sorted(gradle_fields.intersection(value))
        if present:
            raise ConfigProblem(f"{where} uses gradle-test-only key(s): {', '.join(present)}")
    else:
        if codes != (0,):
            raise ConfigProblem(f"{where}.success_codes must be [0] for a gradle-test")
        for required in ("gradle_task", "junit_xml", "expected_test_class"):
            if required not in value:
                raise ConfigProblem(f"{where}.{required} is required for a gradle-test")
        gradle_task = _string(value["gradle_task"], f"{where}.gradle_task")
        if not GRADLE_TASK_RE.fullmatch(gradle_task):
            raise ConfigProblem(f"{where}.gradle_task must be an exact fully-qualified task path")
        if gradle_task not in argv:
            raise ConfigProblem(f"{where}.argv must contain the exact gradle_task")
        if "--continue" in argv or "clean" in argv or any(arg.endswith(":clean") for arg in argv):
            raise ConfigProblem(f"{where}.argv must not use clean or --continue")
        if "-q" in argv or "--quiet" in argv:
            raise ConfigProblem(f"{where}.argv must not hide Gradle task evidence with --quiet")
        if "--no-daemon" not in argv or "--daemon" in argv:
            raise ConfigProblem(f"{where}.argv must use --no-daemon to close the probe's process boundary")
        plain_console = "--console=plain" in argv or any(
            argv[index:index + 2] == ("--console", "plain") for index in range(len(argv) - 1)
        )
        if not plain_console:
            raise ConfigProblem(f"{where}.argv must use --console=plain for deterministic task evidence")
        filters: list[str] = []
        for index, arg in enumerate(argv):
            if arg == "--tests":
                if index + 1 >= len(argv):
                    raise ConfigProblem(f"{where}.argv has --tests without a value")
                filters.append(argv[index + 1])
            elif arg.startswith("--tests="):
                filters.append(arg.partition("=")[2])
        if len(filters) != 1 or not filters[0]:
            raise ConfigProblem(f"{where}.argv must contain exactly one non-empty --tests filter")
        if "*" in filters[0] or "?" in filters[0]:
            raise ConfigProblem(f"{where}.argv --tests filter must identify one exact class or method")
        expected_test_class = _string(value["expected_test_class"], f"{where}.expected_test_class")
        expected_test_name_raw = value.get("expected_test_name")
        if expected_test_name_raw is not None:
            expected_test_name = _string(expected_test_name_raw, f"{where}.expected_test_name")
        expected_filter = expected_test_class + (
            f".{expected_test_name}" if expected_test_name is not None else ""
        )
        if filters[0] != expected_filter:
            raise ConfigProblem(
                f"{where}.argv --tests filter must equal expected_test_class"
                + (" + expected_test_name" if expected_test_name is not None else "")
            )
        junit_xml = _string_list(value["junit_xml"], f"{where}.junit_xml", allow_empty=False)
        junit_xml = tuple(
            _relative_path(item, f"{where}.junit_xml[{index}]", pattern=True)
            for index, item in enumerate(junit_xml)
        )
        min_tests = _int(value.get("min_tests", 1), f"{where}.min_tests", 1, 1_000_000)
        evidence_mode = _string(value.get("evidence_mode", "gradle-cache-ok"), f"{where}.evidence_mode")
        if evidence_mode not in ("gradle-cache-ok", "fresh"):
            raise ConfigProblem(f"{where}.evidence_mode must be 'gradle-cache-ok' or 'fresh'")
        if evidence_mode == "gradle-cache-ok" and any(
            any(char in pattern for char in "*?[") for pattern in junit_xml
        ):
            raise ConfigProblem(
                f"{where}.junit_xml must use exact files when cached evidence is allowed"
            )
        if evidence_mode == "fresh" and "--rerun" not in argv and "--rerun-tasks" not in argv:
            raise ConfigProblem(f"{where}.argv must use --rerun (or fallback --rerun-tasks) in fresh mode")

    return Probe(
        name=name,
        kind=kind,
        scope=scope,
        argv=argv,
        cwd=cwd,
        env=env,
        changes=changes,
        fallback=fallback,
        cost=cost,
        timeout_seconds=timeout,
        success_codes=codes,
        order=order,
        gradle_task=gradle_task,
        junit_xml=junit_xml,
        min_tests=min_tests,
        evidence_mode=evidence_mode,
        expected_test_class=expected_test_class,
        expected_test_name=expected_test_name,
    )


def load_config(path: Path | str) -> Config:
    config_path = Path(path).expanduser()
    try:
        raw_bytes = config_path.read_bytes()
    except OSError as exc:
        raise ConfigProblem(f"cannot read config {config_path}: {exc.strerror or exc}") from exc
    if len(raw_bytes) > CONFIG_SIZE_LIMIT:
        raise ConfigProblem(f"config is larger than {CONFIG_SIZE_LIMIT} bytes")
    try:
        text = raw_bytes.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ConfigProblem(f"config must be UTF-8: {exc}") from exc
    try:
        raw = json.loads(text, object_pairs_hook=_strict_object, parse_constant=_reject_constant)
    except (json.JSONDecodeError, DuplicateKeyProblem, ValueError, RecursionError) as exc:
        raise ConfigProblem(f"invalid JSON: {exc}") from exc

    value = _object(raw, "config")
    _unknown_keys(value, ROOT_KEYS, "config")
    if value.get("version") != SCHEMA_VERSION or type(value.get("version")) is not int:
        raise ConfigProblem(f"config.version must be the integer {SCHEMA_VERSION}")
    limits = _load_limits(value.get("limits", {}))
    probes_raw = value.get("probes")
    if not isinstance(probes_raw, list) or not probes_raw:
        raise ConfigProblem("config.probes must be a non-empty array")
    probes = tuple(_load_probe(item, index, limits) for index, item in enumerate(probes_raw))
    names = [probe.name for probe in probes]
    if len(names) != len(set(names)):
        duplicate = next(name for name in names if names.count(name) > 1)
        raise ConfigProblem(f"duplicate probe name {duplicate!r}")

    try:
        resolved_path = config_path.resolve(strict=True)
        root = resolved_path.parent.resolve(strict=True)
    except OSError as exc:
        raise ConfigProblem(f"cannot resolve config path: {exc}") from exc
    return Config(
        path=resolved_path,
        root=root,
        digest=hashlib.sha256(raw_bytes).hexdigest(),
        limits=limits,
        probes=probes,
    )


@lru_cache(maxsize=512)
def _glob_regex(pattern: str) -> re.Pattern[str]:
    """Translate the small documented glob dialect (*, **, ?) to a regex."""
    out: list[str] = ["^"]
    index = 0
    while index < len(pattern):
        char = pattern[index]
        if char == "*":
            if index + 1 < len(pattern) and pattern[index + 1] == "*":
                index += 2
                if index < len(pattern) and pattern[index] == "/":
                    out.append("(?:.*/)?")
                    index += 1
                else:
                    out.append(".*")
                continue
            out.append("[^/]*")
        elif char == "?":
            out.append("[^/]")
        else:
            out.append(re.escape(char))
        index += 1
    out.append("$")
    return re.compile("".join(out))


def path_matches(path: str, pattern: str) -> bool:
    return bool(_glob_regex(pattern).fullmatch(path))


def normalize_changed_path(value: str) -> str:
    normalized = value.replace("\\", "/")
    while normalized.startswith("./"):
        normalized = normalized[2:]
    path = PurePosixPath(normalized)
    if not normalized or path.is_absolute() or ".." in path.parts:
        raise ConfigProblem(f"changed path must stay inside the config root: {value!r}")
    return path.as_posix()


def select_probe(config: Config, changed_paths: Sequence[str], explicit: str | None = None,
                 discovery_note: str | None = None) -> Selection:
    normalized = tuple(dict.fromkeys(normalize_changed_path(path) for path in changed_paths))
    if explicit is not None:
        matches = [probe for probe in config.probes if probe.name == explicit]
        if not matches:
            raise ConfigProblem(f"unknown probe {explicit!r}")
        return Selection(matches[0], "explicit", normalized, (matches[0].name,), discovery_note)

    if normalized:
        candidates = [
            probe for probe in config.probes
            if any(path_matches(path, pattern) for path in normalized for pattern in probe.changes)
        ]
        source = "changed-path"
    else:
        candidates = [probe for probe in config.probes if probe.fallback]
        source = "fallback"
    ordered = sorted(candidates, key=lambda item: (item.cost, item.order, item.name))
    return Selection(
        ordered[0] if ordered else None,
        source,
        normalized,
        tuple(probe.name for probe in ordered),
        discovery_note,
    )


class OutputObserver:
    def __init__(self, gradle_task: str | None = None) -> None:
        self.gradle_task = gradle_task
        self._partial = bytearray()
        patterns = {**HARD_RESOURCE_PATTERNS, **SUSPECTED_RESOURCE_PATTERNS, **TOOLCHAIN_PATTERNS}
        self._patterns = patterns
        self._found: set[str] = set()
        self._carry = b""
        self._carry_size = max((len(item) for item in patterns.values()), default=1) - 1
        self.gradle_outcomes: list[str] = []

    def feed(self, data: bytes) -> None:
        lowered = self._carry + data.lower()
        for name, pattern in self._patterns.items():
            if name not in self._found and pattern in lowered:
                self._found.add(name)
        self._carry = lowered[-self._carry_size:] if self._carry_size else b""

        self._partial.extend(data)
        while True:
            newline = self._partial.find(b"\n")
            if newline < 0:
                break
            line = bytes(self._partial[:newline])
            del self._partial[:newline + 1]
            self._observe_line(line)
        if len(self._partial) > 16 * 1024:
            # Task evidence lines are tiny.  A huge line cannot be allowed to grow memory.
            self._partial = self._partial[-1024:]

    def finish(self) -> None:
        if self._partial:
            self._observe_line(bytes(self._partial))
            self._partial.clear()

    def _observe_line(self, raw: bytes) -> None:
        if not self.gradle_task:
            return
        text = ANSI_RE.sub("", raw.decode("utf-8", errors="replace").rstrip("\r"))
        match = TASK_LINE_RE.fullmatch(text)
        if match and match.group("task") == self.gradle_task:
            self.gradle_outcomes.append(match.group("outcome") or "EXECUTED")

    @property
    def hard_resource_hits(self) -> tuple[str, ...]:
        return tuple(name for name in HARD_RESOURCE_PATTERNS if name in self._found)

    @property
    def suspected_resource_hits(self) -> tuple[str, ...]:
        return tuple(name for name in SUSPECTED_RESOURCE_PATTERNS if name in self._found)

    @property
    def toolchain_hits(self) -> tuple[str, ...]:
        return tuple(name for name in TOOLCHAIN_PATTERNS if name in self._found)


def _sanitize_output(raw: bytes) -> str:
    text = ANSI_RE.sub("", raw.decode("utf-8", errors="replace"))
    return "".join(
        char if char in "\n\r\t" or ord(char) >= 32 else f"\\x{ord(char):02x}"
        for char in text
    )


def _enable_linux_subreaper() -> bool:
    """Adopt daemonized descendants so an isolated probe can close its process tree."""
    if not sys.platform.startswith("linux"):
        return False
    try:
        libc = ctypes.CDLL(None, use_errno=True)
        # Linux prctl(PR_SET_CHILD_SUBREAPER, 1). This is process-local and unprivileged.
        return libc.prctl(36, 1, 0, 0, 0) == 0
    except (AttributeError, OSError):
        return False


def _linux_descendants(root_pid: int) -> set[int]:
    if not sys.platform.startswith("linux"):
        return set()
    children: dict[int, list[int]] = {}
    try:
        entries = tuple(Path("/proc").iterdir())
    except OSError:
        return set()
    for entry in entries:
        if not entry.name.isdigit():
            continue
        try:
            raw = (entry / "stat").read_text(encoding="ascii")
            close = raw.rfind(")")
            fields = raw[close + 2:].split()
            pid = int(entry.name)
            ppid = int(fields[1])  # fields begin with state, then parent PID.
        except (OSError, ValueError, IndexError):
            continue
        children.setdefault(ppid, []).append(pid)
    result: set[int] = set()
    pending = list(children.get(root_pid, ()))
    while pending:
        pid = pending.pop()
        if pid in result:
            continue
        result.add(pid)
        pending.extend(children.get(pid, ()))
    return result


def _cleanup_detached_descendants(baseline: set[int], grace_seconds: float) -> set[int]:
    """Terminate descendants outside the original process group, then reap adoptees."""
    def current_after_reap() -> set[int]:
        current = _linux_descendants(os.getpid()) - baseline
        for pid in tuple(current):
            with contextlib.suppress(ChildProcessError, ProcessLookupError):
                os.waitpid(pid, os.WNOHANG)
        return _linux_descendants(os.getpid()) - baseline

    # A Gradle single-use daemon can outlive its client briefly while still shutting
    # down correctly. Give all descendants the configured TERM grace to leave cleanly.
    natural_deadline = time.monotonic() + grace_seconds
    current = current_after_reap()
    while current and time.monotonic() < natural_deadline:
        time.sleep(0.01)
        current = current_after_reap()
    if not current:
        return set()

    leaked = set(current)
    for pid in current:
        with contextlib.suppress(ProcessLookupError, PermissionError):
            os.kill(pid, signal.SIGTERM)
    deadline = time.monotonic() + grace_seconds
    while time.monotonic() < deadline:
        current = current_after_reap()
        leaked.update(current)
        if not current:
            break
        time.sleep(0.01)
    remaining = current_after_reap()
    leaked.update(remaining)
    for pid in remaining:
        with contextlib.suppress(ProcessLookupError, PermissionError):
            os.kill(pid, signal.SIGKILL)
    reap_deadline = time.monotonic() + 0.25
    while time.monotonic() < reap_deadline:
        if not current_after_reap():
            break
        time.sleep(0.01)
    return leaked


def _signal_process_group(process: subprocess.Popen[bytes], sig: int) -> None:
    try:
        if os.name == "posix":
            os.killpg(process.pid, sig)
        elif sig == signal.SIGTERM:
            process.terminate()
        else:  # pragma: no cover - Windows fallback
            process.kill()
    except ProcessLookupError:
        pass


def _process_group_alive(pgid: int) -> bool:
    if os.name != "posix":
        return False
    try:
        os.killpg(pgid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:  # It exists, even if an unusual platform denies signalling.
        return True


def _cleanup_group(process: subprocess.Popen[bytes], grace_seconds: float) -> None:
    if not _process_group_alive(process.pid):
        return
    _signal_process_group(process, signal.SIGTERM)
    deadline = time.monotonic() + grace_seconds
    while time.monotonic() < deadline and _process_group_alive(process.pid):
        time.sleep(0.01)
    if _process_group_alive(process.pid):
        _signal_process_group(process, signal.SIGKILL)


def execute_process(
    argv: Sequence[str],
    cwd: Path,
    env: Mapping[str, str],
    *,
    timeout_seconds: float,
    kill_grace_seconds: float,
    max_output_bytes: int,
    output_tail_bytes: int,
    gradle_task: str | None = None,
) -> ProcessObservation:
    started_mono = time.monotonic()
    started_wall_ns = time.time_ns()
    observer = OutputObserver(gradle_task)
    descendant_isolation = _enable_linux_subreaper()
    descendant_baseline = _linux_descendants(os.getpid()) if descendant_isolation else set()
    try:
        process = subprocess.Popen(
            list(argv),
            cwd=cwd,
            env=dict(env),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            shell=False,
            start_new_session=(os.name == "posix"),
        )
    except OSError as exc:
        return ProcessObservation(
            termination="spawn_error",
            returncode=None,
            duration_ms=round((time.monotonic() - started_mono) * 1000),
            started_wall_ns=started_wall_ns,
            output_bytes=0,
            output_tail="",
            raw_output_tail=b"",
            output_truncated=False,
            hard_resource_hits=(),
            suspected_resource_hits=(),
            toolchain_hits=(),
            gradle_outcomes=(),
            spawn_errno=exc.errno,
            spawn_message=exc.strerror or str(exc),
            descendant_isolation=descendant_isolation,
        )

    assert process.stdout is not None
    descriptor = process.stdout.fileno()
    os.set_blocking(descriptor, False)
    selector = selectors.DefaultSelector()
    selector.register(descriptor, selectors.EVENT_READ)
    tail = bytearray()
    output_bytes = 0
    forced: str | None = None
    force_started: float | None = None
    kill_sent = False
    parent_done_at: float | None = None
    leaked = False

    def force(reason: str) -> None:
        nonlocal forced, force_started
        if forced is None:
            forced = reason
            force_started = time.monotonic()
            _signal_process_group(process, signal.SIGTERM)

    try:
        while True:
            now = time.monotonic()
            returncode = process.poll()
            if returncode is not None and parent_done_at is None:
                parent_done_at = now
            if returncode is None and forced is None and now - started_mono >= timeout_seconds:
                force("timeout")
            if forced is not None and process.poll() is None and force_started is not None:
                if not kill_sent and now - force_started >= kill_grace_seconds:
                    _signal_process_group(process, signal.SIGKILL)
                    kill_sent = True

            events = selector.select(0.05)
            for key, _ in events:
                try:
                    data = os.read(key.fd, 8192)
                except BlockingIOError:
                    continue
                if not data:
                    with contextlib.suppress(Exception):
                        selector.unregister(key.fd)
                    continue
                output_bytes += len(data)
                observer.feed(data)
                tail.extend(data)
                if len(tail) > output_tail_bytes:
                    del tail[:-output_tail_bytes]
                if output_bytes > max_output_bytes and forced is None:
                    force("output_limit")

            returncode = process.poll()
            if returncode is not None:
                if not selector.get_map():
                    break
                if parent_done_at is not None and time.monotonic() - parent_done_at >= 0.25:
                    leaked = True
                    force("leaked_process_group")
                    if force_started is not None and time.monotonic() - force_started >= kill_grace_seconds + 0.25:
                        break
            if forced is not None and force_started is not None:
                if time.monotonic() - force_started >= kill_grace_seconds + 1.0 and process.poll() is not None:
                    break
    except KeyboardInterrupt:
        force("cancelled")
        _signal_process_group(process, signal.SIGKILL)
    finally:
        with contextlib.suppress(Exception):
            selector.close()
        with contextlib.suppress(Exception):
            process.stdout.close()
        if process.poll() is None:
            _signal_process_group(process, signal.SIGKILL)
        with contextlib.suppress(subprocess.TimeoutExpired):
            process.wait(timeout=max(0.25, kill_grace_seconds))
        if _process_group_alive(process.pid):
            leaked = True
            if forced is None:
                forced = "leaked_process_group"
            _cleanup_group(process, kill_grace_seconds)
        if descendant_isolation:
            detached = _cleanup_detached_descendants(descendant_baseline, kill_grace_seconds)
            if detached:
                leaked = True
                if forced is None:
                    forced = "leaked_process_group"
        observer.finish()

    duration_ms = round((time.monotonic() - started_mono) * 1000)
    return ProcessObservation(
        termination=forced or ("signal" if (process.returncode or 0) < 0 else "completed"),
        returncode=process.returncode,
        duration_ms=duration_ms,
        started_wall_ns=started_wall_ns,
        output_bytes=output_bytes,
        output_tail=_sanitize_output(bytes(tail)),
        raw_output_tail=bytes(tail),
        output_truncated=output_bytes > output_tail_bytes,
        hard_resource_hits=observer.hard_resource_hits,
        suspected_resource_hits=observer.suspected_resource_hits,
        toolchain_hits=observer.toolchain_hits,
        gradle_outcomes=tuple(observer.gradle_outcomes),
        leaked_process_group=leaked,
        descendant_isolation=descendant_isolation,
    )


def _within(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def prepare_probe(config: Config, probe: Probe) -> tuple[Path, dict[str, str], str]:
    try:
        cwd = (config.root / probe.cwd).resolve(strict=True)
    except OSError as exc:
        raise ConfigProblem(f"probe {probe.name!r} cwd cannot be resolved: {exc}") from exc
    if not cwd.is_dir() or not _within(cwd, config.root):
        raise ConfigProblem(f"probe {probe.name!r} cwd escapes the config root or is not a directory")

    environment = os.environ.copy()
    environment.update(probe.env)
    executable = probe.argv[0]
    if "/" in executable:
        candidate = Path(executable)
        if not candidate.is_absolute():
            try:
                candidate = (cwd / candidate).resolve(strict=True)
            except OSError as exc:
                raise ConfigProblem(f"probe executable {executable!r} cannot be resolved: {exc}") from exc
            if not _within(candidate, config.root):
                raise ConfigProblem(f"relative probe executable {executable!r} escapes the config root")
        if not candidate.is_file() or not os.access(candidate, os.X_OK):
            raise ConfigProblem(f"probe executable {executable!r} is not an executable file")
        resolved_executable = str(candidate)
    else:
        found = shutil.which(executable, path=environment.get("PATH"))
        if found is None:
            raise ConfigProblem(f"probe executable {executable!r} was not found on PATH")
        resolved_executable = found
    return cwd, environment, resolved_executable


def read_host_snapshot(path: Path) -> dict[str, Any]:
    memory_mb: int | None = None
    try:
        for line in Path("/proc/meminfo").read_text(encoding="ascii").splitlines():
            if line.startswith("MemAvailable:"):
                memory_mb = int(line.split()[1]) // 1024
                break
    except (OSError, ValueError, IndexError):
        pass
    try:
        disk_mb: int | None = shutil.disk_usage(path).free // (1024 * 1024)
    except OSError:
        disk_mb = None
    return {"memory_available_mb": memory_mb, "disk_free_mb": disk_mb}


def read_cgroup_memory_events() -> dict[str, int] | None:
    if os.name != "posix":
        return None
    try:
        relative: str | None = None
        for line in Path("/proc/self/cgroup").read_text(encoding="ascii").splitlines():
            if line.startswith("0::"):
                relative = line.partition("0::")[2].lstrip("/")
                break
        if relative is None:
            return None
        event_path = Path("/sys/fs/cgroup") / relative / "memory.events"
        result: dict[str, int] = {}
        for line in event_path.read_text(encoding="ascii").splitlines():
            name, raw_value = line.split()
            result[name] = int(raw_value)
        return result
    except (OSError, ValueError):
        return None


def cgroup_delta(before: Mapping[str, int] | None, after: Mapping[str, int] | None) -> dict[str, int]:
    if before is None or after is None:
        return {}
    return {
        key: after.get(key, 0) - before.get(key, 0)
        for key in ("oom", "oom_kill")
        if after.get(key, 0) - before.get(key, 0) > 0
    }


class RepoLock:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.handle: int | None = None
        self.holder: str | None = None
        self.error: str | None = None
        self.supported = fcntl is not None

    def __enter__(self) -> "RepoLock":
        if fcntl is None:  # pragma: no cover - non-POSIX fallback
            return self
        uid = getattr(os, "getuid", lambda: 0)()
        try:
            lock_dir = Path(tempfile.gettempdir()) / f"loopprobe-{uid}"
            lock_dir.mkdir(mode=0o700, parents=False, exist_ok=True)
            stat = lock_dir.stat()
            if stat.st_uid != uid or stat.st_mode & 0o077:
                raise ConfigProblem(f"unsafe lock directory permissions: {lock_dir}")
            digest = hashlib.sha256(os.fsencode(str(self.root))).hexdigest()[:32]
            lock_path = lock_dir / f"{digest}.lock"
            flags = os.O_RDWR | os.O_CREAT
            flags |= getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
            self.handle = os.open(lock_path, flags, 0o600)
        except (OSError, ConfigProblem) as exc:
            self.error = str(exc)
            if self.handle is not None:
                with contextlib.suppress(OSError):
                    os.close(self.handle)
                self.handle = None
            return self
        try:
            fcntl.flock(self.handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            os.lseek(self.handle, 0, os.SEEK_SET)
            self.holder = os.read(self.handle, 64).decode("ascii", errors="replace").strip() or "unknown"
            return self
        except OSError as exc:
            self.error = str(exc)
            with contextlib.suppress(OSError):
                os.close(self.handle)
            self.handle = None
            return self
        os.ftruncate(self.handle, 0)
        os.write(self.handle, str(os.getpid()).encode("ascii"))
        return self

    @property
    def acquired(self) -> bool:
        return self.error is None and (
            not self.supported or (self.handle is not None and self.holder is None)
        )

    def __exit__(self, exc_type: Any, exc: Any, traceback: Any) -> None:
        if self.handle is not None:
            if fcntl is not None and self.holder is None:
                with contextlib.suppress(OSError):
                    fcntl.flock(self.handle, fcntl.LOCK_UN)
            with contextlib.suppress(OSError):
                os.close(self.handle)
            self.handle = None


def _glob_test_files(config: Config, probe: Probe) -> list[Path]:
    matches: dict[str, Path] = {}
    for pattern in probe.junit_xml:
        for raw in glob.iglob(str(config.root / pattern), recursive=True):
            candidate = Path(raw)
            try:
                resolved = candidate.resolve(strict=True)
            except OSError:
                continue
            if not _within(resolved, config.root):
                raise ConfigProblem(f"JUnit evidence path escapes config root: {candidate}")
            if resolved.is_file():
                matches[str(resolved)] = resolved
            if len(matches) > XML_FILE_LIMIT:
                raise ConfigProblem(f"JUnit evidence matched more than {XML_FILE_LIMIT} files")
    return [matches[key] for key in sorted(matches)]


def _xml_counts(path: Path, expected_class: str, expected_name: str | None) -> tuple[int, int, int, int, int]:
    try:
        root = ET.parse(path).getroot()
    except (ET.ParseError, OSError) as exc:
        raise ConfigProblem(f"cannot parse JUnit XML {path}: {exc}") from exc

    def attributes(element: ET.Element) -> tuple[int, int, int, int]:
        values: list[int] = []
        for name in ("tests", "failures", "errors", "skipped"):
            raw = element.attrib.get(name, "0")
            try:
                parsed = int(raw)
            except ValueError as exc:
                raise ConfigProblem(f"JUnit XML {path} has non-integer {name}={raw!r}") from exc
            if parsed < 0:
                raise ConfigProblem(f"JUnit XML {path} has negative {name}")
            values.append(parsed)
        return values[0], values[1], values[2], values[3]

    tag = root.tag.rsplit("}", 1)[-1]
    if tag == "testsuite":
        aggregate = attributes(root)
    elif tag == "testsuites":
        if "tests" in root.attrib:
            aggregate = attributes(root)
        else:
            totals = [0, 0, 0, 0]
            for child in root:
                if child.tag.rsplit("}", 1)[-1] == "testsuite":
                    for index, count in enumerate(attributes(child)):
                        totals[index] += count
            aggregate = (totals[0], totals[1], totals[2], totals[3])
    else:
        raise ConfigProblem(f"JUnit XML {path} root must be testsuite or testsuites")

    cases = [element for element in root.iter() if element.tag.rsplit("}", 1)[-1] == "testcase"]
    for case in cases:
        classname = case.attrib.get("classname")
        name = case.attrib.get("name")
        if classname != expected_class:
            raise ConfigProblem(
                f"JUnit XML {path} testcase classname {classname!r} does not match {expected_class!r}"
            )
        if not name:
            raise ConfigProblem(f"JUnit XML {path} testcase is missing its name")
        if expected_name is not None and name != expected_name:
            raise ConfigProblem(
                f"JUnit XML {path} testcase name {name!r} does not match {expected_name!r}"
            )
    observed = (
        len(cases),
        sum(any(child.tag.rsplit("}", 1)[-1] == "failure" for child in case) for case in cases),
        sum(any(child.tag.rsplit("}", 1)[-1] == "error" for child in case) for case in cases),
        sum(any(child.tag.rsplit("}", 1)[-1] == "skipped" for child in case) for case in cases),
    )
    if aggregate != observed:
        raise ConfigProblem(
            f"JUnit XML {path} aggregate counts {aggregate} do not match testcase evidence {observed}"
        )
    return aggregate[0], aggregate[1], aggregate[2], aggregate[3], len(cases)


def snapshot_test_files(config: Config, probe: Probe) -> dict[str, tuple[int, int, int, int]]:
    """Capture cheap metadata so current evidence cannot be confused with stale XML."""
    snapshot: dict[str, tuple[int, int, int, int]] = {}
    for path in _glob_test_files(config, probe):
        try:
            stat = path.stat()
        except OSError as exc:
            raise ConfigProblem(f"cannot inspect JUnit evidence {path}: {exc}") from exc
        snapshot[str(path)] = (stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns)
    return snapshot


def collect_test_evidence(config: Config, probe: Probe, observation: ProcessObservation,
                          outcome: str,
                          before: Mapping[str, tuple[int, int, int, int]]) -> TestEvidence:
    files = _glob_test_files(config, probe)
    current_required = outcome in ("EXECUTED", "FAILED") or probe.evidence_mode == "fresh"
    if current_required:
        current: list[Path] = []
        for path in files:
            try:
                stat = path.stat()
            except OSError as exc:
                raise ConfigProblem(f"cannot inspect JUnit evidence {path}: {exc}") from exc
            identity = (stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns)
            if before.get(str(path)) != identity:
                current.append(path)
        files = current
    if not files:
        qualifier = "current-run " if current_required else ""
        raise ConfigProblem(f"no {qualifier}JUnit XML matched the configured patterns")

    total_bytes = 0
    totals = [0, 0, 0, 0, 0]
    newest = 0
    for path in files:
        try:
            stat = path.stat()
        except OSError as exc:
            raise ConfigProblem(f"cannot inspect JUnit evidence {path}: {exc}") from exc
        total_bytes += stat.st_size
        newest = max(newest, stat.st_mtime_ns)
        if total_bytes > XML_BYTES_LIMIT:
            raise ConfigProblem(f"JUnit evidence is larger than {XML_BYTES_LIMIT} bytes")
        assert probe.expected_test_class is not None
        for index, count in enumerate(_xml_counts(path, probe.expected_test_class, probe.expected_test_name)):
            totals[index] += count
    source = "reused" if outcome in ("UP-TO-DATE", "FROM-CACHE") else "current"
    return TestEvidence(len(files), totals[0], totals[1], totals[2], totals[3], totals[4], source, newest)


def _abnormal_decision(observation: ProcessObservation, cgroup_changes: Mapping[str, int],
                       success_codes: Sequence[int]) -> Decision | None:
    hard_resource = bool(observation.hard_resource_hits)
    oom_event = bool(cgroup_changes.get("oom_kill") or cgroup_changes.get("oom"))
    resource_evidence: list[Mapping[str, Any]] = []
    if observation.hard_resource_hits:
        resource_evidence.append({"type": "resource-signature", "ids": list(observation.hard_resource_hits)})
    if cgroup_changes:
        resource_evidence.append({"type": "cgroup-memory-events", "delta": dict(cgroup_changes)})

    if observation.termination == "spawn_error":
        resource_errnos = {errno.ENOMEM, errno.ENOSPC, errno.EMFILE, errno.ENFILE}
        category = "resource" if observation.spawn_errno in resource_errnos else "toolchain"
        return Decision(
            "ERROR", "unknown", category, "confirmed", "spawn_error",
            f"probe could not start: {observation.spawn_message or 'unknown spawn error'}",
            "Fix the execution environment; do not change product behavior yet.",
            ({"type": "spawn-error", "errno": observation.spawn_errno},),
        )
    if observation.termination == "timeout":
        category = "resource" if hard_resource else "unknown"
        confidence = "confirmed" if hard_resource else ("suspected" if observation.suspected_resource_hits else "none")
        return Decision(
            "ERROR", "unknown", category, confidence, "timeout",
            "the monotonic deadline expired before the probe completed",
            "Shrink the probe or fix the environment; never treat this as a product counterexample.",
            tuple(resource_evidence),
        )
    if observation.termination == "output_limit":
        return Decision(
            "ERROR", "unknown", "resource", "confirmed", "output_limit",
            "the probe exceeded its output budget",
            "Reduce noisy output or narrow the probe before retrying.",
            ({"type": "output-budget", "bytes": observation.output_bytes},),
        )
    if observation.termination == "cancelled":
        return Decision(
            "ERROR", "unknown", "unknown", "none", "cancelled",
            "the probe was cancelled by the user",
            "Run the same probe again when ready.",
        )
    if observation.termination == "leaked_process_group":
        return Decision(
            "ERROR", "unknown", "probe", "confirmed", "leaked_process_group",
            "the probe returned while a descendant process was still alive",
            "Make the probe wait for and clean up every child process.",
            ({"type": "process-group", "cleaned": True},),
        )
    if observation.termination == "signal" or (observation.returncode is not None and observation.returncode < 0):
        if hard_resource:
            category, confidence = "resource", "confirmed"
        elif oom_event:
            category, confidence = "resource", "suspected"
        else:
            category, confidence = "unknown", "none"
        return Decision(
            "ERROR", "unknown", category, confidence, "signal",
            f"the probe was terminated by signal {-observation.returncode if observation.returncode else 'unknown'}",
            "Inspect host/process evidence; a signal alone is not proof of OOM or a code defect.",
            tuple(resource_evidence),
        )
    if hard_resource and observation.returncode is not None and observation.returncode not in success_codes:
        return Decision(
            "ERROR", "unknown", "resource", "confirmed", "resource_failure",
            "the probe reported a concrete resource failure",
            "Relieve the named resource pressure, then rerun the same probe.",
            tuple(resource_evidence),
        )
    return None


def classify_command(probe: Probe, observation: ProcessObservation,
                     cgroup_changes: Mapping[str, int]) -> Decision:
    abnormal = _abnormal_decision(observation, cgroup_changes, probe.success_codes)
    if abnormal:
        return abnormal
    assert observation.returncode is not None
    if observation.returncode in probe.success_codes:
        return Decision(
            "PASS", "pass", "none", "none", "contract_satisfied",
            "the selected command completed and satisfied its exit-code contract",
            "Keep this scope explicit; expand to the next-smallest claim only if needed.",
            ({"type": "exit-code", "actual": observation.returncode, "accepted": list(probe.success_codes)},),
        )
    return Decision(
        "FAIL", "fail", "code", "confirmed", "contract_refuted",
        f"the command exited {observation.returncode}; accepted codes are {list(probe.success_codes)}",
        "Change the behavior or its narrowly scoped test, then rerun this exact probe.",
        ({"type": "exit-code", "actual": observation.returncode, "accepted": list(probe.success_codes)},),
    )


def _single_gradle_outcome(observation: ProcessObservation) -> str:
    outcomes = list(dict.fromkeys(observation.gradle_outcomes))
    if not outcomes:
        raise ConfigProblem("the configured Gradle task produced no current invocation evidence")
    if len(outcomes) > 1:
        # FAILED after EXECUTED is Gradle's normal rendering of one failed task.
        if set(outcomes) == {"EXECUTED", "FAILED"}:
            return "FAILED"
        raise ConfigProblem(f"the Gradle task produced contradictory outcomes: {outcomes}")
    return outcomes[0]


def classify_gradle_test(config: Config, probe: Probe, observation: ProcessObservation,
                         cgroup_changes: Mapping[str, int],
                         evidence_before: Mapping[str, tuple[int, int, int, int]]) -> Decision:
    abnormal = _abnormal_decision(observation, cgroup_changes, probe.success_codes)
    if abnormal:
        return abnormal
    assert observation.returncode is not None
    try:
        outcome = _single_gradle_outcome(observation)
    except ConfigProblem as exc:
        diagnosis = "toolchain" if observation.toolchain_hits else "probe"
        confidence = "confirmed" if observation.toolchain_hits else "suspected"
        evidence: tuple[Mapping[str, Any], ...] = ()
        if observation.toolchain_hits:
            evidence = ({"type": "toolchain-signature", "ids": list(observation.toolchain_hits)},)
        return Decision(
            "ERROR", "unknown", diagnosis, confidence, "no_task_evidence",
            str(exc),
            "Fix the exact task/toolchain contract; do not call this a functional failure.",
            evidence,
        )
    if outcome in ("NO-SOURCE", "SKIPPED"):
        return Decision(
            "ERROR", "unknown", "probe", "confirmed", "empty_or_skipped_test",
            f"the configured Gradle test task was {outcome}",
            "Add an executable test source or correct the task/variant/filter.",
            ({"type": "gradle-task", "task": probe.gradle_task, "outcome": outcome},),
        )
    if probe.evidence_mode == "fresh" and outcome in ("UP-TO-DATE", "FROM-CACHE"):
        return Decision(
            "ERROR", "unknown", "probe", "confirmed", "fresh_evidence_missing",
            f"fresh evidence was required but Gradle reported {outcome}",
            "Verify --rerun support/placement and rerun the same fresh probe.",
            ({"type": "gradle-task", "task": probe.gradle_task, "outcome": outcome},),
        )
    try:
        tests = collect_test_evidence(config, probe, observation, outcome, evidence_before)
    except ConfigProblem as exc:
        return Decision(
            "ERROR", "unknown", "probe", "confirmed", "junit_evidence_missing",
            str(exc),
            "Correct the report glob or ensure this invocation emits non-stale JUnit XML.",
            ({"type": "gradle-task", "task": probe.gradle_task, "outcome": outcome},),
        )
    test_evidence: Mapping[str, Any] = {
        "type": "junit",
        "source": tests.source,
        "files": tests.files,
        "tests": tests.tests,
        "testcases": tests.testcases,
        "executed": tests.executed,
        "failures": tests.failures,
        "errors": tests.errors,
        "skipped": tests.skipped,
    }
    task_evidence: Mapping[str, Any] = {
        "type": "gradle-task", "task": probe.gradle_task, "outcome": outcome
    }
    if tests.executed < probe.min_tests:
        return Decision(
            "ERROR", "unknown", "probe", "confirmed", "zero_or_too_few_tests",
            f"only {tests.executed} test(s) executed; at least {probe.min_tests} are required",
            "Correct the test filter/suite so the required functional cases actually execute.",
            (task_evidence, test_evidence),
        )

    has_failure = tests.failures > 0 or tests.errors > 0
    exit_success = observation.returncode in probe.success_codes
    if exit_success and (has_failure or outcome == "FAILED"):
        return Decision(
            "ERROR", "unknown", "probe", "confirmed", "contradictory_test_evidence",
            "Gradle exit, task outcome, and JUnit evidence contradict one another",
            "Resolve the inconsistent runner/report contract before changing product code.",
            (task_evidence, test_evidence),
        )
    if not exit_success and tests.errors > 0:
        return Decision(
            "ERROR", "unknown", "probe", "confirmed", "test_execution_error",
            f"JUnit recorded {tests.errors} test execution error(s), so the functional claim is unknown",
            "Fix the fixture/runner/runtime error, then rerun the same functional probe.",
            (task_evidence, test_evidence),
        )
    if not exit_success and tests.failures > 0:
        return Decision(
            "FAIL", "fail", "code", "confirmed", "test_failure",
            f"{tests.failures} assertion failure(s) were observed",
            "Change the behavior or this exact contract, then rerun the same probe.",
            (task_evidence, test_evidence),
        )
    if not exit_success:
        diagnosis = "toolchain" if observation.toolchain_hits else "code"
        confidence = "confirmed" if observation.toolchain_hits else "suspected"
        extra: list[Mapping[str, Any]] = [task_evidence, test_evidence]
        if observation.toolchain_hits:
            extra.append({"type": "toolchain-signature", "ids": list(observation.toolchain_hits)})
        return Decision(
            "ERROR", "unknown", diagnosis, confidence, "gradle_probe_incomplete",
            "Gradle failed without a JUnit functional counterexample",
            "Inspect the failing build/toolchain task; the functional claim is still unknown.",
            tuple(extra),
        )
    return Decision(
        "PASS", "pass", "none", "none", "test_contract_satisfied",
        f"{tests.executed} test(s) executed with no failures ({tests.source} evidence)",
        "Keep the stated scope; use the explicit fresh probe when stronger evidence is needed.",
        (task_evidence, test_evidence),
    )


def _run_id() -> str:
    return str(uuid.uuid4())


def _utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def error_report(reason: str, message: str, *, diagnosis: str = "probe",
                 confidence: str = "confirmed", next_action: str = "Fix the reported error and retry.",
                 config: Config | None = None, selection: Selection | None = None,
                 probe: Probe | None = None, started_at: str | None = None,
                 duration_ms: int = 0, evidence: Sequence[Mapping[str, Any]] = ()) -> dict[str, Any]:
    return {
        "schema": SCHEMA_VERSION,
        "run_id": _run_id(),
        "verdict": "ERROR",
        "check": "unknown",
        "termination": "not_started",
        "diagnosis": {"category": diagnosis, "confidence": confidence},
        "reason": reason,
        "message": message,
        "next_action": next_action,
        "scope": probe.scope if probe else None,
        "probe": _probe_json(probe),
        "selection": _selection_json(selection),
        "config": {"path": str(config.path), "sha256": config.digest} if config else None,
        "timing": {"started_at": started_at or _utc_now(), "duration_ms": duration_ms},
        "process": None,
        "host": None,
        "evidence": list(evidence),
        "output_tail": "",
    }


def _probe_json(probe: Probe | None) -> Mapping[str, Any] | None:
    if probe is None:
        return None
    result: dict[str, Any] = {
        "name": probe.name,
        "kind": probe.kind,
        "scope": probe.scope,
        "argv": list(probe.argv),
        "cwd": probe.cwd,
        "cost": probe.cost,
        "timeout_seconds": probe.timeout_seconds,
        "environment_keys": sorted(probe.env),
    }
    if probe.kind == "gradle-test":
        result.update({
            "gradle_task": probe.gradle_task,
            "expected_test_class": probe.expected_test_class,
            "expected_test_name": probe.expected_test_name,
            "junit_xml": list(probe.junit_xml),
            "min_tests": probe.min_tests,
            "evidence_mode": probe.evidence_mode,
        })
    return result


def _selection_json(selection: Selection | None) -> Mapping[str, Any] | None:
    if selection is None:
        return None
    return {
        "source": selection.source,
        "changed_paths": list(selection.changed_paths),
        "candidates": list(selection.candidate_names),
        "discovery_note": selection.discovery_note,
    }


def _process_json(observation: ProcessObservation) -> Mapping[str, Any]:
    return {
        "exit_code": observation.returncode if observation.returncode is not None and observation.returncode >= 0 else None,
        "signal": -observation.returncode if observation.returncode is not None and observation.returncode < 0 else None,
        "output_bytes": observation.output_bytes,
        "output_truncated": observation.output_truncated,
        "spawn_errno": observation.spawn_errno,
        "leaked_process_group": observation.leaked_process_group,
        "descendant_isolation": observation.descendant_isolation,
    }


def run_probe(config: Config, selection: Selection) -> dict[str, Any]:
    started_at = _utc_now()
    started_mono = time.monotonic()
    probe = selection.probe
    if probe is None:
        return error_report(
            "no_matching_probe",
            "no probe matches the known changed paths, and no fallback is applicable",
            diagnosis="probe",
            next_action="Add an exact path mapping or select a probe explicitly.",
            config=config,
            selection=selection,
            started_at=started_at,
        )
    try:
        cwd, environment, resolved_executable = prepare_probe(config, probe)
    except ConfigProblem as exc:
        return error_report(
            "preflight_error", str(exc), diagnosis="toolchain",
            next_action="Fix the executable/cwd environment; do not edit product behavior yet.",
            config=config, selection=selection, probe=probe, started_at=started_at,
            duration_ms=round((time.monotonic() - started_mono) * 1000),
        )

    before = read_host_snapshot(cwd)
    if config.limits.min_free_memory_mb and before["memory_available_mb"] is not None:
        if before["memory_available_mb"] < config.limits.min_free_memory_mb:
            return error_report(
                "insufficient_memory",
                f"only {before['memory_available_mb']} MiB memory is available; "
                f"{config.limits.min_free_memory_mb} MiB is required",
                diagnosis="resource", next_action="Free memory or lower the measured project-specific floor.",
                config=config, selection=selection, probe=probe, started_at=started_at,
                evidence=({"type": "host-preflight", **before},),
            )
    if config.limits.min_free_disk_mb and before["disk_free_mb"] is not None:
        if before["disk_free_mb"] < config.limits.min_free_disk_mb:
            return error_report(
                "insufficient_disk",
                f"only {before['disk_free_mb']} MiB disk is free; {config.limits.min_free_disk_mb} MiB is required",
                diagnosis="resource", next_action="Free disk space or lower the measured project-specific floor.",
                config=config, selection=selection, probe=probe, started_at=started_at,
                evidence=({"type": "host-preflight", **before},),
            )

    with RepoLock(config.root) as lock:
        if not lock.acquired:
            if lock.error is not None:
                return error_report(
                    "lock_error", f"repository lock is unavailable: {lock.error}",
                    diagnosis="toolchain",
                    next_action="Fix the local runtime/temp-directory permissions, then retry.",
                    config=config, selection=selection, probe=probe, started_at=started_at,
                )
            return error_report(
                "busy",
                f"another LoopProbe process holds this repository lock (pid {lock.holder})",
                diagnosis="resource", next_action="Wait for that single probe to finish; do not start a competing build.",
                config=config, selection=selection, probe=probe, started_at=started_at,
                evidence=({"type": "repo-lock", "holder": lock.holder},),
            )
        try:
            evidence_before = snapshot_test_files(config, probe) if probe.kind == "gradle-test" else {}
        except ConfigProblem as exc:
            return error_report(
                "junit_preflight_error", str(exc), diagnosis="probe",
                next_action="Narrow the JUnit evidence paths to files inside this repository.",
                config=config, selection=selection, probe=probe, started_at=started_at,
            )
        cgroup_before = read_cgroup_memory_events()
        observation = execute_process(
            probe.argv,
            cwd,
            environment,
            timeout_seconds=probe.timeout_seconds,
            kill_grace_seconds=config.limits.kill_grace_seconds,
            max_output_bytes=config.limits.max_output_bytes,
            output_tail_bytes=config.limits.output_tail_bytes,
            gradle_task=probe.gradle_task,
        )
        cgroup_after = read_cgroup_memory_events()
        changes = cgroup_delta(cgroup_before, cgroup_after)
        if probe.kind == "command":
            decision = classify_command(probe, observation, changes)
        else:
            # Keep XML collection and classification under the same repository lock as
            # execution. A competing LoopProbe must not replace our evidence in between.
            decision = classify_gradle_test(config, probe, observation, changes, evidence_before)
        after = read_host_snapshot(cwd)
    host = {
        "before": before,
        "after": after,
        "cgroup_memory_events_delta": changes or None,
    }
    evidence = list(decision.evidence)
    evidence.append({"type": "executable", "resolved": resolved_executable})
    return {
        "schema": SCHEMA_VERSION,
        "run_id": _run_id(),
        "verdict": decision.verdict,
        "check": decision.check,
        "termination": observation.termination,
        "diagnosis": {"category": decision.diagnosis, "confidence": decision.confidence},
        "reason": decision.reason,
        "message": decision.message,
        "next_action": decision.next_action,
        "scope": probe.scope,
        "probe": _probe_json(probe),
        "selection": _selection_json(selection),
        "config": {"path": str(config.path), "sha256": config.digest},
        "timing": {"started_at": started_at, "duration_ms": observation.duration_ms},
        "process": _process_json(observation),
        "host": host,
        "evidence": evidence,
        "output_tail": observation.output_tail,
    }


def discover_git_changes(config: Config) -> tuple[tuple[str, ...], str]:
    git = shutil.which("git")
    if git is None:
        return (), "git unavailable; fallback selection used"
    environment = os.environ.copy()
    top_observation = execute_process(
        [git, "-C", str(config.root), "rev-parse", "--show-toplevel"],
        config.root,
        environment,
        timeout_seconds=2.0,
        kill_grace_seconds=0.2,
        max_output_bytes=16 * 1024,
        output_tail_bytes=16 * 1024,
    )
    if top_observation.termination != "completed" or top_observation.returncode != 0:
        if top_observation.termination == "cancelled":
            raise KeyboardInterrupt
        return (), "git top-level discovery unavailable; fallback selection used"
    try:
        git_root = Path(top_observation.raw_output_tail.decode("utf-8").strip()).resolve(strict=True)
        relative_root = config.root.relative_to(git_root)
    except (UnicodeDecodeError, OSError, ValueError):
        return (), "config root is outside the discovered Git worktree; fallback selection used"
    prefix = relative_root.as_posix()
    if prefix == ".":
        prefix = ""
    observation = execute_process(
        [git, "-C", str(git_root), "status", "--porcelain=v1", "-z", "--untracked-files=all"],
        config.root,
        environment,
        timeout_seconds=2.0,
        kill_grace_seconds=0.2,
        max_output_bytes=GIT_OUTPUT_LIMIT,
        output_tail_bytes=GIT_OUTPUT_LIMIT,
    )
    if observation.termination != "completed" or observation.returncode != 0:
        if observation.termination == "cancelled":
            raise KeyboardInterrupt
        return (), f"git change discovery unavailable ({observation.termination}); fallback selection used"
    raw = observation.raw_output_tail
    if observation.output_truncated:
        return (), "git change list exceeded its budget; fallback selection used"
    entries = raw.split(b"\x00")
    changed: list[str] = []
    index = 0
    try:
        while index < len(entries):
            entry = entries[index]
            index += 1
            if not entry:
                continue
            if len(entry) < 4:
                raise ValueError("short porcelain entry")
            status = entry[:2].decode("ascii")
            record_paths = [entry[3:].decode("utf-8")]
            if "R" in status or "C" in status:
                if index >= len(entries):
                    raise ValueError("rename without source")
                record_paths.append(entries[index].decode("utf-8"))
                index += 1
            for path in record_paths:
                if prefix:
                    if path.startswith(prefix + "/"):
                        path = path[len(prefix) + 1:]
                    else:
                        continue
                changed.append(normalize_changed_path(path))
    except (UnicodeDecodeError, ValueError, ConfigProblem):
        return (), "git change list could not be parsed; fallback selection used"
    return tuple(dict.fromkeys(changed)), "changed paths discovered with git"


def _emit(payload: Mapping[str, Any], as_json: bool) -> None:
    if as_json:
        json.dump(payload, sys.stdout, ensure_ascii=False, indent=2, sort_keys=True)
        sys.stdout.write("\n")
        return
    verdict = payload.get("verdict", "INFO")
    probe = payload.get("probe") or {}
    name = probe.get("name", "-")
    scope = payload.get("scope") or "no functional scope"
    duration = ((payload.get("timing") or {}).get("duration_ms") or 0) / 1000
    print(f"{verdict}  {name}  {duration:.3f}s  {scope}")
    if payload.get("message"):
        print(f"reason: {payload.get('reason')}: {payload.get('message')}")
    if payload.get("next_action"):
        print(f"next: {payload.get('next_action')}")
    tail = payload.get("output_tail")
    if tail and verdict != "PASS":
        print("output tail:")
        print(str(tail).rstrip())


def _exit_for_report(report: Mapping[str, Any]) -> int:
    if report.get("reason") == "cancelled":
        return EXIT_CANCELLED
    return {"PASS": EXIT_PASS, "FAIL": EXIT_FAIL, "ERROR": EXIT_ERROR}.get(
        str(report.get("verdict")), EXIT_ERROR
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="loopprobe.py",
        description="Run one bounded probe and emit PASS, FAIL, or ERROR without guessing.",
    )
    parser.add_argument("--config", default=".loopprobe.json", help="strict JSON config (default: .loopprobe.json)")
    parser.add_argument("--version", action="version", version=f"LoopProbe {PROGRAM_VERSION}")
    subparsers = parser.add_subparsers(dest="command", required=True)

    validate = subparsers.add_parser("validate", help="validate the complete config without running a probe")
    validate.add_argument("--json", action="store_true", help="emit machine-readable JSON")

    for command in ("select", "run"):
        child = subparsers.add_parser(command, help=f"{command} the cheapest applicable probe")
        child.add_argument("--probe", help="select one probe explicitly")
        child.add_argument("--changed", action="append", default=None, metavar="PATH",
                           help="authoritative changed path; repeat as needed")
        child.add_argument("--no-git", action="store_true", help="do not discover changed paths with git")
        child.add_argument("--json", action="store_true", help="emit machine-readable JSON")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        config = load_config(args.config)
    except ConfigProblem as exc:
        report = error_report("invalid_config", str(exc), diagnosis="probe")
        _emit(report, bool(getattr(args, "json", False)))
        return EXIT_ERROR

    if args.command == "validate":
        payload = {
            "schema": SCHEMA_VERSION,
            "valid": True,
            "config": {"path": str(config.path), "sha256": config.digest},
            "probes": [probe.name for probe in config.probes],
        }
        if args.json:
            json.dump(payload, sys.stdout, ensure_ascii=False, indent=2, sort_keys=True)
            sys.stdout.write("\n")
        else:
            print(f"VALID  {len(config.probes)} probe(s)  {config.digest[:12]}")
        return EXIT_PASS

    try:
        if args.changed is not None:
            changed = tuple(args.changed)
            note = "changed paths supplied explicitly"
        elif args.probe is not None:
            changed = ()
            note = "explicit probe selection skipped Git discovery"
        elif args.no_git:
            changed = ()
            note = "git discovery disabled; fallback selection used"
        else:
            changed, note = discover_git_changes(config)
    except KeyboardInterrupt:
        report = error_report(
            "cancelled", "change discovery was cancelled by the user",
            diagnosis="unknown", confidence="none", config=config,
            next_action="Run the same command again when ready.",
        )
        report["termination"] = "cancelled"
        _emit(report, args.json)
        return EXIT_CANCELLED
    try:
        selection = select_probe(config, changed, args.probe, note)
    except ConfigProblem as exc:
        report = error_report("selection_error", str(exc), config=config)
        _emit(report, args.json)
        return EXIT_ERROR

    if args.command == "select":
        if selection.probe is None:
            report = error_report(
                "no_matching_probe", "no probe matched", config=config, selection=selection,
                next_action="Add a path mapping, fallback probe, or explicit --probe.",
            )
            _emit(report, args.json)
            return EXIT_ERROR
        payload = {
            "schema": SCHEMA_VERSION,
            "selected": _probe_json(selection.probe),
            "selection": _selection_json(selection),
        }
        if args.json:
            json.dump(payload, sys.stdout, ensure_ascii=False, indent=2, sort_keys=True)
            sys.stdout.write("\n")
        else:
            print(f"SELECTED  {selection.probe.name}  cost={selection.probe.cost}  {selection.probe.scope}")
        return EXIT_PASS

    report = run_probe(config, selection)
    _emit(report, args.json)
    return _exit_for_report(report)


if __name__ == "__main__":
    raise SystemExit(main())
