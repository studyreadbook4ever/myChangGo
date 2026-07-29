from __future__ import annotations

import json
import os

import pytest

from audseg.cli import _write_atomic, main

from .helpers import silence, tone, write_wave

SAMPLE_RATE = 16_000


def _input(tmp_path):
    samples = silence(SAMPLE_RATE, 0.2) + tone(SAMPLE_RATE, 0.4) + silence(SAMPLE_RATE, 0.4)
    path = tmp_path / "input.wav"
    write_wave(path, [samples], SAMPLE_RATE)
    return path


def test_cli_writes_json_to_stdout(tmp_path, capsys) -> None:
    path = _input(tmp_path)

    exit_code = main([str(path), "--compact-json"])
    captured = capsys.readouterr()

    assert exit_code == 0
    assert captured.err == ""
    payload = json.loads(captured.out)
    assert payload["schema"] == "audseg.result/v1"
    assert payload["source"] == "input.wav"
    assert len(payload["segments"]) == 1


def test_cli_infers_srt_and_refuses_accidental_overwrite(tmp_path, capsys) -> None:
    path = _input(tmp_path)
    output = tmp_path / "captions.srt"

    assert main([str(path), "-o", str(output)]) == 0
    assert "-->" in output.read_text(encoding="utf-8")

    assert main([str(path), "-o", str(output)]) == 2
    assert "already exists" in capsys.readouterr().err

    assert main([str(path), "-o", str(output), "--force", "--placeholder", "{index}"]) == 0
    assert "\n1\n" in output.read_text(encoding="utf-8")


def test_cli_diagnostics_go_to_stderr_only(tmp_path, capsys) -> None:
    path = _input(tmp_path)

    exit_code = main([str(path), "--diagnostics", "--compact-json"])
    captured = capsys.readouterr()

    assert exit_code == 0
    json.loads(captured.out)
    assert "region(s)" in captured.err


def test_atomic_writer_does_not_clobber_a_racing_creator(tmp_path, monkeypatch) -> None:
    output = tmp_path / "race.json"
    real_link = os.link

    def racing_link(source, destination):
        output.write_text("other process", encoding="utf-8")
        return real_link(source, destination)

    monkeypatch.setattr(os, "link", racing_link)

    with pytest.raises(FileExistsError, match="already exists"):
        _write_atomic(output, "our content", force=False)
    assert output.read_text(encoding="utf-8") == "other process"


def test_broken_output_symlink_counts_as_existing(tmp_path) -> None:
    output = tmp_path / "broken.json"
    output.symlink_to(tmp_path / "missing-target")

    with pytest.raises(FileExistsError, match="already exists"):
        _write_atomic(output, "our content", force=False)
