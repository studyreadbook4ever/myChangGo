"""Command-line interface for AudSeg."""

from __future__ import annotations

import argparse
import os
import sys
import tempfile
from collections.abc import Sequence
from pathlib import Path

from .api import segment_file
from .config import CuePolicy, DetectorConfig, SegmentationConfig
from .errors import AudSegError
from .formats import render


def _parser() -> argparse.ArgumentParser:
    detector = DetectorConfig()
    cues = CuePolicy()
    parser = argparse.ArgumentParser(
        prog="audseg",
        description=("Detect audio activity without ML and create editable blank subtitle cues."),
    )
    parser.add_argument("input", help="input audio file")
    parser.add_argument(
        "-o",
        "--output",
        help="output file; omit or use '-' for stdout",
    )
    parser.add_argument(
        "--format",
        choices=("json", "srt", "vtt"),
        help="output format; inferred from --output suffix when possible",
    )
    parser.add_argument(
        "--placeholder",
        default="[…]",
        help="SRT/VTT cue payload; '{index}' is replaced with the cue number",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="replace an existing output file atomically",
    )
    parser.add_argument(
        "--compact-json",
        action="store_true",
        help="write JSON without indentation",
    )
    parser.add_argument(
        "--decoder",
        choices=("auto", "wave", "ffmpeg"),
        default="auto",
        help="built-in PCM WAV decoder or optional FFmpeg",
    )
    parser.add_argument(
        "--ffmpeg",
        default="ffmpeg",
        help="FFmpeg executable name or path",
    )
    parser.add_argument(
        "--ffmpeg-sample-rate",
        type=int,
        default=16_000,
        metavar="HZ",
        help="sample rate used by the FFmpeg decoder (default: 16000)",
    )
    parser.add_argument(
        "--fixed-threshold-dbfs",
        type=float,
        help="disable adaptive thresholding and use this onset level",
    )
    parser.add_argument(
        "--frame-ms",
        type=float,
        default=detector.frame_ms,
        help=f"analysis frame length (default: {detector.frame_ms:g})",
    )
    parser.add_argument(
        "--hop-ms",
        type=float,
        default=detector.hop_ms,
        help=f"analysis hop length (default: {detector.hop_ms:g})",
    )
    parser.add_argument(
        "--noise-percentile",
        type=float,
        default=detector.noise_percentile,
        help=f"adaptive noise quantile from 0 to 1 (default: {detector.noise_percentile:g})",
    )
    parser.add_argument(
        "--on-margin-db",
        type=float,
        default=detector.on_margin_db,
        help=f"onset margin above noise floor (default: {detector.on_margin_db:g})",
    )
    parser.add_argument(
        "--off-margin-db",
        type=float,
        default=detector.off_margin_db,
        help=f"release margin above noise floor (default: {detector.off_margin_db:g})",
    )
    parser.add_argument(
        "--onset-ms",
        type=float,
        default=detector.onset_ms,
        help=f"continuous activity required to open (default: {detector.onset_ms:g})",
    )
    parser.add_argument(
        "--release-ms",
        type=float,
        default=detector.release_ms,
        help=f"quiet time required to close (default: {detector.release_ms:g})",
    )
    parser.add_argument(
        "--min-region-ms",
        type=float,
        default=detector.min_region_ms,
        help=f"discard shorter raw activity (default: {detector.min_region_ms:g})",
    )
    parser.add_argument(
        "--merge-gap-ms",
        type=float,
        default=detector.merge_gap_ms,
        help=f"merge raw regions across shorter gaps (default: {detector.merge_gap_ms:g})",
    )
    parser.add_argument(
        "--pad-start-ms",
        type=float,
        default=detector.pad_start_ms,
        help=f"leading context padding (default: {detector.pad_start_ms:g})",
    )
    parser.add_argument(
        "--pad-end-ms",
        type=float,
        default=detector.pad_end_ms,
        help=f"trailing context padding (default: {detector.pad_end_ms:g})",
    )
    parser.add_argument(
        "--max-cue-ms",
        type=float,
        default=cues.max_duration_ms,
        help=f"maximum planned cue length (default: {cues.max_duration_ms:g})",
    )
    parser.add_argument(
        "--no-cue-split",
        action="store_true",
        help="keep each detected activity region as one cue",
    )
    parser.add_argument(
        "--split-search-ms",
        type=float,
        default=cues.split_search_ms,
        help=f"quiet-valley search before a hard split (default: {cues.split_search_ms:g})",
    )
    parser.add_argument(
        "--diagnostics",
        action="store_true",
        help="print a short analysis summary to stderr",
    )
    return parser


