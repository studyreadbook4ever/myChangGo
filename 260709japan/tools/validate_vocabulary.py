#!/usr/bin/env python3
from __future__ import annotations

import csv
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
VOCABULARY = ROOT / "app" / "src" / "main" / "assets" / "vocabulary.tsv"
MIN_ROWS = 3000
KANJI_RE = re.compile(r"[\u3400-\u9fff]")
EASY_EXACT = {
    "私",
    "僕",
    "あなた",
    "学生",
    "先生",
    "学校",
    "犬",
    "猫",
    "水",
    "火",
    "山",
    "川",
    "本",
    "今日",
    "明日",
    "昨日",
    "名前",
    "友達",
    "家族",
    "日本",
}
BAD_TEXT_PATTERNS = (
    "하다한다",
    "하다하는",
    "管理이나",
    "관리이나",
)


def load_rows() -> list[dict[str, str]]:
    with VOCABULARY.open(encoding="utf-8", newline="") as file:
        return list(csv.DictReader(file, delimiter="\t"))


def main() -> None:
    rows = load_rows()
    if len(rows) < MIN_ROWS:
        raise SystemExit(f"Expected at least {MIN_ROWS} rows, found {len(rows)}")

    terms = [row["term"] for row in rows]
    duplicates = sorted({term for term in terms if terms.count(term) > 1})
    if duplicates:
        raise SystemExit(f"Duplicate terms found: {duplicates[:10]}")

    missing_kanji = [term for term in terms if not KANJI_RE.search(term)]
    if missing_kanji:
        raise SystemExit(f"Terms without kanji found: {missing_kanji[:10]}")

    too_easy = sorted(set(terms).intersection(EASY_EXACT))
    if too_easy:
        raise SystemExit(f"Too-basic terms found: {too_easy}")

    incomplete = [
        row["term"]
        for row in rows
        if not all(row[field].strip() for field in row)
    ]
    if incomplete:
        raise SystemExit(f"Incomplete rows found: {incomplete[:10]}")

    short_terms = [
        term
        for term in terms
        if len(term.replace("を", "").replace("する", "")) < 4
    ]
    if short_terms:
        raise SystemExit(f"Suspiciously short terms found: {short_terms[:10]}")

    bad_text_rows = [
        row["term"]
        for row in rows
        if any(pattern in "\t".join(row.values()) for pattern in BAD_TEXT_PATTERNS)
    ]
    if bad_text_rows:
        raise SystemExit(f"Bad generated text patterns found: {bad_text_rows[:10]}")

    print(f"Validated {len(rows)} generated vocabulary rows.")


if __name__ == "__main__":
    main()
