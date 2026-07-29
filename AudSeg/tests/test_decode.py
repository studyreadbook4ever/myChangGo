from __future__ import annotations

import shutil

import pytest

from audseg import DecodeError, FFmpegNotFoundError, segment_file
from audseg.decode import decode_wave

from .helpers import silence, tone, write_wave

SAMPLE_RATE = 16_000


@pytest.mark.parametrize("sample_width", [1, 2, 3, 4])
def test_pcm_wave_widths_are_supported(tmp_path, sample_width: int) -> None:
    samples = silence(SAMPLE_RATE, 0.2) + tone(SAMPLE_RATE, 0.4) + silence(SAMPLE_RATE, 0.4)
    path = tmp_path / f"width-{sample_width}.wav"
    write_wave(path, [samples], SAMPLE_RATE, sample_width=sample_width)

    result = segment_file(path, decoder="wave")

    assert result.total_samples == len(samples)
    assert len(result.activity_regions) == 1


def test_antiphase_stereo_does_not_cancel(tmp_path) -> None:
    left = silence(SAMPLE_RATE, 0.2) + tone(SAMPLE_RATE, 0.4) + silence(SAMPLE_RATE, 0.4)
    right = [-sample for sample in left]
    path = tmp_path / "antiphase.wav"
    write_wave(path, [left, right], SAMPLE_RATE)

    result = segment_file(path, decoder="wave")

    assert len(result.activity_regions) == 1


def test_partial_final_frame_preserves_exact_sample_count(tmp_path) -> None:
    samples = tone(SAMPLE_RATE, 0.203)
    path = tmp_path / "partial.wav"
    write_wave(path, [samples], SAMPLE_RATE)

    decoded = decode_wave(path, chunk_frames=13)
    result = segment_file(path, decoder="wave")

    assert decoded.total_samples == len(samples)
    assert result.total_samples == len(samples)
    assert result.activity_regions[-1].end_sample == len(samples)


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="FFmpeg is not installed")
def test_optional_ffmpeg_decoder(tmp_path) -> None:
    samples = silence(SAMPLE_RATE, 0.2) + tone(SAMPLE_RATE, 0.4) + silence(SAMPLE_RATE, 0.4)
    path = tmp_path / "ffmpeg-input.wav"
    write_wave(path, [samples], SAMPLE_RATE)

    result = segment_file(path, decoder="ffmpeg")

    assert result.sample_rate_hz == 16_000
    assert len(result.activity_regions) == 1


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="FFmpeg is not installed")
def test_ffmpeg_rejects_network_protocols_nested_in_local_manifest(tmp_path) -> None:
    playlist = tmp_path / "remote.m3u8"
    playlist.write_text(
        "#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nhttps://127.0.0.1:9/segment.ts\n#EXT-X-ENDLIST\n",
        encoding="utf-8",
    )

    with pytest.raises(DecodeError, match="Protocol 'https' not on whitelist"):
        segment_file(playlist, decoder="ffmpeg")


def test_missing_ffmpeg_has_an_actionable_error(tmp_path) -> None:
    path = tmp_path / "input.bin"
    path.write_bytes(b"not audio")

    with pytest.raises(FFmpegNotFoundError, match="does not exist"):
        segment_file(path, decoder="ffmpeg", ffmpeg=str(tmp_path / "missing-ffmpeg"))


def test_large_ffmpeg_stderr_cannot_fill_a_pipe_and_deadlock(tmp_path) -> None:
    path = tmp_path / "input.bin"
    path.write_bytes(b"not audio")
    fake_ffmpeg = tmp_path / "fake-ffmpeg"
    fake_ffmpeg.write_text(
        "#!/usr/bin/env python3\nimport sys\nsys.stderr.write('decoder failure ' * 100_000)\nraise SystemExit(7)\n",
        encoding="utf-8",
    )
    fake_ffmpeg.chmod(0o755)

    with pytest.raises(DecodeError, match="exit code 7") as caught:
        segment_file(path, decoder="ffmpeg", ffmpeg=str(fake_ffmpeg))
    assert len(str(caught.value)) < 66_000
