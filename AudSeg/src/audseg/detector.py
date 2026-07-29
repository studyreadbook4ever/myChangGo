"""Pure-DSP frame analysis and Schmitt-trigger activity detection."""

from __future__ import annotations

import math
from collections import deque
from collections.abc import Iterable
from dataclasses import dataclass

from .config import DetectorConfig
from .models import ActivityRegion, FrameLevel
from .pcm import validate_normalized_sample

_DBFS_FLOOR = -120.0


@dataclass(frozen=True, slots=True)
class DetectionAnalysis:
    total_samples: int
    frame_levels: tuple[FrameLevel, ...]
    estimated_noise_dbfs: float
    effective_noise_dbfs: float
    peak_dbfs: float
    start_threshold_dbfs: float
    stop_threshold_dbfs: float
    regions: tuple[ActivityRegion, ...]


@dataclass(slots=True)
class _RawRegion:
    start_sample: int
    end_sample: int
    end_reason: str


def _milliseconds_to_samples(milliseconds: float, sample_rate_hz: int) -> int:
    return max(0, round(milliseconds * sample_rate_hz / 1_000.0))


def _power_to_dbfs(power: float) -> float:
    return 10.0 * math.log10(max(power, 1e-12))


def _frame_dbfs(sample_sum: float, square_sum: float, count: int) -> float:
    """Compute frame power after removing its DC component."""

    mean = sample_sum / count
    variance = max(0.0, square_sum / count - mean * mean)
    return _power_to_dbfs(variance)


def extract_frame_levels(
    samples: Iterable[float],
    sample_rate_hz: int,
    config: DetectorConfig,
) -> tuple[tuple[FrameLevel, ...], int]:
    """Consume normalized samples and return overlapping dBFS analysis frames."""

    if sample_rate_hz <= 0:
        raise ValueError("sample_rate_hz must be positive")
    frame_samples = max(1, _milliseconds_to_samples(config.frame_ms, sample_rate_hz))
    hop_samples = max(1, _milliseconds_to_samples(config.hop_ms, sample_rate_hz))
    hop_samples = min(hop_samples, frame_samples)

    window: deque[float] = deque()
    sample_sum = 0.0
    square_sum = 0.0
    frame_start = 0
    total_samples = 0
    last_emitted_end = 0
    levels: list[FrameLevel] = []

    for value in samples:
        sample = validate_normalized_sample(value)
        window.append(sample)
        sample_sum += sample
        square_sum += sample * sample
        total_samples += 1

        if len(window) == frame_samples:
            frame_end = frame_start + frame_samples
            levels.append(
                FrameLevel(
                    start_sample=frame_start,
                    end_sample=frame_end,
                    dbfs=_frame_dbfs(sample_sum, square_sum, len(window)),
                )
            )
            last_emitted_end = frame_end
            for _ in range(hop_samples):
                removed = window.popleft()
                sample_sum -= removed
                square_sum -= removed * removed
            frame_start += hop_samples

    if window and last_emitted_end < total_samples:
        levels.append(
            FrameLevel(
                start_sample=frame_start,
                end_sample=total_samples,
                dbfs=_frame_dbfs(sample_sum, square_sum, len(window)),
            )
        )

    return tuple(levels), total_samples


def _percentile(values: list[float], fraction: float) -> float:
    if not values:
        return _DBFS_FLOOR
    ordered = sorted(values)
    position = (len(ordered) - 1) * fraction
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    weight = position - lower
    return ordered[lower] * (1.0 - weight) + ordered[upper] * weight


def _thresholds(
    levels: tuple[FrameLevel, ...],
    config: DetectorConfig,
) -> tuple[float, float, float, float, float]:
    values = [frame.dbfs for frame in levels]
    estimated_noise = _percentile(values, config.noise_percentile)
    effective_noise = min(estimated_noise, config.noise_ceiling_dbfs)
    peak = max(values, default=_DBFS_FLOOR)

    if config.fixed_threshold_dbfs is not None:
        start_threshold = config.fixed_threshold_dbfs
        stop_threshold = max(_DBFS_FLOOR, start_threshold - config.hysteresis_db)
    else:
        adaptive_on = effective_noise + config.on_margin_db
        peak_guarded = peak - config.peak_guard_db
        start_threshold = max(config.minimum_on_dbfs, min(adaptive_on, peak_guarded))
        adaptive_off = effective_noise + config.off_margin_db
        stop_threshold = max(
            config.minimum_off_dbfs,
            min(adaptive_off, start_threshold - config.hysteresis_db),
        )
        if stop_threshold >= start_threshold:
            stop_threshold = max(_DBFS_FLOOR, start_threshold - 0.1)

    return estimated_noise, effective_noise, peak, start_threshold, stop_threshold


