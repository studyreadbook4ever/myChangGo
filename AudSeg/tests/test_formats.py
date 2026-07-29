from __future__ import annotations

import json

import pytest

from audseg import (
    ActivityRegion,
    DetectorConfig,
    Segment,
    SegmentationConfig,
    SegmentationResult,
)
from audseg.formats import render_json, render_srt, render_vtt, result_to_dict


def _result(
    *,
    start_sample: int = 16_000,
    end_sample: int = 32_000,
    sample_rate: int = 16_000,
) -> SegmentationResult:
    return SegmentationResult(
        sample_rate_hz=sample_rate,
        total_samples=max(end_sample, sample_rate * 3),
        source="input.wav",
        estimated_noise_dbfs=-80.0,
        effective_noise_dbfs=-80.0,
        peak_dbfs=-10.0,
        start_threshold_dbfs=-65.0,
        stop_threshold_dbfs=-68.0,
        activity_regions=(
            ActivityRegion(
                start_sample=start_sample,
                end_sample=end_sample,
                peak_dbfs=-10.0,
                mean_dbfs=-15.0,
                end_reason="silence",
            ),
        ),
        segments=(
            Segment(
                start_sample=start_sample,
                end_sample=end_sample,
                source_region=0,
            ),
        ),
        warnings=(),
        config=SegmentationConfig(),
        frame_levels=(),
    )


def test_json_contains_reproducible_schema_and_sample_boundaries() -> None:
    result = _result()

    payload = result_to_dict(result)
    parsed = json.loads(render_json(result))

    assert payload == parsed
    assert payload["schema"] == "audseg.result/v1"
    assert payload["source"] == "input.wav"
    assert payload["segments"][0]["start_sample"] == 16_000
    assert payload["segments"][0]["start_ms"] == 1_000
    assert payload["config"]["detector"]["frame_ms"] == 20.0


def test_srt_and_vtt_use_visible_editing_placeholder() -> None:
    result = _result()

    srt = render_srt(result)
    vtt = render_vtt(result, placeholder="cue {index}")

    assert "00:00:01,000 --> 00:00:02,000" in srt
    assert "[…]" in srt
    assert vtt.startswith("WEBVTT\n")
    assert "00:00:01.000 --> 00:00:02.000" in vtt
    assert "cue 1" in vtt


def test_timestamp_hours_do_not_wrap_after_24_hours() -> None:
    sample_rate = 1_000
    start = 25 * 3_600 * sample_rate
    result = _result(
        start_sample=start,
        end_sample=start + sample_rate,
        sample_rate=sample_rate,
    )

    srt = render_srt(result)

    assert "25:00:00,000 --> 25:00:01,000" in srt


def test_json_identifies_fixed_threshold_mode() -> None:
    original = _result()
    fixed_result = SegmentationResult(
        sample_rate_hz=original.sample_rate_hz,
        total_samples=original.total_samples,
        source=original.source,
        estimated_noise_dbfs=original.estimated_noise_dbfs,
        effective_noise_dbfs=original.effective_noise_dbfs,
        peak_dbfs=original.peak_dbfs,
        start_threshold_dbfs=-30.0,
        stop_threshold_dbfs=-34.0,
        activity_regions=original.activity_regions,
        segments=original.segments,
        warnings=original.warnings,
        config=SegmentationConfig(detector=DetectorConfig(fixed_threshold_dbfs=-30.0)),
        frame_levels=(),
    )

    analysis = result_to_dict(fixed_result)["analysis"]

    assert analysis["threshold_mode"] == "fixed"
    assert analysis["algorithm"] == "dc-removed-rms-fixed-hysteresis"


def test_submillisecond_cues_are_rejected_instead_of_stretching_timeline() -> None:
    sample_rate = 48_000
    result = SegmentationResult(
        sample_rate_hz=sample_rate,
        total_samples=2,
        source=None,
        estimated_noise_dbfs=-120.0,
        effective_noise_dbfs=-120.0,
        peak_dbfs=-10.0,
        start_threshold_dbfs=-65.0,
        stop_threshold_dbfs=-68.0,
        activity_regions=(
            ActivityRegion(
                start_sample=0,
                end_sample=2,
                peak_dbfs=-10.0,
                mean_dbfs=-10.0,
                end_reason="eof",
            ),
        ),
        segments=(
            Segment(start_sample=0, end_sample=1, source_region=0),
            Segment(start_sample=1, end_sample=2, source_region=0),
        ),
        warnings=(),
        config=SegmentationConfig(),
        frame_levels=(),
    )

    with pytest.raises(ValueError, match="1 ms timebase"):
        render_vtt(result)
