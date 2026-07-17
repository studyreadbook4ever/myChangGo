from __future__ import annotations

import contextlib
import io
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

import loopprobe


TASK = ":app:testDebugUnitTest"
FILTER = "com.example.LoopProofTest"


def command_probe(argv: list[str], **overrides: object) -> dict[str, object]:
    probe: dict[str, object] = {
        "name": "tiny-command",
        "kind": "command",
        "scope": "one exact command contract",
        "argv": argv,
        "cwd": ".",
        "changes": ["src/**"],
        "fallback": True,
        "cost": 1,
        "timeout_seconds": 2,
        "success_codes": [0],
    }
    probe.update(overrides)
    return probe


def gradle_probe(script: str, **overrides: object) -> dict[str, object]:
    argv = ["python3", "-c", script, "--no-daemon", "--console=plain", TASK, "--tests", FILTER]
    probe: dict[str, object] = {
        "name": "logic-test",
        "kind": "gradle-test",
        "scope": "one exact domain rule",
        "argv": argv,
        "cwd": ".",
        "changes": ["app/src/main/**/*.kt", "app/src/test/**/*.kt"],
        "fallback": True,
        "cost": 1,
        "timeout_seconds": 2,
        "success_codes": [0],
        "gradle_task": TASK,
        "junit_xml": ["build/test-results/TEST-proof.xml"],
        "min_tests": 1,
        "evidence_mode": "gradle-cache-ok",
        "expected_test_class": FILTER,
    }
    probe.update(overrides)
    return probe


def config_document(probes: list[dict[str, object]], **limit_overrides: object) -> dict[str, object]:
    limits: dict[str, object] = {
        "timeout_seconds": 3,
        "kill_grace_seconds": 0.05,
        "max_output_bytes": 128 * 1024,
        "output_tail_bytes": 4096,
        "min_free_memory_mb": 0,
        "min_free_disk_mb": 0,
    }
    limits.update(limit_overrides)
    return {"version": 1, "limits": limits, "probes": probes}