def _raw_regions(
    levels: tuple[FrameLevel, ...],
    total_samples: int,
    sample_rate_hz: int,
    config: DetectorConfig,
    start_threshold: float,
    stop_threshold: float,
) -> list[_RawRegion]:
    onset_samples = max(1, _milliseconds_to_samples(config.onset_ms, sample_rate_hz))
    release_samples = max(1, _milliseconds_to_samples(config.release_ms, sample_rate_hz))

    candidate_start: int | None = None
    active_start: int | None = None
    last_active_end: int | None = None
    regions: list[_RawRegion] = []

    for frame in levels:
        if active_start is None:
            if frame.dbfs >= start_threshold:
                if candidate_start is None:
                    candidate_start = frame.start_sample
                if frame.end_sample - candidate_start >= onset_samples:
                    active_start = candidate_start
                    last_active_end = frame.end_sample
                    candidate_start = None
            else:
                candidate_start = None
            continue

        if frame.dbfs >= stop_threshold and frame.dbfs > _DBFS_FLOOR:
            last_active_end = max(last_active_end or frame.end_sample, frame.end_sample)
            continue

        assert last_active_end is not None
        if frame.end_sample - last_active_end >= release_samples:
            regions.append(
                _RawRegion(
                    start_sample=active_start,
                    end_sample=min(last_active_end, total_samples),
                    end_reason="silence",
                )
            )
            active_start = None
            last_active_end = None
            candidate_start = None

    if active_start is not None and last_active_end is not None:
        regions.append(
            _RawRegion(
                start_sample=active_start,
                end_sample=min(last_active_end, total_samples),
                end_reason="eof",
            )
        )

    return regions


def _merge_raw_regions(
    regions: list[_RawRegion],
    sample_rate_hz: int,
    config: DetectorConfig,
) -> list[_RawRegion]:
    merge_gap = _milliseconds_to_samples(config.merge_gap_ms, sample_rate_hz)
    minimum = _milliseconds_to_samples(config.min_region_ms, sample_rate_hz)
    merged: list[_RawRegion] = []

    for region in (candidate for candidate in regions if candidate.end_sample - candidate.start_sample >= minimum):
        if merged and region.start_sample - merged[-1].end_sample <= merge_gap:
            previous = merged[-1]
            previous.end_sample = max(previous.end_sample, region.end_sample)
            previous.end_reason = "merged" if region.end_reason == "silence" else region.end_reason
        else:
            merged.append(
                _RawRegion(
                    start_sample=region.start_sample,
                    end_sample=region.end_sample,
                    end_reason=region.end_reason,
                )
            )

    return merged


def _level_stats(values: list[float]) -> tuple[float, float]:
    if not values:
        return _DBFS_FLOOR, _DBFS_FLOOR
    peak = max(values)
    mean_power = sum(10.0 ** (value / 10.0) for value in values) / len(values)
    return peak, _power_to_dbfs(mean_power)


def _pad_regions(
    raw_regions: list[_RawRegion],
    levels: tuple[FrameLevel, ...],
    total_samples: int,
    sample_rate_hz: int,
    config: DetectorConfig,
) -> tuple[ActivityRegion, ...]:
    pad_start = _milliseconds_to_samples(config.pad_start_ms, sample_rate_hz)
    pad_end = _milliseconds_to_samples(config.pad_end_ms, sample_rate_hz)
    padded: list[list[int | str]] = [
        [
            max(0, region.start_sample - pad_start),
            min(total_samples, region.end_sample + pad_end),
            region.end_reason,
            region.end_sample,
            region.start_sample,
        ]
        for region in raw_regions
    ]

    for index in range(1, len(padded)):
        previous = padded[index - 1]
        current = padded[index]
        previous_end = int(previous[1])
        current_start = int(current[0])
        if previous_end <= current_start:
            continue
        raw_previous_end = int(previous[3])
        raw_current_start = int(current[4])
        midpoint = (raw_previous_end + raw_current_start) // 2
        midpoint = max(int(previous[0]) + 1, midpoint)
        midpoint = min(int(current[1]) - 1, midpoint)
        previous[1] = midpoint
        current[0] = midpoint

    result: list[ActivityRegion] = []
    first_level = 0
    for start, end, reason, _, _ in padded:
        start_sample = int(start)
        end_sample = int(end)
        if end_sample <= start_sample:
            continue
        while first_level < len(levels) and levels[first_level].end_sample <= start_sample:
            first_level += 1
        last_level = first_level
        values: list[float] = []
        while last_level < len(levels) and levels[last_level].start_sample < end_sample:
            values.append(levels[last_level].dbfs)
            last_level += 1
        peak, mean = _level_stats(values)
        result.append(
            ActivityRegion(
                start_sample=start_sample,
                end_sample=end_sample,
                peak_dbfs=peak,
                mean_dbfs=mean,
                end_reason=str(reason),
            )
        )
    return tuple(result)


def detect_activity(
    samples: Iterable[float],
    sample_rate_hz: int,
    config: DetectorConfig,
) -> DetectionAnalysis:
    """Detect activity regions from normalized PCM samples."""

    levels, total_samples = extract_frame_levels(samples, sample_rate_hz, config)
    estimated_noise, effective_noise, peak, start_threshold, stop_threshold = _thresholds(
        levels,
        config,
    )
    raw = _raw_regions(
        levels,
        total_samples,
        sample_rate_hz,
        config,
        start_threshold,
        stop_threshold,
    )
    merged = _merge_raw_regions(raw, sample_rate_hz, config)
    regions = _pad_regions(
        merged,
        levels,
        total_samples,
        sample_rate_hz,
        config,
    )
    return DetectionAnalysis(
        total_samples=total_samples,
        frame_levels=levels,
        estimated_noise_dbfs=estimated_noise,
        effective_noise_dbfs=effective_noise,
        peak_dbfs=peak,
        start_threshold_dbfs=start_threshold,
        stop_threshold_dbfs=stop_threshold,
        regions=regions,
    )
