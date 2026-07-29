"""JSON, SubRip, and WebVTT renderers."""

from __future__ import annotations

import json
from dataclasses import asdict
from typing import Any

from .models import SegmentationResult


def sample_to_milliseconds(sample: int, sample_rate_hz: int) -> int:
    """Round a non-negative sample index to the nearest millisecond."""

    if sample < 0:
        raise ValueError("sample must be non-negative")
    if sample_rate_hz <= 0:
        raise ValueError("sample_rate_hz must be positive")
    return (sample * 1_000 + sample_rate_hz // 2) // sample_rate_hz


def _round_level(value: float) -> float:
    return round(value, 3)


def result_to_dict(result: SegmentationResult) -> dict[str, Any]:
    """Convert a result to the stable ``audseg.result/v1`` JSON shape."""

    sample_rate = result.sample_rate_hz
    regions = []
    for index, region in enumerate(result.activity_regions, start=1):
        start_ms = sample_to_milliseconds(region.start_sample, sample_rate)
        end_ms = sample_to_milliseconds(region.end_sample, sample_rate)
        regions.append(
            {
                "index": index,
                "start_sample": region.start_sample,
                "end_sample": region.end_sample,
                "start_ms": start_ms,
                "end_ms": end_ms,
                "duration_ms": end_ms - start_ms,
                "peak_dbfs": _round_level(region.peak_dbfs),
                "mean_dbfs": _round_level(region.mean_dbfs),
                "end_reason": region.end_reason,
            }
        )

    segments = []
    for index, segment in enumerate(result.segments, start=1):
        start_ms = sample_to_milliseconds(segment.start_sample, sample_rate)
        end_ms = sample_to_milliseconds(segment.end_sample, sample_rate)
        segments.append(
            {
                "index": index,
                "start_sample": segment.start_sample,
                "end_sample": segment.end_sample,
                "start_ms": start_ms,
                "end_ms": end_ms,
                "duration_ms": end_ms - start_ms,
                "source_region": segment.source_region + 1,
                "forced_split": segment.forced_split,
                "split_method": segment.split_method,
            }
        )

    return {
        "schema": "audseg.result/v1",
        "generator": {"name": "audseg", "version": "0.1.0"},
        "source": result.source,
        "audio": {
            "sample_rate_hz": sample_rate,
            "total_samples": result.total_samples,
            "duration_ms": sample_to_milliseconds(result.total_samples, sample_rate),
        },
        "analysis": {
            "algorithm": (
                "dc-removed-rms-fixed-hysteresis"
                if result.config.detector.fixed_threshold_dbfs is not None
                else "dc-removed-rms-adaptive-hysteresis"
            ),
            "threshold_mode": ("fixed" if result.config.detector.fixed_threshold_dbfs is not None else "adaptive"),
            "estimated_noise_dbfs": _round_level(result.estimated_noise_dbfs),
            "effective_noise_dbfs": _round_level(result.effective_noise_dbfs),
            "peak_dbfs": _round_level(result.peak_dbfs),
            "start_threshold_dbfs": _round_level(result.start_threshold_dbfs),
            "stop_threshold_dbfs": _round_level(result.stop_threshold_dbfs),
            "active_ratio": round(result.active_ratio, 6),
            "warnings": list(result.warnings),
        },
        "config": asdict(result.config),
        "activity_regions": regions,
        "segments": segments,
    }


def render_json(result: SegmentationResult, *, indent: int | None = 2) -> str:
    return json.dumps(
        result_to_dict(result),
        ensure_ascii=False,
        indent=indent,
        sort_keys=False,
    )


def _timestamp(total_ms: int, *, decimal_separator: str) -> str:
    hours, remainder = divmod(total_ms, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    seconds, milliseconds = divmod(remainder, 1_000)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}{decimal_separator}{milliseconds:03d}"


def _cue_text(placeholder: str, index: int) -> str:
    return placeholder.replace("{index}", str(index))


def _cue_milliseconds(result: SegmentationResult) -> list[tuple[int, int]]:
    """Quantize cues without silently stretching an unrepresentable timeline."""

    quantized: list[tuple[int, int]] = []
    previous_end = 0
    for index, segment in enumerate(result.segments, start=1):
        start_ms = sample_to_milliseconds(segment.start_sample, result.sample_rate_hz)
        end_ms = sample_to_milliseconds(segment.end_sample, result.sample_rate_hz)
        if end_ms <= start_ms:
            raise ValueError(
                f"cue {index} is shorter than SRT/WebVTT's 1 ms timebase; use JSON or increase the minimum cue duration"
            )
        if start_ms < previous_end:
            raise ValueError(
                f"cue {index} overlaps after millisecond quantization; use JSON or increase the gap between cues"
            )
        quantized.append((start_ms, end_ms))
        previous_end = end_ms
    return quantized


def render_srt(result: SegmentationResult, *, placeholder: str = "[…]") -> str:
    """Render cues as SubRip.

    A visible placeholder is the default because many subtitle editors discard
    cues with a truly empty payload. Pass ``placeholder=""`` to opt out.
    """

    blocks: list[str] = []
    for index, (start_ms, end_ms) in enumerate(_cue_milliseconds(result), start=1):
        blocks.append(
            "\n".join(
                (
                    str(index),
                    f"{_timestamp(start_ms, decimal_separator=',')} --> {_timestamp(end_ms, decimal_separator=',')}",
                    _cue_text(placeholder, index),
                )
            )
        )
    return "\n\n".join(blocks) + ("\n" if blocks else "")


def render_vtt(result: SegmentationResult, *, placeholder: str = "[…]") -> str:
    """Render cues as WebVTT."""

    blocks: list[str] = ["WEBVTT"]
    for index, (start_ms, end_ms) in enumerate(_cue_milliseconds(result), start=1):
        blocks.append(
            "\n".join(
                (
                    str(index),
                    f"{_timestamp(start_ms, decimal_separator='.')} --> {_timestamp(end_ms, decimal_separator='.')}",
                    _cue_text(placeholder, index),
                )
            )
        )
    return "\n\n".join(blocks) + "\n"


def render(
    result: SegmentationResult,
    output_format: str,
    *,
    placeholder: str = "[…]",
    compact_json: bool = False,
) -> str:
    """Render a result in one of the supported formats."""

    normalized = output_format.lower()
    if normalized == "json":
        return render_json(result, indent=None if compact_json else 2)
    if normalized == "srt":
        return render_srt(result, placeholder=placeholder)
    if normalized == "vtt":
        return render_vtt(result, placeholder=placeholder)
    raise ValueError(f"unsupported output format: {output_format}")