class TempProject(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory(prefix="loopprobe-test-")
        self.root = Path(self.tempdir.name)
        self.config_path = self.root / ".loopprobe.json"

    def tearDown(self) -> None:
        self.tempdir.cleanup()

    def write_config(self, probes: list[dict[str, object]], **limits: object) -> loopprobe.Config:
        self.config_path.write_text(
            json.dumps(config_document(probes, **limits), ensure_ascii=False), encoding="utf-8"
        )
        return loopprobe.load_config(self.config_path)

    def run_one(self, config: loopprobe.Config, name: str | None = None) -> dict[str, object]:
        selection = loopprobe.select_probe(config, (), name)
        return loopprobe.run_probe(config, selection)


class StrictConfigTests(TempProject):
    def test_valid_minimal_command_config(self) -> None:
        config = self.write_config([command_probe(["python3", "-c", "pass"])])
        self.assertEqual([probe.name for probe in config.probes], ["tiny-command"])

    def test_duplicate_json_key_is_rejected(self) -> None:
        self.config_path.write_text('{"version":1,"version":1,"probes":[]}', encoding="utf-8")
        with self.assertRaisesRegex(loopprobe.ConfigProblem, "duplicate JSON key"):
            loopprobe.load_config(self.config_path)

    def test_unknown_key_is_rejected(self) -> None:
        document = config_document([command_probe(["python3", "-c", "pass"])])
        document["typo"] = True
        self.config_path.write_text(json.dumps(document), encoding="utf-8")
        with self.assertRaisesRegex(loopprobe.ConfigProblem, "unknown key"):
            loopprobe.load_config(self.config_path)

    def test_empty_probe_array_is_rejected(self) -> None:
        self.config_path.write_text(json.dumps(config_document([])), encoding="utf-8")
        with self.assertRaisesRegex(loopprobe.ConfigProblem, "non-empty array"):
            loopprobe.load_config(self.config_path)

    def test_duplicate_probe_name_is_rejected(self) -> None:
        first = command_probe(["python3", "-c", "pass"])
        second = dict(first)
        self.config_path.write_text(json.dumps(config_document([first, second])), encoding="utf-8")
        with self.assertRaisesRegex(loopprobe.ConfigProblem, "duplicate probe"):
            loopprobe.load_config(self.config_path)

    def test_boolean_is_not_accepted_as_integer(self) -> None:
        probe = command_probe(["python3", "-c", "pass"], cost=True)
        self.config_path.write_text(json.dumps(config_document([probe])), encoding="utf-8")
        with self.assertRaisesRegex(loopprobe.ConfigProblem, "must be an integer"):
            loopprobe.load_config(self.config_path)

    def test_empty_argv_is_rejected(self) -> None:
        probe = command_probe([])
        self.config_path.write_text(json.dumps(config_document([probe])), encoding="utf-8")
        with self.assertRaisesRegex(loopprobe.ConfigProblem, "must not be empty"):
            loopprobe.load_config(self.config_path)

    def test_parent_cwd_is_rejected(self) -> None:
        probe = command_probe(["python3", "-c", "pass"], cwd="../outside")
        self.config_path.write_text(json.dumps(config_document([probe])), encoding="utf-8")
        with self.assertRaisesRegex(loopprobe.ConfigProblem, "inside the config root"):
            loopprobe.load_config(self.config_path)

    def test_gradle_test_requires_exact_filter(self) -> None:
        probe = gradle_probe("pass")
        argv = list(probe["argv"])
        argv[-1] = "com.example.*"
        probe["argv"] = argv
        self.config_path.write_text(json.dumps(config_document([probe])), encoding="utf-8")
        with self.assertRaisesRegex(loopprobe.ConfigProblem, "one exact class"):
            loopprobe.load_config(self.config_path)

    def test_fresh_gradle_probe_requires_rerun(self) -> None:
        probe = gradle_probe("pass", evidence_mode="fresh")
        self.config_path.write_text(json.dumps(config_document([probe])), encoding="utf-8")
        with self.assertRaisesRegex(loopprobe.ConfigProblem, "must use --rerun"):
            loopprobe.load_config(self.config_path)

    def test_cached_gradle_evidence_requires_exact_xml_paths(self) -> None:
        probe = gradle_probe("pass", junit_xml=["build/test-results/TEST-*.xml"])
        self.config_path.write_text(json.dumps(config_document([probe])), encoding="utf-8")
        with self.assertRaisesRegex(loopprobe.ConfigProblem, "must use exact files"):
            loopprobe.load_config(self.config_path)

    def test_gradle_probe_requires_plain_visible_task_output(self) -> None:
        probe = gradle_probe("pass")
        probe["argv"] = [arg for arg in probe["argv"] if arg != "--console=plain"]
        self.config_path.write_text(json.dumps(config_document([probe])), encoding="utf-8")
        with self.assertRaisesRegex(loopprobe.ConfigProblem, "must use --console=plain"):
            loopprobe.load_config(self.config_path)

    def test_gradle_probe_rejects_quiet_mode(self) -> None:
        probe = gradle_probe("pass")
        probe["argv"] = [*probe["argv"], "--quiet"]
        self.config_path.write_text(json.dumps(config_document([probe])), encoding="utf-8")
        with self.assertRaisesRegex(loopprobe.ConfigProblem, "must not hide"):
            loopprobe.load_config(self.config_path)

    def test_gradle_probe_requires_closed_daemon_boundary(self) -> None:
        probe = gradle_probe("pass")
        probe["argv"] = [arg for arg in probe["argv"] if arg != "--no-daemon"]
        self.config_path.write_text(json.dumps(config_document([probe])), encoding="utf-8")
        with self.assertRaisesRegex(loopprobe.ConfigProblem, "must use --no-daemon"):
            loopprobe.load_config(self.config_path)


class SelectionTests(TempProject):
    def setUp(self) -> None:
        super().setUp()
        low = command_probe(["python3", "-c", "pass"], name="nested", cost=3,
                            changes=["app/src/main/**/*.kt"])
        high = command_probe(["python3", "-c", "pass"], name="broad", cost=9,
                             changes=["app/**"])
        fallback = command_probe(["python3", "-c", "pass"], name="fallback", cost=1,
                                 changes=[], fallback=True)
        low["fallback"] = False
        high["fallback"] = False
        self.config = self.write_config([high, low, fallback])

    def test_double_star_matches_zero_directories(self) -> None:
        selected = loopprobe.select_probe(self.config, ["app/src/main/Foo.kt"])
        self.assertEqual(selected.probe.name, "nested")

    def test_double_star_matches_nested_directories(self) -> None:
        selected = loopprobe.select_probe(self.config, ["app/src/main/java/x/Foo.kt"])
        self.assertEqual(selected.probe.name, "nested")

    def test_cheapest_matching_probe_wins_deterministically(self) -> None:
        selected = loopprobe.select_probe(self.config, ["app/src/main/x/Foo.kt"])
        self.assertEqual(selected.candidate_names, ("nested", "broad"))

    def test_fallback_only_applies_when_changes_are_unknown_or_empty(self) -> None:
        self.assertEqual(loopprobe.select_probe(self.config, ()).probe.name, "fallback")
        self.assertIsNone(loopprobe.select_probe(self.config, ["docs/readme.md"]).probe)

    def test_explicit_probe_has_priority(self) -> None:
        selected = loopprobe.select_probe(self.config, ["app/src/main/Foo.kt"], "broad")
        self.assertEqual(selected.probe.name, "broad")
        self.assertEqual(selected.source, "explicit")

    def test_unknown_explicit_probe_is_an_error(self) -> None:
        with self.assertRaisesRegex(loopprobe.ConfigProblem, "unknown probe"):
            loopprobe.select_probe(self.config, (), "missing")


class CommandMachineTests(TempProject):
    def test_exit_zero_is_pass(self) -> None:
        config = self.write_config([command_probe(["python3", "-c", "print('ok')"])])
        result = self.run_one(config)
        self.assertEqual((result["verdict"], result["check"]), ("PASS", "pass"))

    def test_unaccepted_exit_is_fail(self) -> None:
        config = self.write_config([command_probe(["python3", "-c", "raise SystemExit(7)"])])
        result = self.run_one(config)
        self.assertEqual((result["verdict"], result["check"], result["reason"]),
                         ("FAIL", "fail", "contract_refuted"))

    def test_configured_nonzero_exit_can_pass(self) -> None:
        config = self.write_config([
            command_probe(["python3", "-c", "raise SystemExit(7)"], success_codes=[7])
        ])
        self.assertEqual(self.run_one(config)["verdict"], "PASS")

    def test_accepted_nonzero_exit_is_not_overridden_by_diagnostic_text(self) -> None:
        script = "print('java.lang.OutOfMemoryError'); raise SystemExit(7)"
        config = self.write_config([
            command_probe(["python3", "-c", script], success_codes=[7])
        ])
        self.assertEqual(self.run_one(config)["verdict"], "PASS")

    def test_success_marker_before_nonzero_does_not_false_pass(self) -> None:
        config = self.write_config([
            command_probe(["python3", "-c", "print('SUCCESS'); raise SystemExit(9)"])
        ])
        self.assertEqual(self.run_one(config)["verdict"], "FAIL")

    def test_missing_executable_is_error_not_skip_or_pass(self) -> None:
        config = self.write_config([command_probe(["definitely-not-a-real-loopprobe-command"])])
        result = self.run_one(config)
        self.assertEqual((result["verdict"], result["reason"]), ("ERROR", "preflight_error"))

    def test_non_executable_repo_file_is_error(self) -> None:
        tool = self.root / "tool"
        tool.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
        tool.chmod(0o644)
        config = self.write_config([command_probe(["./tool"])])
        self.assertEqual(self.run_one(config)["verdict"], "ERROR")

    def test_timeout_is_error_and_not_fail(self) -> None:
        probe = command_probe(["python3", "-c", "import time; time.sleep(10)"], timeout_seconds=0.12)
        config = self.write_config([probe])
        result = self.run_one(config)
        self.assertEqual((result["verdict"], result["check"], result["reason"]),
                         ("ERROR", "unknown", "timeout"))

    def test_keyboard_interrupt_cancels_and_cleans_probe(self) -> None:
        config = self.write_config([
            command_probe(["python3", "-c", "import time; time.sleep(10)"])
        ])
        with mock.patch.object(loopprobe.selectors.DefaultSelector, "select", side_effect=KeyboardInterrupt):
            result = self.run_one(config)
        self.assertEqual((result["verdict"], result["reason"], loopprobe._exit_for_report(result)),
                         ("ERROR", "cancelled", loopprobe.EXIT_CANCELLED))

    @unittest.skipUnless(os.name == "posix", "process-group assertion is POSIX-specific")
    def test_timeout_kills_grandchild_before_it_can_write(self) -> None:
        sentinel = self.root / "too-late.txt"
        child = (
            "import time; from pathlib import Path; "
            f"time.sleep(0.5); Path({str(sentinel)!r}).write_text('escaped')"
        )
        parent = (
            "import subprocess,sys,time; "
            f"subprocess.Popen([sys.executable,'-c',{child!r}]); time.sleep(10)"
        )
        config = self.write_config([
            command_probe(["python3", "-c", parent], timeout_seconds=0.12)
        ])
        result = self.run_one(config)
        self.assertEqual(result["reason"], "timeout")
        time.sleep(0.65)
        self.assertFalse(sentinel.exists())

    @unittest.skipUnless(sys.platform.startswith("linux"), "subreaper assertion is Linux-specific")
    def test_detached_grandchild_cannot_escape_a_successful_probe(self) -> None:
        sentinel = self.root / "detached-too-late.txt"
        child = (
            "import time; from pathlib import Path; "
            f"time.sleep(0.5); Path({str(sentinel)!r}).write_text('escaped')"
        )
        parent = (
            "import subprocess,sys; "
            f"subprocess.Popen([sys.executable,'-c',{child!r}], start_new_session=True, "
            "stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)"
        )
        config = self.write_config([command_probe(["python3", "-c", parent])])
        result = self.run_one(config)
        self.assertEqual((result["verdict"], result["reason"]),
                         ("ERROR", "leaked_process_group"))
        self.assertTrue(result["process"]["descendant_isolation"])
        time.sleep(0.65)
        self.assertFalse(sentinel.exists())

    @unittest.skipUnless(sys.platform.startswith("linux"), "subreaper assertion is Linux-specific")
    def test_short_lived_single_use_child_can_shutdown_during_grace(self) -> None:
        child = "import time; time.sleep(0.05)"
        parent = (
            "import subprocess,sys; "
            f"subprocess.Popen([sys.executable,'-c',{child!r}], start_new_session=True, "
            "stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)"
        )
        config = self.write_config(
            [command_probe(["python3", "-c", parent])], kill_grace_seconds=0.3
        )
        result = self.run_one(config)
        self.assertEqual((result["verdict"], result["termination"]), ("PASS", "completed"))

    def test_output_flood_is_bounded_error(self) -> None:
        script = "import os; os.write(1, b'SUCCESS\\n' + b'x' * 200000)"
        config = self.write_config(
            [command_probe(["python3", "-c", script])],
            max_output_bytes=4096,
            output_tail_bytes=512,
        )
        result = self.run_one(config)
        self.assertEqual((result["verdict"], result["reason"]), ("ERROR", "output_limit"))
        self.assertLessEqual(len(result["output_tail"].encode("utf-8")), 512)

    @unittest.skipUnless(os.name == "posix", "signal assertion is POSIX-specific")
    def test_signal_is_unknown_not_oom_or_fail(self) -> None:
        script = "import os,signal; os.kill(os.getpid(), signal.SIGKILL)"
        config = self.write_config([command_probe(["python3", "-c", script])])
        result = self.run_one(config)
        self.assertEqual((result["verdict"], result["reason"]), ("ERROR", "signal"))
        self.assertNotEqual(result["diagnosis"]["confidence"], "confirmed")

    def test_canonical_oom_is_resource_error(self) -> None:
        script = "import sys; print('java.lang.OutOfMemoryError', file=sys.stderr); raise SystemExit(1)"
        config = self.write_config([command_probe(["python3", "-c", script])])
        result = self.run_one(config)
        self.assertEqual((result["verdict"], result["diagnosis"]["category"]),
                         ("ERROR", "resource"))

    @unittest.skipUnless(Path("/proc/meminfo").exists(), "MemAvailable preflight is Linux-specific")
    def test_memory_floor_blocks_before_probe_start(self) -> None:
        available = loopprobe.read_host_snapshot(self.root)["memory_available_mb"]
        if available is None or available >= 1024 * 1024:
            self.skipTest("cannot set a representable floor above current MemAvailable")
        floor = min(1024 * 1024, available + 64 * 1024)
        marker = self.root / "must-not-run"
        script = f"from pathlib import Path; Path({str(marker)!r}).write_text('ran')"
        config = self.write_config(
            [command_probe(["python3", "-c", script])], min_free_memory_mb=floor
        )
        result = self.run_one(config)
        self.assertEqual((result["verdict"], result["reason"]),
                         ("ERROR", "insufficient_memory"))
        self.assertFalse(marker.exists())

    def test_shell_metacharacters_are_literal_arguments(self) -> None:
        marker = self.root / "must-not-exist"
        literal = f"$(touch {marker})"
        script = f"import sys; raise SystemExit(0 if sys.argv[1] == {literal!r} else 4)"
        config = self.write_config([command_probe(["python3", "-c", script, literal])])
        result = self.run_one(config)
        self.assertEqual(result["verdict"], "PASS")
        self.assertFalse(marker.exists())

    def test_relative_executable_symlink_escape_is_rejected(self) -> None:
        outside = Path(self.tempdir.name).parent / f"outside-{os.getpid()}"
        outside.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
        outside.chmod(0o755)
        try:
            (self.root / "escaped-tool").symlink_to(outside)
            config = self.write_config([command_probe(["./escaped-tool"])])
            result = self.run_one(config)
            self.assertEqual(result["verdict"], "ERROR")
            self.assertIn("escapes", result["message"])
        finally:
            outside.unlink(missing_ok=True)

    def test_cwd_symlink_escape_is_rejected(self) -> None:
        outside = Path(self.tempdir.name).parent
        (self.root / "escape").symlink_to(outside, target_is_directory=True)
        config = self.write_config([command_probe(["python3", "-c", "pass"], cwd="escape")])
        self.assertEqual(self.run_one(config)["verdict"], "ERROR")

    def test_runner_has_no_pass_cache(self) -> None:
        counter = self.root / "counter"
        script = (
            "from pathlib import Path; "
            f"p=Path({str(counter)!r}); n=int(p.read_text()) if p.exists() else 0; p.write_text(str(n+1))"
        )
        config = self.write_config([command_probe(["python3", "-c", script])])
        self.assertEqual(self.run_one(config)["verdict"], "PASS")
        self.assertEqual(self.run_one(config)["verdict"], "PASS")
        self.assertEqual(counter.read_text(encoding="utf-8"), "2")

    def test_read_only_unicode_repo_does_not_block_runner_bookkeeping(self) -> None:
        unicode_root = self.root / "공백 있는 저장소"
        unicode_root.mkdir()
        config_path = unicode_root / ".loopprobe.json"
        config_path.write_text(
            json.dumps(config_document([command_probe(["python3", "-c", "pass"])])), encoding="utf-8"
        )
        config = loopprobe.load_config(config_path)
        unicode_root.chmod(0o555)
        try:
            result = loopprobe.run_probe(config, loopprobe.select_probe(config, ()))
            self.assertEqual(result["verdict"], "PASS")
        finally:
            unicode_root.chmod(0o755)

    def test_repo_lock_rejects_competing_invocation(self) -> None:
        with loopprobe.RepoLock(self.root) as first:
            self.assertTrue(first.acquired)
            with loopprobe.RepoLock(self.root) as second:
                self.assertFalse(second.acquired)


class GradleEvidenceTests(TempProject):
    @staticmethod
    def script_for(xml: str | None, *, outcome: str = "EXECUTED", exit_code: int = 0) -> str:
        task_line = f"> Task {TASK}" + ("" if outcome == "EXECUTED" else f" {outcome}")
        pieces = ["from pathlib import Path", f"print({task_line!r}, flush=True)"]
        if xml is not None:
            pieces.extend([
                "p=Path('build/test-results/TEST-proof.xml')",
                "p.parent.mkdir(parents=True, exist_ok=True)",
                f"p.write_text({xml!r}, encoding='utf-8')",
            ])
        pieces.append(f"raise SystemExit({exit_code})")
        return "; ".join(pieces)

    def test_current_nonempty_junit_evidence_passes(self) -> None:
        xml = f'<testsuite tests="1" failures="0" errors="0" skipped="0"><testcase classname="{FILTER}" name="proof"/></testsuite>'
        config = self.write_config([gradle_probe(self.script_for(xml))])
        result = self.run_one(config)
        self.assertEqual((result["verdict"], result["reason"]),
                         ("PASS", "test_contract_satisfied"))
        junit = next(item for item in result["evidence"] if item["type"] == "junit")
        self.assertEqual((junit["executed"], junit["source"]), (1, "current"))

    def test_no_source_is_never_pass(self) -> None:
        config = self.write_config([gradle_probe(self.script_for(None, outcome="NO-SOURCE"))])
        result = self.run_one(config)
        self.assertEqual((result["verdict"], result["reason"]),
                         ("ERROR", "empty_or_skipped_test"))

    def test_skipped_is_never_pass(self) -> None:
        config = self.write_config([gradle_probe(self.script_for(None, outcome="SKIPPED"))])
        self.assertEqual(self.run_one(config)["verdict"], "ERROR")

    def test_zero_tests_is_never_pass(self) -> None:
        xml = '<testsuite tests="0" failures="0" errors="0" skipped="0"/>'
        config = self.write_config([gradle_probe(self.script_for(xml))])
        result = self.run_one(config)
        self.assertEqual((result["verdict"], result["reason"]),
                         ("ERROR", "zero_or_too_few_tests"))

    def test_all_skipped_tests_are_never_pass(self) -> None:
        xml = (
            f'<testsuite tests="2" failures="0" errors="0" skipped="2">'
            f'<testcase classname="{FILTER}" name="first"><skipped/></testcase>'
            f'<testcase classname="{FILTER}" name="second"><skipped/></testcase></testsuite>'
        )
        config = self.write_config([gradle_probe(self.script_for(xml))])
        self.assertEqual(self.run_one(config)["reason"], "zero_or_too_few_tests")

    def test_failing_current_junit_is_functional_fail(self) -> None:
        xml = f'<testsuite tests="1" failures="1" errors="0" skipped="0"><testcase classname="{FILTER}" name="proof"><failure/></testcase></testsuite>'
        config = self.write_config([gradle_probe(self.script_for(xml, outcome="FAILED", exit_code=1))])
        result = self.run_one(config)
        self.assertEqual((result["verdict"], result["check"], result["reason"]),
                         ("FAIL", "fail", "test_failure"))

    def test_success_exit_with_failure_xml_is_inconsistent_error(self) -> None:
        xml = f'<testsuite tests="1" failures="1" errors="0" skipped="0"><testcase classname="{FILTER}" name="proof"><failure/></testcase></testsuite>'
        config = self.write_config([gradle_probe(self.script_for(xml, exit_code=0))])
        result = self.run_one(config)
        self.assertEqual((result["verdict"], result["reason"]),
                         ("ERROR", "contradictory_test_evidence"))

    def test_failed_task_with_success_exit_is_inconsistent_error(self) -> None:
        xml = f'<testsuite tests="1" failures="0" errors="0" skipped="0"><testcase classname="{FILTER}" name="proof"/></testsuite>'
        config = self.write_config([gradle_probe(self.script_for(xml, outcome="FAILED", exit_code=0))])
        result = self.run_one(config)
        self.assertEqual((result["verdict"], result["reason"]),
                         ("ERROR", "contradictory_test_evidence"))

    def test_wrong_test_class_cannot_satisfy_exact_filter(self) -> None:
        xml = '<testsuite tests="1" failures="0" errors="0" skipped="0"><testcase classname="com.example.UnrelatedTest" name="proof"/></testsuite>'
        config = self.write_config([gradle_probe(self.script_for(xml))])
        result = self.run_one(config)
        self.assertEqual((result["verdict"], result["reason"]),
                         ("ERROR", "junit_evidence_missing"))
        self.assertIn("does not match", result["message"])

    def test_aggregate_count_without_testcase_is_not_evidence(self) -> None:
        xml = '<testsuite tests="1" failures="0" errors="0" skipped="0"/>'
        config = self.write_config([gradle_probe(self.script_for(xml))])
        result = self.run_one(config)
        self.assertEqual((result["verdict"], result["reason"]),
                         ("ERROR", "junit_evidence_missing"))
        self.assertIn("do not match testcase evidence", result["message"])

    def test_junit_error_is_unknown_not_functional_counterexample(self) -> None:
        xml = f'<testsuite tests="1" failures="0" errors="1" skipped="0"><testcase classname="{FILTER}" name="proof"><error/></testcase></testsuite>'
        config = self.write_config([gradle_probe(self.script_for(xml, outcome="FAILED", exit_code=1))])
        result = self.run_one(config)
        self.assertEqual((result["verdict"], result["check"], result["reason"]),
                         ("ERROR", "unknown", "test_execution_error"))

    def test_expected_test_name_is_checked_when_configured(self) -> None:
        xml = f'<testsuite tests="1" failures="0" errors="0" skipped="0"><testcase classname="{FILTER}" name="otherRule"/></testsuite>'
        probe = gradle_probe(self.script_for(xml), expected_test_name="proof")
        argv = list(probe["argv"])
        argv[-1] = f"{FILTER}.proof"
        probe["argv"] = argv
        config = self.write_config([probe])
        result = self.run_one(config)
        self.assertEqual(result["verdict"], "ERROR")
        self.assertIn("testcase name", result["message"])

    def test_evidence_classification_remains_inside_repo_lock(self) -> None:
        xml = f'<testsuite tests="1" failures="0" errors="0" skipped="0"><testcase classname="{FILTER}" name="proof"/></testsuite>'
        config = self.write_config([gradle_probe(self.script_for(xml))])
        entered = threading.Event()
        release = threading.Event()
        original = loopprobe.collect_test_evidence

        def blocked_collect(*args: object, **kwargs: object) -> loopprobe.TestEvidence:
            entered.set()
            self.assertTrue(release.wait(2))
            return original(*args, **kwargs)

        result: dict[str, object] = {}
        with mock.patch.object(loopprobe, "collect_test_evidence", side_effect=blocked_collect):
            thread = threading.Thread(target=lambda: result.update(self.run_one(config)), daemon=True)
            thread.start()
            self.assertTrue(entered.wait(2))
            with loopprobe.RepoLock(self.root) as competing:
                self.assertFalse(competing.acquired)
            release.set()
            thread.join(2)
        self.assertFalse(thread.is_alive())
        self.assertEqual(result["verdict"], "PASS")

    def test_nonzero_without_test_counterexample_is_error(self) -> None:
        xml = f'<testsuite tests="1" failures="0" errors="0" skipped="0"><testcase classname="{FILTER}" name="proof"/></testsuite>'
        config = self.write_config([gradle_probe(self.script_for(xml, outcome="FAILED", exit_code=1))])
        result = self.run_one(config)
        self.assertEqual((result["verdict"], result["check"]), ("ERROR", "unknown"))

    def test_up_to_date_evidence_is_pass_but_marked_reused(self) -> None:
        report = self.root / "build/test-results/TEST-proof.xml"
        report.parent.mkdir(parents=True)
        report.write_text(
            f'<testsuite tests="1" failures="0" errors="0" skipped="0"><testcase classname="{FILTER}" name="proof"/></testsuite>',
            encoding="utf-8",
        )
        config = self.write_config([gradle_probe(self.script_for(None, outcome="UP-TO-DATE"))])
        result = self.run_one(config)
        self.assertEqual(result["verdict"], "PASS")
        junit = next(item for item in result["evidence"] if item["type"] == "junit")
        self.assertEqual(junit["source"], "reused")

    def test_fresh_mode_rejects_cached_outcome(self) -> None:
        report = self.root / "build/test-results/TEST-proof.xml"
        report.parent.mkdir(parents=True)
        report.write_text('<testsuite tests="1" failures="0" errors="0" skipped="0"/>', encoding="utf-8")
        probe = gradle_probe(self.script_for(None, outcome="FROM-CACHE"), evidence_mode="fresh")
        argv = list(probe["argv"])
        argv.append("--rerun")
        probe["argv"] = argv
        config = self.write_config([probe])
        result = self.run_one(config)
        self.assertEqual((result["verdict"], result["reason"]),
                         ("ERROR", "fresh_evidence_missing"))

    def test_executed_task_cannot_reuse_unchanged_stale_xml(self) -> None:
        report = self.root / "build/test-results/TEST-proof.xml"
        report.parent.mkdir(parents=True)
        report.write_text('<testsuite tests="1" failures="0" errors="0" skipped="0"/>', encoding="utf-8")
        config = self.write_config([gradle_probe(self.script_for(None, outcome="EXECUTED"))])
        result = self.run_one(config)
        self.assertEqual((result["verdict"], result["reason"]),
                         ("ERROR", "junit_evidence_missing"))

    def test_missing_target_line_cannot_reuse_old_xml(self) -> None:
        report = self.root / "build/test-results/TEST-proof.xml"
        report.parent.mkdir(parents=True)
        report.write_text('<testsuite tests="1" failures="0" errors="0" skipped="0"/>', encoding="utf-8")
        config = self.write_config([gradle_probe("print('BUILD SUCCESSFUL')")])
        result = self.run_one(config)
        self.assertEqual((result["verdict"], result["reason"]), ("ERROR", "no_task_evidence"))


class DiscoveryAndCliTests(TempProject):
    def test_shipped_android_example_is_valid_and_selects_fast_probe(self) -> None:
        example = Path(loopprobe.__file__).parent / "examples" / "android.loopprobe.json"
        config = loopprobe.load_config(example)
        selection = loopprobe.select_probe(
            config, ["app/src/main/java/com/example/UsernamePolicy.kt"]
        )
        self.assertEqual(selection.probe.name, "domain-rule-fast")

    @unittest.skipUnless(shutil.which("git"), "git is unavailable")
    def test_git_change_discovery_reads_untracked_path(self) -> None:
        config = self.write_config([command_probe(["python3", "-c", "pass"])])
        subprocess.run(["git", "init", "-q", str(self.root)], check=True)
        (self.root / "src").mkdir()
        (self.root / "src" / "New.kt").write_text("class New", encoding="utf-8")
        paths, note = loopprobe.discover_git_changes(config)
        self.assertIn("src/New.kt", paths)
        self.assertIn("git", note)

    @unittest.skipUnless(shutil.which("git"), "git is unavailable")
    def test_git_paths_are_relative_to_nested_config_root(self) -> None:
        worktree = self.root / "mono"
        android = worktree / "android"
        android.mkdir(parents=True)
        nested_config_path = android / ".loopprobe.json"
        nested_config_path.write_text(
            json.dumps(config_document([command_probe(["python3", "-c", "pass"])])), encoding="utf-8"
        )
        config = loopprobe.load_config(nested_config_path)
        subprocess.run(["git", "init", "-q", str(worktree)], check=True)
        (android / "src").mkdir()
        (android / "src" / "New.kt").write_text("class New", encoding="utf-8")
        paths, _ = loopprobe.discover_git_changes(config)
        self.assertIn("src/New.kt", paths)
        self.assertNotIn("android/src/New.kt", paths)

    @unittest.skipUnless(shutil.which("git"), "git is unavailable")
    def test_git_cross_boundary_rename_keeps_inside_path(self) -> None:
        worktree = self.root / "rename-mono"
        android = worktree / "android"
        source = android / "src" / "Old.kt"
        source.parent.mkdir(parents=True)
        nested_config_path = android / ".loopprobe.json"
        nested_config_path.write_text(
            json.dumps(config_document([command_probe(["python3", "-c", "pass"])])), encoding="utf-8"
        )
        source.write_text("class Old", encoding="utf-8")
        subprocess.run(["git", "init", "-q", str(worktree)], check=True)
        subprocess.run(["git", "-C", str(worktree), "config", "user.email", "loopprobe@example.invalid"], check=True)
        subprocess.run(["git", "-C", str(worktree), "config", "user.name", "LoopProbe Test"], check=True)
        subprocess.run(["git", "-C", str(worktree), "add", "."], check=True)
        subprocess.run(["git", "-C", str(worktree), "commit", "-qm", "fixture"], check=True)
        (worktree / "other").mkdir()
        subprocess.run([
            "git", "-C", str(worktree), "mv", "android/src/Old.kt", "other/Old.kt"
        ], check=True)
        config = loopprobe.load_config(nested_config_path)
        paths, _ = loopprobe.discover_git_changes(config)
        self.assertIn("src/Old.kt", paths)
        self.assertNotIn("other/Old.kt", paths)

    def test_explicit_cli_probe_skips_git_discovery(self) -> None:
        self.write_config([command_probe(["python3", "-c", "pass"])])
        stdout = io.StringIO()
        with mock.patch.object(loopprobe, "discover_git_changes", side_effect=AssertionError("must not run")):
            with contextlib.redirect_stdout(stdout):
                code = loopprobe.main([
                    "--config", str(self.config_path), "select", "--probe", "tiny-command", "--json"
                ])
        self.assertEqual(code, loopprobe.EXIT_PASS)
        self.assertEqual(json.loads(stdout.getvalue())["selected"]["name"], "tiny-command")

    def test_cancelled_git_discovery_does_not_run_fallback_probe(self) -> None:
        self.write_config([command_probe(["python3", "-c", "raise SystemExit(9)"])])
        stdout = io.StringIO()
        with mock.patch.object(loopprobe, "discover_git_changes", side_effect=KeyboardInterrupt):
            with contextlib.redirect_stdout(stdout):
                code = loopprobe.main(["--config", str(self.config_path), "run", "--json"])
        payload = json.loads(stdout.getvalue())
        self.assertEqual((code, payload["reason"], payload["termination"]),
                         (loopprobe.EXIT_CANCELLED, "cancelled", "cancelled"))

    def test_invalid_config_cli_is_machine_readable_error(self) -> None:
        self.config_path.write_text('{"version": 1, "probes": []}', encoding="utf-8")
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            code = loopprobe.main(["--config", str(self.config_path), "validate", "--json"])
        payload = json.loads(stdout.getvalue())
        self.assertEqual((code, payload["verdict"], payload["reason"]),
                         (loopprobe.EXIT_ERROR, "ERROR", "invalid_config"))

    def test_no_matching_probe_returns_error(self) -> None:
        probe = command_probe(["python3", "-c", "pass"], fallback=False, changes=["src/**"])
        config = self.write_config([probe])
        selection = loopprobe.select_probe(config, ["docs/readme.md"])
        result = loopprobe.run_probe(config, selection)
        self.assertEqual((result["verdict"], result["reason"]), ("ERROR", "no_matching_probe"))


if __name__ == "__main__":
    unittest.main()
