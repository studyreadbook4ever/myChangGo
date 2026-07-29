"""Immutable public result models."""

from __future__ import annotations

from dataclasses import dataclass, field

from .config import SegmentationConfig


@dataclass(frozen=True, slots=True)
class FrameLevel:
    """One overlapping analysis frame."""

    start_sample: int
    end_sample: int
    dbfs: float

    def __post_init__(self) -> None:
        if self.start_sample < 0 or self.end_sample <= self.start_sample:
            raise ValueError("frame boundaries must satisfy 0 <= start < end")


@dataclass(frozen=True, slots=True)
class ActivityRegion:
    """A padded, merged acoustic activity interval."""

    start_sample: int
    end_sample: int
    peak_dbfs: float
    mean_dbfs: float
    end_reason: str = "silence"

    def __post_init__(self) -> None:
        if self.start_sample < 0 or self.end_sample <= self.start_sample:
            raise ValueError("region boundaries must satisfy 0 <= start < end")
        if self.end_reason not in {"silence", "eof", "merged"}:
            raise ValueError(f"unsupported end_reason: {self.end_reason}")


@dataclass(frozen=True, slots=True)
class Segment:
    """An editable subtitle cue candidate.

    Sample indexes are canonical. Millisecond values in renderers are derived
    from these integers, avoiding cumulative floating-point drift.
    """

    start_sample: int
    end_sample: int
    source_region: int
    forced_split: bool = False
    split_method: str | None = None

    def __post_init__(self) -> None:
        if self.start_sample < 0 or self.end_sample <= self.start_sample:
            raise ValueError("segment boundaries must satisfy 0 <= start < end")
        if self.source_region < 0:
            raise ValueError("source_region must be non-negative")
        if self.split_method not in {None, "quiet_valley", "hard_limit"}:
            raise ValueError(f"unsupported split_method: {self.split_method}")

    def start_seconds(self, sample_rate_hz: int) -> float:
        return self.start_sample / sample_rate_hz

    def end_seconds(self, sample_rate_hz: int) -> float:
        return self.end_sample / sample_rate_hz

    def duration_seconds(self, sample_rate_hz: int) -> float:
        return (self.end_sample - self.start_sample) / sample_rate_hz


@dataclass(frozen=True, slots=True)
class SegmentationResult:
    """Detection diagnostics, acoustic regions, and planned cue segments."""

    sample_rate_hz: int
    total_samples: int
    source: str | None
    estimated_noise_dbfs: float
    effective_noise_dbfs: float
    peak_dbfs: float
    start_threshold_dbfs: float
    stop_threshold_dbfs: float
    activity_regions: tuple[ActivityRegion, ...]
    segments: tuple[Segment, ...]
    warnings: tuple[str, ...]
    config: SegmentationConfig
    frame_levels: tuple[FrameLevel, ...] = field(repr=False)

    def __post_init__(self) -> None:
        if self.sample_rate_hz <= 0:
            raise ValueError("sample_rate_hz must be positive")
        if self.total_samples < 0:
            raise ValueError("total_samples must be non-negative")
        for collection in (self.activity_regions, self.segments):
            previous_end = 0
            for item in collection:
                if item.end_sample > self.total_samples:
                    raise ValueError("result interval exceeds total_samples")
                if item.start_sample < previous_end:
                    raise ValueError("result intervals must be sorted and non-overlapping")
                previous_end = item.end_sample

    @property
    def duration_seconds(self) -> float:
        return self.total_samples / self.sample_rate_hz

    @property
    def active_ratio(self) -> float:
        if self.total_samples == 0:
            return 0.0
        active_samples = sum(region.end_sample - region.start_sample for region in self.activity_regions)
        return active_samples / self.total_samples
