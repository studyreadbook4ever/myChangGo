"""Create an editable SRT timing draft from an audio file."""

from __future__ import annotations

import argparse
from pathlib import Path

from audseg import Segmenter
from audseg.formats import render_srt


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()

    result = Segmenter().file(args.input)
    args.output.write_text(render_srt(result), encoding="utf-8")
    print(f"wrote {len(result.segments)} cue(s) from {len(result.activity_regions)} activity region(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
