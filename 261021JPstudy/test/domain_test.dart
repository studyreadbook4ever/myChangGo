import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';

import 'package:jpstudy/domain.dart';

void main() {
  final start = DateTime.utc(2026, 10, 21, 12);
  CardProgress review(
    ReviewRating rating, {
    CardProgress? previous,
    DateTime? now,
  }) => scheduleReview(
    id: 'day',
    mode: StudyMode.reading,
    rating: rating,
    now: now ?? start,
    previous: previous,
  );

  group('SM-2-inspired intervals', () {
    test(
      'new ratings have distinct, explicit relearning and recall intervals',
      () {
        expect(
          review(ReviewRating.again).dueAt,
          start.add(const Duration(minutes: 10)),
        );
        expect(
          review(ReviewRating.hard).dueAt,
          start.add(const Duration(minutes: 30)),
        );
        expect(
          review(ReviewRating.good).dueAt,
          start.add(const Duration(days: 1)),
        );
        expect(
          review(ReviewRating.easy).dueAt,
          start.add(const Duration(days: 4)),
        );
        expect(review(ReviewRating.again).lapses, 1);
        expect(review(ReviewRating.hard).repetitions, 0);
      },
    );

    test('success grows recall interval and a lapse returns to relearning', () {
      var p = review(ReviewRating.good);
      expect(p.intervalDays, 1);
      p = review(ReviewRating.good, previous: p, now: p.dueAt);
      expect(p.intervalDays, 3);
      p = review(ReviewRating.good, previous: p, now: p.dueAt);
      expect(p.intervalDays, 8);
      final failed = review(ReviewRating.again, previous: p, now: p.dueAt);
      expect(failed.repetitions, 0);
      expect(failed.intervalDays, 0);
      expect(failed.lapses, 1);
      expect(failed.reviewCount, 4);
      expect(failed.introducedAt, start);
      final relearned = review(
        ReviewRating.good,
        previous: failed,
        now: failed.dueAt,
      );
      expect(relearned.intervalDays, 1);
      expect(relearned.lapses, 1);
    });

    test(
      'Hard on an established card keeps a day interval without new success',
      () {
        final prior = review(ReviewRating.good);
        final hard = review(
          ReviewRating.hard,
          previous: prior,
          now: prior.dueAt,
        );
        expect(hard.intervalDays, 2);
        expect(hard.repetitions, 1);
        expect(hard.ease, closeTo(2.35, 0.001));
      },
    );

    test(
      'Good never shortens an interval previously earned with Easy or Hard',
      () {
        final easy = review(ReviewRating.easy);
        final good = review(ReviewRating.good, previous: easy, now: easy.dueAt);
        expect(good.intervalDays, greaterThanOrEqualTo(easy.intervalDays));
        var hard = easy;
        for (var i = 0; i < 4; i++) {
          hard = review(ReviewRating.hard, previous: hard, now: hard.dueAt);
        }
        final afterHard = review(
          ReviewRating.good,
          previous: hard,
          now: hard.dueAt,
        );
        expect(afterHard.intervalDays, greaterThanOrEqualTo(hard.intervalDays));
      },
    );

    test('ease and long-term intervals are bounded after repeated ratings', () {
      CardProgress? p;
      for (var i = 0; i < 100; i++) {
        p = review(ReviewRating.again, previous: p);
      }
      expect(p!.ease, 1.3);
      expect(p.lapses, 100);
      for (var i = 0; i < 100; i++) {
        p = review(ReviewRating.easy, previous: p);
      }
      expect(p!.ease, 3);
      expect(p.intervalDays, 3650);
      expect(p.reviewCount, 200);
    });

    test(
      'each review track is independent and mismatched state is rejected',
      () {
        final reading = review(ReviewRating.good);
        expect(
          () => scheduleReview(
            id: 'day',
            mode: StudyMode.meaning,
            rating: ReviewRating.good,
            now: start,
            previous: reading,
          ),
          throwsArgumentError,
        );
      },
    );

    test('due comparison includes the exact scheduled instant', () {
      final p = review(ReviewRating.again);
      expect(
        p.isDue(p.dueAt.subtract(const Duration(microseconds: 1))),
        isFalse,
      );
      expect(p.isDue(p.dueAt), isTrue);
    });

    test('backwards clock does not reverse review chronology', () {
      final p = review(ReviewRating.good);
      final earlier = review(
        ReviewRating.again,
        previous: p,
        now: start.subtract(const Duration(days: 1)),
      );
      expect(earlier.lastReviewedAt, start);
      expect(earlier.dueAt.isAfter(start), isTrue);
      expect(() => CardProgress.fromJson(earlier.toJson()), returnsNormally);
    });
  });

  group('validated model serialization', () {
    test('progress preserves all fields across JSON', () {
      final p = review(ReviewRating.easy);
      final restored = CardProgress.fromJson(
        jsonDecode(jsonEncode(p.toJson())),
      );
      expect(restored.toJson(), p.toJson());
      expect(restored.key, 'day:reading');
    });

    test('malformed progress types, enum, ease, and dates are rejected', () {
      final original = review(ReviewRating.good).toJson();
      for (final change in [
        {'reviewCount': 1.5},
        {'reviewCount': 0},
        {'intervalDays': -1},
        {'ease': double.nan},
        {'ease': 99},
        {'mode': 'listening'},
        {'lastRating': 'great'},
        {'lastRating': 'again'},
        {'repetitions': 0},
        {'dueAt': '2026-10-30'},
        {'dueAt': '2026-02-31T12:00:00.000Z'},
        {'dueAt': '2026-01-01T12:00:00.000Z'},
        {'dueAt': '2026-10-23T12:00:00.000Z'},
        {'repetitions': 2},
        {'lapses': 2},
      ]) {
        expect(
          () => CardProgress.fromJson({...original, ...change}),
          throwsFormatException,
          reason: change.toString(),
        );
      }
    });

    test('vocabulary validates required fields and JLPT level', () {
      final raw = <String, dynamic>{
        'id': 'day',
        'word': '日',
        'reading': 'ひ',
        'meaning': '날; 해',
        'level': 5,
        'topic': '시간',
        'example': 'いい日です。',
        'exampleReading': 'いいひです。',
        'exampleMeaning': '좋은 날입니다.',
        'note': '',
      };
      expect(Vocabulary.fromJson(raw).level, 5);
      expect(
        () => Vocabulary.fromJson({...raw, 'reading': ''}),
        throwsFormatException,
      );
      expect(
        () => Vocabulary.fromJson({...raw, 'level': 6}),
        throwsFormatException,
      );
    });

    test('kanji reading lists from assets are immutable', () {
      final kanji = KanjiInfo.fromJson({
        'character': '日',
        'korean': '날 일',
        'onyomi': ['ニチ', 'ジツ'],
        'kunyomi': ['ひ', 'か'],
        'hint': '해와 날의 뜻',
      });
      expect(kanji.korean, '날 일');
      expect(() => kanji.onyomi.add('x'), throwsUnsupportedError);
    });
  });
}
