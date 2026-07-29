"""Streaming audio decoders.

PCM WAV uses only Python's standard library. Other containers are decoded by
an optional external FFmpeg executable; no model, network call, or GPU is used.
"""

from __future__ import annotations

import shutil
import subprocess
import tempfile
import wave
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

from .errors import DecodeError, FFmpegNotFoundError, UnsupportedWaveError
from .pcm import decode_wave_chunk, iter_pcm16_mono


@dataclass(frozen=True, slots=True)
class DecodedAudio:
    sample_rate_hz: int
    total_samples: int | None
    samples: Iterator[float]


def decode_wave(path: str | Path, *, chunk_frames: int = 8_192) -> DecodedAudio:
    """Open an uncompressed PCM WAV file as a normalized sample iterator."""

    source = Path(path)
    try:
        with wave.open(str(source), "rb") as reader:
            channels = reader.getnchannels()
            sample_width = reader.getsampwidth()
            sample_rate_hz = reader.getframerate()
            total_samples = reader.getnframes()
            compression = reader.getcomptype()
    except (OSError, EOFError, wave.Error) as exc:
        raise UnsupportedWaveError(f"cannot open PCM WAV file {source}: {exc}") from exc

    if compression != "NONE":
        raise UnsupportedWaveError(f"compressed WAV is not supported by the built-in decoder: {compression}")
    if channels <= 0 or sample_rate_hz <= 0:
        raise UnsupportedWaveError("WAV metadata contains an invalid channel count or sample rate")
    if sample_width not in {1, 2, 3, 4}:
        raise UnsupportedWaveError(f"unsupported WAV sample width: {sample_width} bytes")
    if chunk_frames <= 0:
        raise ValueError("chunk_frames must be positive")

    def samples() -> Iterator[float]:
        try:
            with wave.open(str(source), "rb") as reader:
                while raw := reader.readframes(chunk_frames):
                    yield from decode_wave_chunk(raw, sample_width, channels)
        except (OSError, EOFError, wave.Error) as exc:
            raise DecodeError(f"failed while reading WAV file {source}: {exc}") from exc

    return DecodedAudio(
        sample_rate_hz=sample_rate_hz,
        total_samples=total_samples,
        samples=samples(),
    )


def _resolve_ffmpeg(executable: str) -> str:
    candidate = Path(executable)
    if candidate.parent != Path("."):
        if candidate.is_file():
            return str(candidate)
        raise FFmpegNotFoundError(f"FFmpeg executable does not exist: {executable}")
    resolved = shutil.which(executable)
    if resolved is None:
        raise FFmpegNotFoundError(
            "FFmpeg was not found. Install FFmpeg, pass --ffmpeg PATH, or use an uncompressed PCM WAV input."
        )
    return resolved


def decode_ffmpeg(
    path: str | Path,
    *,
    ffmpeg: str = "ffmpeg",
    sample_rate_hz: int = 16_000,
    chunk_bytes: int = 65_536,
) -> DecodedAudio:
    """Decode any FFmpeg-supported audio source to mono PCM16 on the CPU."""

    if sample_rate_hz <= 0:
        raise ValueError("sample_rate_hz must be positive")
    if chunk_bytes <= 0:
        raise ValueError("chunk_bytes must be positive")
    source = Path(path)
    executable = _resolve_ffmpeg(ffmpeg)

    def chunks() -> Iterator[bytes]:
        command = [
            executable,
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-protocol_whitelist",
            "file,crypto,data",
            "-i",
            str(source),
            "-map",
            "0:a:0",
            "-vn",
            "-ac",
            "1",
            "-ar",
            str(sample_rate_hz),
            "-f",
            "s16le",
            "-acodec",
            "pcm_s16le",
            "pipe:1",
        ]
        with tempfile.TemporaryFile() as error_log:
            try:
                process = subprocess.Popen(
                    command,
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.PIPE,
                    stderr=error_log,
                    shell=False,
                )
            except OSError as exc:
                raise DecodeError(f"could not start FFmpeg: {exc}") from exc

            completed = False
            try:
                assert process.stdout is not None
                while chunk := process.stdout.read(chunk_bytes):
                    yield chunk
                process.stdout.close()
                return_code = process.wait()
                completed = True
                if return_code != 0:
                    error_log.seek(0)
                    stderr = error_log.read(65_536)
                    detail = stderr.decode("utf-8", errors="replace").strip()
                    raise DecodeError(f"FFmpeg failed with exit code {return_code}" + (f": {detail}" if detail else ""))
            finally:
                if process.stdout is not None and not process.stdout.closed:
                    process.stdout.close()
                if not completed and process.poll() is None:
                    process.terminate()
                    try:
                        process.wait(timeout=2)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait()

    return DecodedAudio(
        sample_rate_hz=sample_rate_hz,
        total_samples=None,
        samples=iter_pcm16_mono(chunks(), channels=1),
    )


def decode_file(
    path: str | Path,
    *,
    decoder: str = "auto",
    ffmpeg: str = "ffmpeg",
    ffmpeg_sample_rate_hz: int = 16_000,
) -> DecodedAudio:
    """Decode a file with ``wave``, FFmpeg, or automatic selection."""

    source = Path(path)
    if not source.is_file():
        raise DecodeError(f"audio input does not exist or is not a file: {source}")
    if decoder not in {"auto", "wave", "ffmpeg"}:
        raise ValueError("decoder must be one of: auto, wave, ffmpeg")
    if decoder == "wave":
        return decode_wave(source)
    if decoder == "ffmpeg":
        return decode_ffmpeg(
            source,
            ffmpeg=ffmpeg,
            sample_rate_hz=ffmpeg_sample_rate_hz,
        )

    if source.suffix.lower() in {".wav", ".wave"}:
        try:
            return decode_wave(source)
        except UnsupportedWaveError:
            return decode_ffmpeg(
                source,
                ffmpeg=ffmpeg,
                sample_rate_hz=ffmpeg_sample_rate_hz,
            )
    return decode_ffmpeg(
        source,
        ffmpeg=ffmpeg,
        sample_rate_hz=ffmpeg_sample_rate_hz,
    )
