"""Convert acoustic activity regions into editable subtitle cue candidates."""

from __future__ import annotations

import statistics
from bisect import bisect_left, bisect_right
from itertools import pairwise

from .config import CuePolicy
from .models import ActivityRegion, FrameLevel, Segment


def _milliseconds_to_samples(milliseconds: float, sample_rate_hz: int) -> int:
    return max(1, round(milliseconds * sample_rate_hz / 1_000.0))


def _choose_split(
    levels: tuple[FrameLevel, ...],
    level_starts: list[int],
    *,
    lower: int,
    upper: int,
    ideal: int,
) -> tuple[int, str]:
    hard_boundary = min(max(ideal, lower), upper)
    first = bisect_left(level_starts, lower)
    last = bisect_right(level_starts, upper)
    candidates = levels[first:last]
    if not candidates:
        return hard_boundary, "hard_limit"

    quietest = min(
        candidates,
        key=lambda frame: (frame.dbfs, abs(frame.start_sample - ideal)),
    )
    median_level = statistics.median(frame.dbfs for frame in candidates)
    if quietest.dbfs <= median_level - 3.0:
        return quietest.start_sample, "quiet_valley"
    return hard_boundary, "hard_limit"


def _split_region(
    region: ActivityRegion,
    source_region: int,
    levels: tuple[FrameLevel, ...],
    level_starts: list[int],
    sample_rate_hz: int,
    policy: CuePolicy,
) -> list[Segment]:
    if policy.max_duration_ms is None:
        return [
            Segment(
                start_sample=region.start_sample,
                end_sample=region.end_sample,
                source_region=source_region,
            )
        ]

    maximum = _milliseconds_to_samples(policy.max_duration_ms, sample_rate_hz)
    if region.end_sample - region.start_sample <= maximum:
        return [
            Segment(
                start_sample=region.start_sample,
                end_sample=region.end_sample,
                source_region=source_region,
            )
        ]

    minimum = _milliseconds_to_samples(policy.min_split_duration_ms, sample_rate_hz)
    search = max(0, round(policy.split_search_ms * sample_rate_hz / 1_000.0))
    boundaries: list[tuple[int, str]] = []
    cursor = region.start_sample

    while region.end_sample - cursor > maximum:
        ideal = cursor + maximum
        lower = max(cursor + minimum, ideal - search)
        upper = min(ideal, region.end_sample - minimum)
        if upper < lower:
            boundary = min(ideal, region.end_sample - minimum)
            method = "hard_limit"
        else:
            boundary, method = _choose_split(
                levels,
                level_starts,
                lower=lower,
                upper=upper,
                ideal=ideal,
            )
        if boundary <= cursor or boundary >= region.end_sample:
            boundary = min(cursor + maximum, region.end_sample - minimum)
            method = "hard_limit"
        boundaries.append((boundary, method))
        cursor = boundary

    points = [region.start_sample, *(boundary for boundary, _ in boundaries), region.end_sample]
    methods = [method for _, method in boundaries]
    segments: list[Segment] = []
    for index, (start, end) in enumerate(pairwise(points)):
        method_index = min(index, len(methods) - 1)
        segments.append(
            Segment(
                start_sample=start,
                end_sample=end,
                source_region=source_region,
                forced_split=True,
                split_method=methods[method_index],
            )
        )
    return segments


def plan_cues(
    regions: tuple[ActivityRegion, ...],
    levels: tuple[FrameLevel, ...],
    sample_rate_hz: int,
    policy: CuePolicy,
) -> tuple[Segment, ...]:
    """Plan non-overlapping blank subtitle cues for detected regions."""

    level_starts = [frame.start_sample for frame in levels]
    segments: list[Segment] = []
    for index, region in enumerate(regions):
        segments.extend(
            _split_region(
                region,
                index,
                levels,
                level_starts,
                sample_rate_hz,
                policy,
            )
        )
    return tuple(segments)
