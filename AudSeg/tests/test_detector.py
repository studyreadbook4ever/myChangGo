from __future__ import annotations

import math

import pytest

from audseg import (
    CuePolicy,
    DetectorConfig,
    SegmentationConfig,
    Segmenter,
    segment_pcm16,
    segment_samples,
)
from audseg.detector import extract_frame_levels

from .helpers import pcm16_bytes, silence, tone

SAMPLE_RATE = 16_000


def test_silence_has_no_activity() -> None:
    result = segment_samples(silence(SAMPLE_RATE, 1.0), SAMPLE_RATE)

    assert result.activity_regions == ()
    assert result.segments == ()
    assert result.warnings == ("no_activity_detected",)


def test_tone_burst_has_padded_boundaries() -> None:
    samples = silence(SAMPLE_RATE, 0.5) + tone(SAMPLE_RATE, 1.0) + silence(SAMPLE_RATE, 0.5)
    result = segment_samples(samples, SAMPLE_RATE)

    assert len(result.activity_regions) == 1
    region = result.activity_regions[0]
    assert region.start_sample / SAMPLE_RATE == pytest.approx(0.45, abs=0.02)
    assert region.end_sample / SAMPLE_RATE == pytest.approx(1.59, abs=0.02)
    assert region.peak_dbfs > result.start_threshold_dbfs
    assert len(result.segments) == 1
    assert result.segments[0].forced_split is False


def test_short_click_is_rejected_by_onset_debounce() -> None:
    samples = silence(SAMPLE_RATE, 0.5) + tone(SAMPLE_RATE, 0.01) + silence(SAMPLE_RATE, 0.5)

    result = segment_samples(samples, SAMPLE_RATE)

    assert result.activity_regions == ()


def test_short_pause_stays_inside_one_region() -> None:
    samples = (
        silence(SAMPLE_RATE, 0.2)
        + tone(SAMPLE_RATE, 0.6)
        + silence(SAMPLE_RATE, 0.1)
        + tone(SAMPLE_RATE, 0.6)
        + silence(SAMPLE_RATE, 0.4)
    )

    result = segment_samples(samples, SAMPLE_RATE)

    assert len(result.activity_regions) == 1


def test_long_pause_creates_two_regions() -> None:
    samples = (
        silence(SAMPLE_RATE, 0.2)
        + tone(SAMPLE_RATE, 0.6)
        + silence(SAMPLE_RATE, 0.4)
        + tone(SAMPLE_RATE, 0.6)
        + silence(SAMPLE_RATE, 0.4)
    )

    result = segment_samples(samples, SAMPLE_RATE)

    assert len(result.activity_regions) == 2
    assert result.activity_regions[0].end_sample <= result.activity_regions[1].start_sample


def test_dc_offset_is_not_mistaken_for_activity() -> None:
    result = segment_samples(silence(SAMPLE_RATE, 1.0, value=0.4), SAMPLE_RATE)

    assert result.activity_regions == ()


def test_continuous_activity_is_reported() -> None:
    result = segment_samples(tone(SAMPLE_RATE, 1.0), SAMPLE_RATE)

    assert len(result.activity_regions) == 1
    assert "nearly_continuous_activity" in result.warnings
    assert result.activity_regions[0].start_sample == 0
    assert result.activity_regions[0].end_sample == result.total_samples


def test_long_region_splits_at_a_quiet_valley() -> None:
    samples = tone(SAMPLE_RATE, 6.5) + silence(SAMPLE_RATE, 0.1) + tone(SAMPLE_RATE, 3.4)
    config = SegmentationConfig(
        cues=CuePolicy(
            max_duration_ms=8_000,
            min_split_duration_ms=500,
            split_search_ms=2_000,
        )
    )

    result = segment_samples(samples, SAMPLE_RATE, config)

    assert len(result.activity_regions) == 1
    assert len(result.segments) == 2
    assert all(segment.forced_split for segment in result.segments)
    assert result.segments[0].split_method == "quiet_valley"
    assert result.segments[0].end_sample / SAMPLE_RATE == pytest.approx(6.55, abs=0.05)
    assert result.segments[0].end_sample == result.segments[1].start_sample


def test_long_constant_region_uses_a_hard_limit_split() -> None:
    result = segment_samples(tone(SAMPLE_RATE, 10.0), SAMPLE_RATE)

    assert len(result.segments) == 2
    assert result.segments[0].forced_split is True
    assert result.segments[0].split_method == "hard_limit"
    assert result.segments[0].end_sample / SAMPLE_RATE == pytest.approx(8.0, abs=0.01)


@pytest.mark.parametrize("duration_seconds", [8.001, 8.2])
def test_hard_split_does_not_leave_a_subminimum_tail(duration_seconds: float) -> None:
    result = segment_samples(tone(SAMPLE_RATE, duration_seconds), SAMPLE_RATE)
    durations = [segment.duration_seconds(result.sample_rate_hz) for segment in result.segments]

    assert len(durations) == 2
    assert max(durations) <= 8.0
    assert min(durations) >= 0.5


def test_cue_splitting_can_be_disabled() -> None:
    config = SegmentationConfig(cues=CuePolicy(max_duration_ms=None))

    result = segment_samples(tone(SAMPLE_RATE, 10.0), SAMPLE_RATE, config)

    assert len(result.activity_regions) == 1
    assert len(result.segments) == 1
    assert result.segments[0].forced_split is False