def _output_format(output: str | None, explicit: str | None) -> str:
    if explicit is not None:
        return explicit
    if output and output != "-":
        suffix = Path(output).suffix.lower().lstrip(".")
        if suffix in {"json", "srt", "vtt"}:
            return suffix
    return "json"


def _config(args: argparse.Namespace) -> SegmentationConfig:
    defaults = DetectorConfig()
    detector = DetectorConfig(
        frame_ms=args.frame_ms,
        hop_ms=args.hop_ms,
        noise_percentile=args.noise_percentile,
        noise_ceiling_dbfs=defaults.noise_ceiling_dbfs,
        minimum_on_dbfs=defaults.minimum_on_dbfs,
        minimum_off_dbfs=defaults.minimum_off_dbfs,
        on_margin_db=args.on_margin_db,
        off_margin_db=args.off_margin_db,
        peak_guard_db=defaults.peak_guard_db,
        hysteresis_db=defaults.hysteresis_db,
        fixed_threshold_dbfs=args.fixed_threshold_dbfs,
        onset_ms=args.onset_ms,
        release_ms=args.release_ms,
        min_region_ms=args.min_region_ms,
        merge_gap_ms=args.merge_gap_ms,
        pad_start_ms=args.pad_start_ms,
        pad_end_ms=args.pad_end_ms,
    )
    cues = CuePolicy(
        max_duration_ms=None if args.no_cue_split else args.max_cue_ms,
        min_split_duration_ms=CuePolicy().min_split_duration_ms,
        split_search_ms=args.split_search_ms,
    )
    return SegmentationConfig(detector=detector, cues=cues)


def _write_atomic(path: Path, content: str, *, force: bool) -> None:
    if os.path.lexists(path) and not force:
        raise FileExistsError(f"output already exists (pass --force to replace it): {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            newline="\n",
            prefix=f".{path.name}.",
            suffix=".tmp",
            dir=path.parent,
            delete=False,
        ) as temporary:
            temporary.write(content)
            temporary.flush()
            os.fsync(temporary.fileno())
            temporary_path = Path(temporary.name)
        if force:
            os.replace(temporary_path, path)
        else:
            try:
                os.link(temporary_path, path)
            except FileExistsError as exc:
                raise FileExistsError(f"output already exists (pass --force to replace it): {path}") from exc
            temporary_path.unlink()
        temporary_path = None
    finally:
        if temporary_path is not None and temporary_path.exists():
            temporary_path.unlink()


def main(argv: Sequence[str] | None = None) -> int:
    parser = _parser()
    args = parser.parse_args(argv)
    try:
        config = _config(args)
        result = segment_file(
            args.input,
            config,
            decoder=args.decoder,
            ffmpeg=args.ffmpeg,
            ffmpeg_sample_rate_hz=args.ffmpeg_sample_rate,
        )
        output_format = _output_format(args.output, args.format)
        content = render(
            result,
            output_format,
            placeholder=args.placeholder,
            compact_json=args.compact_json,
        )

        if not args.output or args.output == "-":
            sys.stdout.write(content)
            if content and not content.endswith("\n"):
                sys.stdout.write("\n")
        else:
            _write_atomic(Path(args.output), content, force=args.force)

        if args.diagnostics:
            sys.stderr.write(
                "audseg: "
                f"{len(result.activity_regions)} region(s), "
                f"{len(result.segments)} cue(s), "
                f"{result.active_ratio:.1%} active, "
                f"threshold {result.start_threshold_dbfs:.1f}/"
                f"{result.stop_threshold_dbfs:.1f} dBFS"
                + (f", warnings={','.join(result.warnings)}" if result.warnings else "")
                + "\n"
            )
        return 0
    except (AudSegError, FileExistsError, OSError, ValueError) as exc:
        sys.stderr.write(f"audseg: error: {exc}\n")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
