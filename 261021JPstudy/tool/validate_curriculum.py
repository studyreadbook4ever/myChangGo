#!/usr/bin/env python3
"""Strict offline validation of the shipped Korean/Japanese study curriculum.

Validates structure and script consistency, not the truth of every translation or
JLPT level. Editorial review remains necessary for new or changed language data.
No network access or third-party dependencies required.
"""
from __future__ import annotations
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
KANJI_RE = re.compile(r'[\u3400-\u4dbf\u4e00-\u9fff]')
HIRAGANA_RE = re.compile(r'[ぁ-ゖー]+')
EXAMPLE_RE = re.compile(r'[ぁ-ゖー、。！？「」『』（）・\s!?]+')
KATAKANA_RE = re.compile(r'[ァ-ヶー]+')
JOSA_RE = re.compile(r'은/는|이/가|을/를|과/와|으로/로|로/으로')
WORD_KEYS = {'id', 'word', 'reading', 'meaning', 'level', 'topic', 'example',
             'exampleReading', 'exampleMeaning', 'note'}
KANJI_KEYS = {'character', 'korean', 'onyomi', 'kunyomi', 'hint'}


def validate(root=ROOT):
    errors = []
    def check(condition, message):
        if not condition:
            errors.append(message)
    try:
        words = json.loads((root / 'assets/data/vocabulary.json').read_text(encoding='utf-8'))
        chars = json.loads((root / 'assets/data/kanji.json').read_text(encoding='utf-8'))
    except (OSError, ValueError) as exc:
        return [str(exc)], {}
    if not isinstance(words, list) or not isinstance(chars, list):
        return ['Both JSON roots must be arrays.'], {}
    seen_ids, seen_words, seen_chars = set(), set(), set()
    levels = Counter()
    character_frequency = Counter()
    literal_examples_checked = 0
    previous_level = 6
    for i, w in enumerate(words):
        label = f'vocabulary[{i}]'
        if not isinstance(w, dict):
            errors.append(f'{label}: expected object')
            continue
        check(set(w) == WORD_KEYS, f'{label}: missing/extra fields {set(w) ^ WORD_KEYS}')
        if set(w) != WORD_KEYS:
            continue
        for key in WORD_KEYS - {'level'}:
            check(isinstance(w[key], str), f'{label}.{key}: expected string')
        if any(not isinstance(w[key], str) for key in WORD_KEYS - {'level'}):
            continue
        label += f' ({w["word"]})'
        for key in WORD_KEYS - {'level', 'note'}:
            check(bool(w[key].strip()), f'{label}.{key}: empty')
        for key in WORD_KEYS - {'level'}:
            check(w[key] == w[key].strip(), f'{label}.{key}: surrounding whitespace')
            check('\n' not in w[key] and '\r' not in w[key], f'{label}.{key}: unexpected newline')
            check('\ufffd' not in w[key], f'{label}.{key}: replacement character')
            check(not re.search(r'TODO|TBD|PLACEHOLDER|lorem ipsum', w[key], re.I),
                  f'{label}.{key}: unfinished placeholder')
        expected_id = 'jp_' + hashlib.sha256(f'{w["word"]}:{w["reading"]}'.encode()).hexdigest()[:12]
        check(w['id'] == expected_id, f'{label}: ID must remain tied to spelling and reading')
        check(w['id'] not in seen_ids, f'{label}: duplicate ID')
        check(w['word'] not in seen_words, f'{label}: duplicate word spelling')
        seen_ids.add(w['id'])
        seen_words.add(w['word'])
        valid_level = type(w['level']) is int and 1 <= w['level'] <= 5
        check(valid_level, f'{label}: level must be integer 1..5')
        if valid_level:
            levels[w['level']] += 1
            check(w['level'] <= previous_level, f'{label}: corpus must run from N5 toward N1')
            previous_level = w['level']
        check(bool(KANJI_RE.search(w['word'])), f'{label}: target word must include kanji')
        check(bool(HIRAGANA_RE.fullmatch(w['reading'])), f'{label}: reading must be hiragana')
        check(bool(EXAMPLE_RE.fullmatch(w['exampleReading'])),
              f'{label}: exampleReading contains kanji, Latin text, or unapproved punctuation')
        check(w['example'].endswith(('。', '？', '！')), f'{label}: example lacks Japanese sentence ending')
        check(w['exampleReading'].endswith(('。', '？', '！')),
              f'{label}: example reading lacks Japanese sentence ending')
        for key in ('meaning', 'topic', 'exampleMeaning'):
            check(bool(re.search(r'[가-힣]', w[key])), f'{label}.{key}: Korean text required')
            check(not JOSA_RE.search(w[key]), f'{label}.{key}: unresolved Korean particle')
        # When the exact headword appears uninflected, its displayed reading
        # should also appear. Inflected examples require editorial review.
        if w['word'] in w['example']:
            literal_examples_checked += 1
            check(w['reading'] in w['exampleReading'],
                  f'{label}: literal headword reading missing from exampleReading')
        character_frequency.update(KANJI_RE.findall(w['word']))

    for i, k in enumerate(chars):
        label = f'kanji[{i}]'
        if not isinstance(k, dict):
            errors.append(f'{label}: expected object')
            continue
        check(set(k) == KANJI_KEYS, f'{label}: missing/extra fields {set(k) ^ KANJI_KEYS}')
        if set(k) != KANJI_KEYS:
            continue
        check(isinstance(k['character'], str) and bool(KANJI_RE.fullmatch(k['character'])),
              f'{label}: character must be exactly one kanji')
        if not isinstance(k['character'], str):
            continue
        label += f' ({k["character"]})'
        check(k['character'] not in seen_chars, f'{label}: duplicate character')
        seen_chars.add(k['character'])
        check(isinstance(k['korean'], str) and bool(re.fullmatch(r'[가-힣]+(?: [가-힣]+)+', k['korean'])),
              f'{label}: Korean hun/eum expected')
        check(isinstance(k['hint'], str) and k['hint'].startswith('기억 힌트(어원 설명 아님): '),
              f'{label}: memory hint must be labelled as non-etymology')
        for key, pattern in [('onyomi', KATAKANA_RE), ('kunyomi', HIRAGANA_RE)]:
            values = k[key]
            check(isinstance(values, list), f'{label}.{key}: expected array')
            if not isinstance(values, list):
                continue
            check(all(isinstance(x, str) and pattern.fullmatch(x) for x in values),
                  f'{label}.{key}: invalid reading/script')
            if all(isinstance(x, str) for x in values):
                check(len(values) == len(set(values)), f'{label}.{key}: duplicate representative reading')
        check(bool(k['onyomi'] or k['kunyomi']), f'{label}: at least one reading required')

    check(len(words) >= 1000, 'Expected at least 1,000 curated words')
    check(len(chars) >= 120, 'Expected at least 120 foundational kanji cards')
    for level, minimum in {5: 180, 4: 160, 3: 160, 2: 200, 1: 300}.items():
        check(levels[level] >= minimum, f'N{level}: expected >= {minimum}, got {levels[level]}')
    covered = set(character_frequency) & seen_chars
    full_coverage = sum(all(c in seen_chars for c in KANJI_RE.findall(w['word']))
                        for w in words if isinstance(w, dict) and isinstance(w.get('word'), str))
    missing = [(c, n) for c, n in character_frequency.most_common() if c not in seen_chars]
    report = dict(words=len(words), kanjiCards=len(chars),
                  levels={f'N{level}': levels[level] for level in range(5, 0, -1)},
                  uniqueWordKanji=len(character_frequency), coveredUniqueKanji=len(covered),
                  wordsWithEveryKanjiCard=full_coverage,
                  wordsWithSomeKanjiCard=sum(any(c in seen_chars for c in KANJI_RE.findall(w['word']))
                                             for w in words if isinstance(w, dict) and isinstance(w.get('word'), str)),
                  literalExampleReadingsChecked=literal_examples_checked,
                  uncoveredKanji=[dict(character=c, wordOccurrences=n) for c, n in missing])
    return errors, report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--json', action='store_true', help='Print machine-readable coverage report.')
    args = parser.parse_args()
    errors, report = validate()
    if errors:
        for error in errors:
            print('ERROR:', error, file=sys.stderr)
        return 1
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print(f'PASS: {report["words"]} words; {report["kanjiCards"]} kanji cards; '
              + ', '.join(f'{k}={v}' for k, v in report['levels'].items()))
        print(f'Kanji-card coverage: {report["coveredUniqueKanji"]}/{report["uniqueWordKanji"]} unique word kanji; '
              f'{report["wordsWithEveryKanjiCard"]} words fully covered; '
              f'{report["wordsWithSomeKanjiCard"]} words with at least one card.')
        print(f'Literal headword/readings checked: {report["literalExampleReadingsChecked"]}. '
              'This check does not prove linguistic accuracy or official JLPT levels.')
        print('Frequent kanji without foundation cards: ' +
              ', '.join(f'{x["character"]}({x["wordOccurrences"]})' for x in report['uncoveredKanji'][:20]))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
