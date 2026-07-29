from __future__ import annotations

import math
import wave
from pathlib import Path


def silence(sample_rate_hz: int, seconds: float, *, value: float = 0.0) -> list[float]:
    return [value] * round(sample_rate_hz * seconds)


def tone(
    sample_rate_hz: int,
    seconds: float,
    *,
    amplitude: float = 0.5,
    frequency_hz: float = 440.0,
    phase: float = 0.0,
) -> list[float]:
    count = round(sample_rate_hz * seconds)
    return [
        amplitude * math.sin(2.0 * math.pi * frequency_hz * index / sample_rate_hz + phase) for index in range(count)
    ]


def pcm16_bytes(samples: list[float]) -> bytes:
    output = bytearray()
    for sample in samples:
        integer = max(-32_768, min(32_767, round(sample * 32_767)))
        output.extend(integer.to_bytes(2, "little", signed=True))
    return bytes(output)


def _encode_sample(sample: float, sample_width: int) -> bytes:
    clamped = max(-1.0, min(1.0, sample))
    if sample_width == 1:
        return bytes((max(0, min(255, 128 + round(clamped * 127))),))
    maximum = (1 << (sample_width * 8 - 1)) - 1
    minimum = -(1 << (sample_width * 8 - 1))
    integer = max(minimum, min(maximum, round(clamped * maximum)))
    return integer.to_bytes(sample_width, "little", signed=True)


def write_wave(
    path: Path,
    channels: list[list[float]],
    sample_rate_hz: int,
    *,
    sample_width: int = 2,
) -> None:
    if not channels:
        raise ValueError("at least one channel is required")
    frame_count = len(channels[0])
    if any(len(channel) != frame_count for channel in channels):
        raise ValueError("all channels must have the same sample count")

    frames = bytearray()
    for index in range(frame_count):
        for channel in channels:
            frames.extend(_encode_sample(channel[index], sample_width))

    with wave.open(str(path), "wb") as writer:
        writer.setnchannels(len(channels))
        writer.setsampwidth(sample_width)
        writer.setframerate(sample_rate_hz)
        writer.writeframes(bytes(frames))
