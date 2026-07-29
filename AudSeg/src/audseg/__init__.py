"""AudSeg: model-free audio activity segmentation."""

from .api import Segmenter, segment_file, segment_pcm16, segment_samples
from .config import CuePolicy, DetectorConfig, SegmentationConfig
from .errors import AudSegError, DecodeError, FFmpegNotFoundError, UnsupportedWaveError
from .formats import render_json, render_srt, render_vtt, result_to_dict
from .models import ActivityRegion, FrameLevel, Segment, SegmentationResult

__all__ = [
    "ActivityRegion",
    "AudSegError",
    "CuePolicy",
    "DecodeError",
    "DetectorConfig",
    "FFmpegNotFoundError",
    "FrameLevel",
    "Segment",
    "SegmentationConfig",
    "SegmentationResult",
    "Segmenter",
    "UnsupportedWaveError",
    "segment_file",
    "segment_pcm16",
    "segment_samples",
    "render_json",
    "render_srt",
    "render_vtt",
    "result_to_dict",
]

__version__ = "0.1.0"
