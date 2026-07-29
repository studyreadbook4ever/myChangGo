"""AudSeg exception hierarchy."""


class AudSegError(Exception):
    """Base class for expected AudSeg failures."""


class DecodeError(AudSegError):
    """Raised when an audio source cannot be decoded."""


class UnsupportedWaveError(DecodeError):
    """Raised when the standard-library WAV decoder cannot read a file."""


class FFmpegNotFoundError(DecodeError):
    """Raised when FFmpeg decoding is requested but the executable is absent."""
