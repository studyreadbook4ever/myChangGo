"""Validated configuration for detection and subtitle cue planning."""

from __future__ import annotations

import math
from dataclasses import dataclass, field


def _require_range(name: str, value: float, minimum: float, maximum: float) -> None:
    if not minimum <= value <= maximum:
        raise ValueError(f"{name} must be between {minimum} and {maximum}; got {value}")


def _require_nonnegative(name: str, value: float) -> None:
    if not math.isfinite(value) or value < 0:
        raise ValueError(f"{name} must be a finite non-negative number; got {value}")


@dataclass(frozen=True, slots=True)
class DetectorConfig:
    """Configuration for model-free audio activity detection.

    Times are expressed in milliseconds and levels in dBFS.
    """

    frame_ms: float = 20.0
    hop_ms: float = 10.0
    noise_percentile: float = 0.20
    noise_ceiling_dbfs: float = -45.0
    minimum_on_dbfs: float = -65.0
    minimum_off_dbfs: float = -68.0
    on_margin_db: float = 10.0
    off_margin_db: float = 6.0
    peak_guard_db: float = 6.0
    hysteresis_db: float = 4.0
    fixed_threshold_dbfs: float | None = None
    onset_ms: float = 40.0
    release_ms: float = 250.0
    min_region_ms: float = 120.0
    merge_gap_ms: float = 100.0
    pad_start_ms: float = 40.0
    pad_end_ms: float = 80.0

    def __post_init__(self) -> None:
        _require_range("frame_ms", self.frame_ms, 5.0, 200.0)
        _require_range("hop_ms", self.hop_ms, 1.0, self.frame_ms)
        _require_range("noise_percentile", self.noise_percentile, 0.01, 0.99)
        _require_range("noise_ceiling_dbfs", self.noise_ceiling_dbfs, -120.0, 0.0)
        _require_range("minimum_on_dbfs", self.minimum_on_dbfs, -120.0, 0.0)
        _require_range("minimum_off_dbfs", self.minimum_off_dbfs, -120.0, 0.0)
        if self.minimum_on_dbfs <= -120.0:
            raise ValueError("minimum_on_dbfs must be greater than the digital-silence floor (-120 dBFS)")
        if self.minimum_off_dbfs > self.minimum_on_dbfs:
            raise ValueError("minimum_off_dbfs must not exceed minimum_on_dbfs")
        for name in ("on_margin_db", "off_margin_db", "peak_guard_db", "hysteresis_db"):
            _require_nonnegative(name, getattr(self, name))
        if self.off_margin_db > self.on_margin_db:
            raise ValueError("off_margin_db must not exceed on_margin_db")
        if self.fixed_threshold_dbfs is not None:
            _require_range("fixed_threshold_dbfs", self.fixed_threshold_dbfs, -120.0, 0.0)
            if self.fixed_threshold_dbfs <= -120.0:
                raise ValueError("fixed_threshold_dbfs must be greater than -120 dBFS")
        for name in (
            "onset_ms",
            "release_ms",
            "min_region_ms",
            "merge_gap_ms",
            "pad_start_ms",
            "pad_end_ms",
        ):
            _require_nonnegative(name, getattr(self, name))


@dataclass(frozen=True, slots=True)
class CuePolicy:
    """Rules that turn acoustic activity regions into editable subtitle cues."""

    max_duration_ms: float | None = 8_000.0
    min_split_duration_ms: float = 500.0
    split_search_ms: float = 2_000.0

    def __post_init__(self) -> None:
        if self.max_duration_ms is not None and (not math.isfinite(self.max_duration_ms) or self.max_duration_ms <= 0):
            raise ValueError("max_duration_ms must be a finite positive number or None")
        if not math.isfinite(self.min_split_duration_ms) or self.min_split_duration_ms <= 0:
            raise ValueError("min_split_duration_ms must be a finite positive number")
        _require_nonnegative("split_search_ms", self.split_search_ms)
        if self.max_duration_ms is not None and self.max_duration_ms < self.min_split_duration_ms * 2:
            raise ValueError("max_duration_ms must fit at least two minimum split durations")


@dataclass(frozen=True, slots=True)
class SegmentationConfig:
    """Complete reusable AudSeg configuration."""

    detector: DetectorConfig = field(default_factory=DetectorConfig)
    cues: CuePolicy = field(default_factory=CuePolicy)
