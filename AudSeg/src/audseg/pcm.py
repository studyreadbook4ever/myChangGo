"""PCM conversion helpers with no third-party runtime dependency."""

from __future__ import annotations

import math
import sys
from array import array
from collections.abc import Iterable, Iterator

from .errors import DecodeError


def _strongest_channel(values: array, start: int, channels: int) -> int:
    """Return the channel sample with the largest absolute magnitude."""

    strongest = values[start]
    strongest_abs = abs(strongest)
    for index in range(start + 1, start + channels):
        candidate = values[index]
        candidate_abs = abs(candidate)
        if candidate_abs > strongest_abs:
            strongest = candidate
            strongest_abs = candidate_abs
    return strongest


def iter_pcm16_mono(
    chunks: bytes | bytearray | memoryview | Iterable[bytes],
    *,
    channels: int = 1,
) -> Iterator[float]:
    """Yield normalized mono samples from little-endian signed PCM16 chunks.

    Channel reduction keeps the strongest instantaneous channel instead of
    averaging, so anti-phase stereo does not disappear during activity
    detection. Input chunks may split anywhere, including inside a sample.
    """

    if channels <= 0:
        raise ValueError("channels must be positive")
    if isinstance(chunks, (bytes, bytearray, memoryview)):
        source: Iterable[bytes] = (bytes(chunks),)
    else:
        source = chunks

    frame_bytes = channels * 2
    pending = bytearray()
    for chunk in source:
        if not isinstance(chunk, (bytes, bytearray, memoryview)):
            raise TypeError("PCM chunks must be bytes-like")
        pending.extend(chunk)
        complete_bytes = len(pending) - (len(pending) % frame_bytes)
        if complete_bytes == 0:
            continue
        raw = bytes(pending[:complete_bytes])
        del pending[:complete_bytes]

        values = array("h")
        values.frombytes(raw)
        if sys.byteorder == "big":
            values.byteswap()
        for start in range(0, len(values), channels):
            yield _strongest_channel(values, start, channels) / 32768.0

    if pending:
        raise DecodeError(f"PCM16 stream ended with {len(pending)} incomplete byte(s) for {channels} channel(s)")


def decode_wave_chunk(raw: bytes, sample_width: int, channels: int) -> Iterator[float]:
    """Yield normalized strongest-channel samples from one aligned WAV chunk."""

    if channels <= 0:
        raise DecodeError("WAV channel count must be positive")
    frame_bytes = sample_width * channels
    if sample_width not in {1, 2, 3, 4}:
        raise DecodeError(f"unsupported PCM sample width: {sample_width} bytes")
    if len(raw) % frame_bytes:
        raise DecodeError("WAV decoder returned a partial sample frame")

    if sample_width == 1:
        for start in range(0, len(raw), channels):
            strongest = int(raw[start]) - 128
            strongest_abs = abs(strongest)
            for index in range(start + 1, start + channels):
                candidate = int(raw[index]) - 128
                candidate_abs = abs(candidate)
                if candidate_abs > strongest_abs:
                    strongest = candidate
                    strongest_abs = candidate_abs
            yield strongest / 128.0
        return

    if sample_width == 2:
        yield from iter_pcm16_mono(raw, channels=channels)
        return

    if sample_width == 3:
        stride = channels * 3
        for frame_start in range(0, len(raw), stride):
            strongest = 0
            strongest_abs = -1
            for channel in range(channels):
                offset = frame_start + channel * 3
                candidate = int.from_bytes(raw[offset : offset + 3], "little", signed=True)
                candidate_abs = abs(candidate)
                if candidate_abs > strongest_abs:
                    strongest = candidate
                    strongest_abs = candidate_abs
            yield strongest / 8_388_608.0
        return

    values = array("i")
    if values.itemsize != 4:
        raise DecodeError("this Python build does not provide 32-bit signed array integers")
    values.frombytes(raw)
    if sys.byteorder == "big":
        values.byteswap()
    for start in range(0, len(values), channels):
        yield _strongest_channel(values, start, channels) / 2_147_483_648.0


def validate_normalized_sample(value: float) -> float:
    """Validate and normalize an API-provided floating-point PCM sample."""

    sample = float(value)
    if not math.isfinite(sample):
        raise ValueError("audio samples must be finite")
    if sample < -1.000_001 or sample > 1.000_001:
        raise ValueError("audio samples must be normalized to the [-1.0, 1.0] range")
    return max(-1.0, min(1.0, sample))
