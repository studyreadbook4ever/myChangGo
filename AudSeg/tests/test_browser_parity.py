from __future__ import annotations

import json
import struct
from pathlib import Path
from typing import Any

import pytest

from audseg import CuePolicy, DetectorConfig, SegmentationConfig, segment_samples

FIXTURE_PATH = Path(__file__).parent / "fixtures" / "browser_python_golden.json"


def _load_fixture() -> dict[str, Any]:
    return json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))


def _float32(value: float) -> float:
    return struct.unpack("<f", struct.pack("<f", value))[0]


def _samples(chunks: list[dict[str, Any]]) -> list[float]:
    samples: list[float] = []
    for chunk in chunks:
        sample_count = int(chunk["sample_count"])
        if chunk["kind"] == "constant":
            samples.extend([_float32(float(chunk["value"]))] * sample_count)
        elif chunk["kind"] == "alternating":
            amplitude = _float32(float(chunk["amplitude"]))
            samples.extend(amplitude if index % 2 == 0 else -amplitude for index in range(sample_count))
        else:
            raise AssertionError(f"unsupported fixture chunk: {chunk['kind']}")
    return samples


def _region_boundaries(result: Any) -> list[list[int | str]]:
    return [[region.start_sample, region.end_sample, region.end_reason] for region in result.activity_regions]


def _segment_boundaries(result: Any) -> list[list[int | str | bool | None]]:
    return [
        [
            segment.start_sample,
            segment.end_sample,
            segment.source_region,
            segment.forced_split,
            segment.split_method,
        ]
        for segment in result.segments
    ]


GOLDEN = _load_fixture()
CASES = GOLDEN["cases"]


@pytest.mark.parametrize("case", CASES, ids=[case["id"] for case in CASES])
def test_browser_python_golden_boundaries(case: dict[str, Any]) -> None:
    assert GOLDEN["schema"] == "audseg.browser-python-golden/v1"
    config = SegmentationConfig(
        detector=DetectorConfig(**GOLDEN["config"]["detector"]),
        cues=CuePolicy(**GOLDEN["config"]["cues"]),
    )
    result = segment_samples(
        _samples(case["chunks"]),
        int(GOLDEN["sample_rate_hz"]),
        config,
    )
    expected = case["expected"]

    assert result.total_samples == expected["total_samples"]
    assert _region_boundaries(result) == expected["activity_regions"]
    assert _segment_boundaries(result) == expected["segments"]
    assert list(result.warnings) == expected["warnings"]
    assert all(segment.end_sample - segment.start_sample <= 4 * result.sample_rate_hz for segment in result.segments)
