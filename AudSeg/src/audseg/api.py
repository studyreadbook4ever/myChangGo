"""Stable high-level library API."""

from __future__ import annotations

from collections.abc import Iterable
from pathlib import Path

from .config import SegmentationConfig
from .decode import decode_file
from .detector import detect_activity
from .models import SegmentationResult
from .pcm import iter_pcm16_mono
from .postprocess import plan_cues


def _warnings(
    *,
    total_samples: int,
    regions_active_samples: int,
    region_count: int,
    estimated_noise_dbfs: float,
    effective_noise_dbfs: float,
    peak_dbfs: float,
) -> tuple[str, ...]:
    warnings: list[str] = []
    if total_samples == 0:
        warnings.append("empty_audio")
    elif region_count == 0:
        warnings.append("no_activity_detected")
    if total_samples and regions_active_samples / total_samples >= 0.95:
        warnings.append("nearly_continuous_activity")
    if peak_dbfs - effective_noise_dbfs < 6.0 and peak_dbfs > -120.0:
        warnings.append("low_level_contrast")
    if estimated_noise_dbfs > effective_noise_dbfs:
        warnings.append("noise_floor_capped")
    return tuple(warnings)


def segment_samples(
    samples: Iterable[float],
    sample_rate_hz: int,
    config: SegmentationConfig | None = None,
    *,
    source: str | None = None,
) -> SegmentationResult:
    """Segment normalized mono PCM samples.

    ``samples`` may be any iterable, including a generator. The detector keeps
    frame-level statistics rather than the full waveform in memory.
    """

    applied_config = config or SegmentationConfig()
    analysis = detect_activity(samples, sample_rate_hz, applied_config.detector)
    segments = plan_cues(
        analysis.regions,
        analysis.frame_levels,
        sample_rate_hz,
        applied_config.cues,
    )
    active_samples = sum(region.end_sample - region.start_sample for region in analysis.regions)
    return SegmentationResult(
        sample_rate_hz=sample_rate_hz,
        total_samples=analysis.total_samples,
        source=source,
        estimated_noise_dbfs=analysis.estimated_noise_dbfs,
        effective_noise_dbfs=analysis.effective_noise_dbfs,
        peak_dbfs=analysis.peak_dbfs,
        start_threshold_dbfs=analysis.start_threshold_dbfs,
        stop_threshold_dbfs=analysis.stop_threshold_dbfs,
        activity_regions=analysis.regions,
        segments=segments,
        warnings=_warnings(
            total_samples=analysis.total_samples,
            regions_active_samples=active_samples,
            region_count=len(analysis.regions),
            estimated_noise_dbfs=analysis.estimated_noise_dbfs,
            effective_noise_dbfs=analysis.effective_noise_dbfs,
            peak_dbfs=analysis.peak_dbfs,
        ),
        config=applied_config,
        frame_levels=analysis.frame_levels,
    )


def segment_pcm16(
    chunks: bytes | bytearray | memoryview | Iterable[bytes],
    sample_rate_hz: int,
    *,
    channels: int = 1,
    config: SegmentationConfig | None = None,
    source: str | None = None,
) -> SegmentationResult:
    """Segment little-endian signed PCM16 bytes, with arbitrary chunking."""

    samples = iter_pcm16_mono(chunks, channels=channels)
    return segment_samples(samples, sample_rate_hz, config, source=source)


def segment_file(
    path: str | Path,
    config: SegmentationConfig | None = None,
    *,
    decoder: str = "auto",
    ffmpeg: str = "ffmpeg",
    ffmpeg_sample_rate_hz: int = 16_000,
) -> SegmentationResult:
    """Segment an audio file.

    Uncompressed PCM WAV is read with the standard library. Other formats use
    the optional FFmpeg executable and are converted to mono PCM16.
    """

    source = Path(path)
    decoded = decode_file(
        source,
        decoder=decoder,
        ffmpeg=ffmpeg,
        ffmpeg_sample_rate_hz=ffmpeg_sample_rate_hz,
    )
    return segment_samples(
        decoded.samples,
        decoded.sample_rate_hz,
        config,
        source=source.name,
    )


class Segmenter:
    """Reusable configured segmenter facade."""

    def __init__(
        self,
        config: SegmentationConfig | None = None,
        *,
        decoder: str = "auto",
        ffmpeg: str = "ffmpeg",
        ffmpeg_sample_rate_hz: int = 16_000,
    ) -> None:
        self.config = config or SegmentationConfig()
        self.decoder = decoder
        self.ffmpeg = ffmpeg
        self.ffmpeg_sample_rate_hz = ffmpeg_sample_rate_hz

    def samples(
        self,
        samples: Iterable[float],
        sample_rate_hz: int,
        *,
        source: str | None = None,
    ) -> SegmentationResult:
        return segment_samples(
            samples,
            sample_rate_hz,
            self.config,
            source=source,
        )

    def pcm16(
        self,
        chunks: bytes | bytearray | memoryview | Iterable[bytes],
        sample_rate_hz: int,
        *,
        channels: int = 1,
        source: str | None = None,
    ) -> SegmentationResult:
        return segment_pcm16(
            chunks,
            sample_rate_hz,
            channels=channels,
            config=self.config,
            source=source,
        )

    def file(self, path: str | Path) -> SegmentationResult:
        return segment_file(
            path,
            self.config,
            decoder=self.decoder,
            ffmpeg=self.ffmpeg,
            ffmpeg_sample_rate_hz=self.ffmpeg_sample_rate_hz,
        )
