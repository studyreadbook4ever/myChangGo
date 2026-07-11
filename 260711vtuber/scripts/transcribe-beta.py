#!/usr/bin/env python3
"""Transcribe a local media file with faster-whisper and emit raw JSON/SRT."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

os.environ.setdefault("HF_HUB_OFFLINE", "1")

from faster_whisper import WhisperModel


DEFAULT_MODEL_DIR = Path(
    os.environ.get(
        "KIRINUKI_MODEL_DIR",
        str(Path(__file__).resolve().parents[1] / ".beta-tools" / "models"),
    )
)


def srt_timestamp(seconds: float) -> str:
    milliseconds = max(0, round(seconds * 1000))
    hours, remainder = divmod(milliseconds, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    secs, millis = divmod(remainder, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path)
    parser.add_argument("--json", dest="json_path", type=Path, default=Path("raw-transcript.json"))
    parser.add_argument("--srt", dest="srt_path", type=Path, default=Path("raw-transcript.srt"))
    parser.add_argument("--model", default="base")
    parser.add_argument("--model-dir", type=Path, default=DEFAULT_MODEL_DIR)
    args = parser.parse_args()

    model = WhisperModel(
        args.model,
        device="cpu",
        compute_type="int8",
        download_root=str(args.model_dir),
    )
    segments, info = model.transcribe(
        str(args.input),
        language="ko",
        beam_size=5,
        vad_filter=True,
        word_timestamps=True,
        condition_on_previous_text=False,
    )
    rows = []
    for segment in segments:
        rows.append({
            "id": segment.id,
            "start": round(segment.start, 3),
            "end": round(segment.end, 3),
            "text": segment.text.strip(),
            "words": [
                {
                    "start": round(word.start, 3) if word.start is not None else None,
                    "end": round(word.end, 3) if word.end is not None else None,
                    "word": word.word,
                    "probability": round(word.probability, 4),
                }
                for word in (segment.words or [])
            ],
        })

    payload = {
        "model": args.model,
        "language": info.language,
        "languageProbability": round(info.language_probability, 4),
        "duration": round(info.duration, 3),
        "segments": rows,
    }
    args.json_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    srt = "\n\n".join(
        f"{index}\n{srt_timestamp(row['start'])} --> {srt_timestamp(row['end'])}\n{row['text']}"
        for index, row in enumerate(rows, start=1)
    )
    args.srt_path.write_text(srt + "\n", encoding="utf-8")
    print(json.dumps({
        "language": payload["language"],
        "languageProbability": payload["languageProbability"],
        "duration": payload["duration"],
        "segments": len(rows),
        "json": str(args.json_path),
        "srt": str(args.srt_path),
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