def test_individually_short_bursts_do_not_become_valid_by_merging() -> None:
    config = SegmentationConfig(
        detector=DetectorConfig(
            onset_ms=10,
            release_ms=20,
            min_region_ms=100,
            merge_gap_ms=100,
            pad_start_ms=0,
            pad_end_ms=0,
        )
    )
    samples = (
        silence(SAMPLE_RATE, 0.2)
        + tone(SAMPLE_RATE, 0.05)
        + silence(SAMPLE_RATE, 0.05)
        + tone(SAMPLE_RATE, 0.05)
        + silence(SAMPLE_RATE, 0.2)
    )

    result = segment_samples(samples, SAMPLE_RATE, config)

    assert result.activity_regions == ()


def test_pcm_chunk_boundaries_do_not_change_result() -> None:
    samples = silence(SAMPLE_RATE, 0.25) + tone(SAMPLE_RATE, 0.5) + silence(SAMPLE_RATE, 0.4)
    encoded = pcm16_bytes(samples)
    baseline = segment_pcm16(encoded, SAMPLE_RATE)

    for chunk_size in (1, 7, 511, 4_096):
        chunks = [encoded[index : index + chunk_size] for index in range(0, len(encoded), chunk_size)]
        chunked = segment_pcm16(chunks, SAMPLE_RATE)
        assert chunked.activity_regions == baseline.activity_regions
        assert chunked.segments == baseline.segments
        assert chunked.total_samples == baseline.total_samples


def test_stereo_pcm16_uses_the_strongest_channel_across_odd_chunks() -> None:
    mono = silence(SAMPLE_RATE, 0.2) + tone(SAMPLE_RATE, 0.4) + silence(SAMPLE_RATE, 0.4)
    interleaved = bytearray()
    for sample in mono:
        left = max(-32_768, min(32_767, round(sample * 32_767)))
        right = -left
        interleaved.extend(left.to_bytes(2, "little", signed=True))
        interleaved.extend(right.to_bytes(2, "little", signed=True))
    chunks = [bytes(interleaved[index : index + 7]) for index in range(0, len(interleaved), 7)]

    result = segment_pcm16(chunks, SAMPLE_RATE, channels=2)

    assert result.total_samples == len(mono)
    assert len(result.activity_regions) == 1


def test_segmenter_facade_reuses_configuration() -> None:
    segmenter = Segmenter(
        SegmentationConfig(
            detector=DetectorConfig(fixed_threshold_dbfs=-30.0),
            cues=CuePolicy(max_duration_ms=None),
        )
    )

    result = segmenter.samples(tone(SAMPLE_RATE, 0.5, amplitude=0.1), SAMPLE_RATE)

    assert len(result.segments) == 1
    assert result.config.detector.fixed_threshold_dbfs == -30.0


def test_digital_silence_releases_even_when_stop_threshold_hits_floor() -> None:
    config = SegmentationConfig(
        detector=DetectorConfig(
            fixed_threshold_dbfs=-30.0,
            hysteresis_db=90.0,
        )
    )
    samples = silence(SAMPLE_RATE, 0.2) + tone(SAMPLE_RATE, 0.2) + silence(SAMPLE_RATE, 1.0)

    result = segment_samples(samples, SAMPLE_RATE, config)

    assert result.stop_threshold_dbfs == -120.0
    assert len(result.activity_regions) == 1
    assert result.activity_regions[0].end_reason == "silence"
    assert result.activity_regions[0].end_sample / SAMPLE_RATE < 0.6


def test_level_equal_to_nonfloor_stop_threshold_remains_active() -> None:
    sample_rate = 1_000
    samples = ([0.5] * 10 + [-0.5] * 10) * 50
    base_detector = DetectorConfig(frame_ms=20, hop_ms=10)
    levels, _ = extract_frame_levels(samples, sample_rate, base_detector)
    exact_level = levels[0].dbfs
    config = SegmentationConfig(
        detector=DetectorConfig(
            frame_ms=20,
            hop_ms=10,
            fixed_threshold_dbfs=exact_level,
            hysteresis_db=0,
            onset_ms=20,
            release_ms=20,
            min_region_ms=20,
            merge_gap_ms=0,
            pad_start_ms=0,
            pad_end_ms=0,
        )
    )

    result = segment_samples(samples, sample_rate, config)

    assert len(result.activity_regions) == 1
    assert result.activity_regions[0].start_sample == 0
    assert result.activity_regions[0].end_sample == len(samples)


def test_invalid_sample_and_config_are_rejected() -> None:
    with pytest.raises(ValueError, match="normalized"):
        segment_samples([2.0], SAMPLE_RATE)
    with pytest.raises(ValueError, match="hop_ms"):
        DetectorConfig(frame_ms=10, hop_ms=20)
    with pytest.raises(ValueError, match="two minimum"):
        CuePolicy(max_duration_ms=500, min_split_duration_ms=300)
    with pytest.raises(ValueError, match="finite"):
        DetectorConfig(onset_ms=math.nan)
    with pytest.raises(ValueError, match="finite"):
        CuePolicy(split_search_ms=math.inf)
    with pytest.raises(ValueError, match="greater than -120"):
        DetectorConfig(fixed_threshold_dbfs=-120.0)
