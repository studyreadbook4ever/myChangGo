import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:jpstudy/domain.dart';
import 'package:jpstudy/study_store.dart';

Vocabulary card(int index, {int level = 5}) => Vocabulary(
  id: 'word-$index',
  word: '日$index',
  reading: 'ひ',
  meaning: '날',
  level: level,
  topic: '시간',
  example: 'いい日です。',
  exampleReading: 'いいひです。',
  exampleMeaning: '좋은 날입니다.',
  note: '',
);

class ControlledPreferences extends Fake implements SharedPreferences {
  final values = <String, Object>{};
  bool failWrite = false;
  bool throwWrite = false;
  int reloads = 0;
  @override
  Object? get(String key) => values[key];
  @override
  Future<bool> setString(String key, String value) async {
    if (throwWrite) throw StateError('platform unavailable');
    if (failWrite) return false;
    values[key] = value;
    return true;
  }

  @override
  Future<void> reload() async {
    reloads++;
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late SharedPreferences preferences;
  late DateTime now;
  late List<Vocabulary> cards;
  late StudyStore store;

  StudyStore makeStore({SharedPreferences? prefs}) => StudyStore(
    preferences: prefs ?? preferences,
    cards: cards,
    kanji: {},
    clock: () => now,
  );
  Future<bool> grade(
    int index, {
    StudyMode mode = StudyMode.reading,
    ReviewRating rating = ReviewRating.good,
    int? expected,
  }) => store.grade('word-$index', mode, rating, expectedReviewCount: expected);

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    preferences = await SharedPreferences.getInstance();
    now = DateTime(2026, 10, 21, 12);
    cards = List.generate(40, (index) => card(index));
    store = makeStore();
  });

  group('curriculum and daily new-word budget', () {
    test('default N1 goal starts only ten foundational new words', () {
      expect(store.targetLevel, 1);
      expect(store.dailyNewLimit, 10);
      expect(store.buildSession(StudyMode.reading).length, 10);
      expect(store.buildSession(StudyMode.reading, limit: 0), isEmpty);
    });

    test(
      'N1 goal still introduces N5 foundations before more advanced words',
      () {
        cards = [
          card(0, level: 1),
          card(1, level: 4),
          card(2, level: 5),
          card(3, level: 3),
          card(4, level: 5),
        ];
        store = makeStore();
        expect(store.buildSession(StudyMode.reading).map((c) => c.id), [
          'word-2',
          'word-4',
          'word-1',
          'word-3',
          'word-0',
        ]);
      },
    );

    test('target N3 includes N5, N4, N3 in stable curriculum order', () async {
      cards = [
        card(0, level: 5),
        card(1, level: 4),
        card(2, level: 3),
        card(3, level: 2),
        card(4, level: 1),
      ];
      store = makeStore();
      await store.setTargetLevel(5);
      expect(store.eligibleCards.map((c) => c.level), [5]);
      await store.setTargetLevel(3);
      expect(store.buildSession(StudyMode.reading).map((c) => c.level), [
        5,
        4,
        3,
      ]);
      await store.setTargetLevel(1);
      expect(store.eligibleCards.length, 5);
      await expectLater(store.setTargetLevel(0), throwsArgumentError);
      expect(store.targetLevel, 1);
    });

    test(
      'session never exceeds twenty even with a large caller limit',
      () async {
        await store.setDailyNewLimit(100);
        expect(store.buildSession(StudyMode.reading, limit: 100).length, 20);
        expect(store.buildSession(StudyMode.reading, limit: 7).length, 7);
      },
    );

    test(
      'budget is consumed by unique words, not by ratings or second track',
      () async {
        await store.setDailyNewLimit(1);
        await grade(0, rating: ReviewRating.again);
        await grade(0);
        expect(store.todayNewCount, 1);
        expect(store.todayReviewCount, 2);
        expect(store.remainingNewCount, 0);
        expect(store.buildSession(StudyMode.reading), isEmpty);
        expect(store.buildSession(StudyMode.meaning).map((c) => c.id), [
          'word-0',
        ]);
        expect(await grade(0, mode: StudyMode.meaning), isTrue);
        expect(store.todayNewCount, 1);
        expect(store.progressFor('word-0', StudyMode.reading)!.reviewCount, 2);
        expect(store.progressFor('word-0', StudyMode.meaning)!.reviewCount, 1);
      },
    );

    test(
      'concurrent prebuilt sessions cannot exceed the daily new budget',
      () async {
        await store.setDailyNewLimit(1);
        final results = await Future.wait([grade(0), grade(1)]);
        expect(results, [true, false]);
        expect(store.todayNewCount, 1);
        expect(store.progressFor('word-1', StudyMode.reading), isNull);
      },
    );

    test(
      'lowering the cap below consumed words never yields a negative allowance',
      () async {
        await grade(0);
        await grade(1);
        await store.setDailyNewLimit(1);
        expect(store.remainingNewCount, 0);
        expect(await grade(2), isFalse);
        await expectLater(store.setDailyNewLimit(101), throwsArgumentError);
      },
    );

    test('daily budget and counts reset at local midnight', () async {
      now = DateTime(2026, 10, 21, 23, 59);
      await store.setDailyNewLimit(1);
      await grade(0);
      now = DateTime(2026, 10, 22);
      expect(store.todayReviewCount, 0);
      expect(store.todayNewCount, 0);
      expect(store.remainingNewCount, 1);
      expect(await grade(1), isTrue);
    });
  });

  group('due priority and independent memory', () {
    test(
      'earliest due cards precede new cards regardless of dataset order',
      () async {
        await grade(3);
        await grade(2, rating: ReviewRating.again);
        expect(store.dueCount, 0);
        now = now.add(const Duration(days: 1));
        final session = store.buildSession(StudyMode.reading, limit: 4);
        expect(session.map((c) => c.id), [
          'word-2',
          'word-3',
          'word-0',
          'word-1',
        ]);
        expect(store.dueCount, 2);
      },
    );

    test('twenty due cards leave no session slots for new cards', () async {
      await store.setDailyNewLimit(100);
      for (var i = 0; i < 25; i++) {
        await grade(i);
      }
      now = now.add(const Duration(days: 1));
      final session = store.buildSession(StudyMode.reading);
      expect(session.length, 20);
      expect(
        session.every(
          (c) => store.progressFor(c.id, StudyMode.reading) != null,
        ),
        isTrue,
      );
      expect(store.dueCount, 25);
    });

    test(
      'lower target filters due cards without deleting their history',
      () async {
        cards = [card(0, level: 5), card(1, level: 4)];
        store = makeStore();
        await store.setTargetLevel(4);
        await grade(1);
        now = now.add(const Duration(days: 1));
        expect(store.dueCount, 1);
        await store.setTargetLevel(5);
        expect(store.dueCount, 0);
        expect(store.progressFor('word-1', StudyMode.reading), isNotNull);
        expect(store.buildSession(StudyMode.reading).map((c) => c.id), [
          'word-0',
        ]);
      },
    );

    test('preview is pure and agrees with the committed review', () async {
      final preview = store.previewRating(
        'word-0',
        StudyMode.reading,
        ReviewRating.easy,
      );
      expect(store.learnedCount, 0);
      await grade(0, rating: ReviewRating.easy);
      expect(
        store.progressFor('word-0', StudyMode.reading)!.toJson(),
        preview.toJson(),
      );
    });

    test(
      'duplicate and stale grade tokens are rejected without incrementing stats',
      () async {
        final results = await Future.wait([
          grade(0, expected: 0),
          grade(0, expected: 0),
        ]);
        expect(results, [true, false]);
        expect(store.todayReviewCount, 1);
        expect(await grade(0, expected: 0), isFalse);
        expect(await grade(0, expected: 1), isTrue);
        expect(store.todayReviewCount, 2);
      },
    );

    test(
      'Again marks a weak word until that same track gets a better rating',
      () async {
        await grade(0, rating: ReviewRating.again);
        await grade(0, mode: StudyMode.meaning);
        expect(store.isMistake('word-0'), isTrue);
        await grade(0);
        expect(store.isMistake('word-0'), isFalse);
      },
    );

    test(
      'mastered means both reading and meaning have at least 21-day intervals',
      () async {
        for (final mode in StudyMode.values) {
          for (var i = 0; i < 4; i++) {
            await grade(0, mode: mode, rating: ReviewRating.easy);
          }
          expect(store.masteredCount, mode == StudyMode.reading ? 0 : 1);
        }
        expect(store.learnedCount, 1);
      },
    );
  });

  group('calendar streak', () {
    test(
      'streak follows calendar dates through the spring DST boundary',
      () async {
        // Also run this test with TZ=America/New_York: March 8, 2026 is 23 hours.
        now = DateTime(2026, 3, 7, 12);
        await grade(0);
        now = DateTime(2026, 3, 8, 12);
        await grade(1);
        now = DateTime(2026, 3, 9, 0, 1);
        expect(store.streak, 2);
        await grade(2);
        expect(store.streak, 3);
      },
    );

    test(
      'streak survives an unfinished current day but breaks after a skipped day',
      () async {
        await grade(0);
        expect(store.streak, 1);
        now = DateTime(2026, 10, 22);
        expect(store.streak, 1);
        await grade(1);
        expect(store.streak, 2);
        now = DateTime(2026, 10, 23, 23, 59);
        expect(store.streak, 2);
        now = DateTime(2026, 10, 24);
        expect(store.streak, 0);
        await grade(2);
        expect(store.streak, 1);
      },
    );

    test('month, year, and leap-day boundaries use calendar dates', () async {
      now = DateTime(2028, 2, 28, 23, 59);
      await grade(0);
      now = DateTime(2028, 2, 29);
      await grade(1);
      now = DateTime(2028, 3, 1);
      await grade(2);
      expect(store.streak, 3);
      now = DateTime(2028, 12, 31);
      await grade(3);
      now = DateTime(2029, 1, 1);
      await grade(4);
      expect(store.streak, 2);
    });
  });

  group('persistence and atomic backups', () {
    test(
      'restart preserves progress, settings, counts and bookmarks',
      () async {
        await store.setTargetLevel(3);
        await store.setDailyNewLimit(17);
        await store.toggleBookmark('word-1');
        await grade(0, rating: ReviewRating.again);
        await grade(0, mode: StudyMode.meaning);
        final original = store.exportJson();
        final restarted = makeStore();
        await restarted.restore();
        expect(restarted.exportJson(), original);
        expect(restarted.recoveryMessage, isNull);
        expect(restarted.todayNewCount, 1);
        expect(restarted.todayReviewCount, 2);
        expect(restarted.streak, 1);
      },
    );

    test(
      'backup roundtrip replaces state and survives subsequent restart',
      () async {
        await grade(0);
        await store.toggleBookmark('word-0');
        final backup = store.exportJson();
        await grade(1);
        await store.setDailyNewLimit(25);
        await store.importJson(backup);
        expect(store.exportJson(), backup);
        final restarted = makeStore();
        await restarted.restore();
        expect(restarted.exportJson(), backup);
      },
    );

    test(
      'corrupt or unrelated import preserves memory and persisted JSON',
      () async {
        await grade(0);
        final before = store.exportJson();
        final persisted = preferences.getString(StudyStore.storageKey);
        final baseline = jsonDecode(before) as Map<String, dynamic>;
        final cases = <String>[
          '{',
          '[]',
          '{}',
          jsonEncode({...baseline, 'schema': 99}),
          jsonEncode({...baseline, 'targetLevel': 0}),
          jsonEncode({...baseline, 'dailyNewLimit': 0}),
          jsonEncode({
            ...baseline,
            'bookmarks': ['missing'],
          }),
          jsonEncode({
            ...baseline,
            'bookmarks': ['word-0', 'word-0'],
          }),
          jsonEncode({...baseline, 'days': {}}),
          jsonEncode({
            ...baseline,
            'progress': {'wrong': baseline['progress']['word-0:reading']},
          }),
          jsonEncode({
            ...baseline,
            'days': {
              '2026-02-31': {
                'reviews': 1,
                'newIds': ['word-0'],
              },
            },
          }),
        ];
        for (final source in cases) {
          await expectLater(store.importJson(source), throwsFormatException);
          expect(store.exportJson(), before);
          expect(preferences.getString(StudyStore.storageKey), persisted);
        }
      },
    );

    test(
      'corrupt saved state starts safely and preserves the original bytes',
      () async {
        await preferences.setString(StudyStore.storageKey, '{broken');
        await store.restore();
        expect(store.progress, isEmpty);
        expect(store.targetLevel, 1);
        expect(store.recoveryMessage, isNotNull);
        expect(preferences.getString(StudyStore.storageKey), '{broken');
        await grade(0);
        expect(preferences.getString(StudyStore.recoveryBackupKey), '{broken');
        final restarted = makeStore();
        await restarted.restore();
        expect(restarted.learnedCount, 1);
        expect(restarted.recoveryMessage, isNull);
      },
    );

    test('wrong-type saved state also recovers safely', () async {
      await preferences.setInt(StudyStore.storageKey, 42);
      await store.restore();
      expect(store.recoveryMessage, isNotNull);
      expect(preferences.getInt(StudyStore.storageKey), 42);
    });

    test(
      'a failed corruption backup prevents overwriting the original saved data',
      () async {
        final controlled = ControlledPreferences();
        controlled.values[StudyStore.storageKey] = '{original broken data';
        store = makeStore(prefs: controlled);
        await store.restore();
        controlled.failWrite = true;
        await expectLater(grade(0), throwsStateError);
        expect(
          controlled.values[StudyStore.storageKey],
          '{original broken data',
        );
        expect(store.learnedCount, 0);
        controlled.failWrite = false;
        await grade(0);
        expect(
          controlled.values[StudyStore.recoveryBackupKey],
          '{original broken data',
        );
        expect(store.learnedCount, 1);
      },
    );

    test(
      'failed writes do not commit memory, notify, or poison later queued work',
      () async {
        final controlled = ControlledPreferences();
        store = makeStore(prefs: controlled);
        await grade(0);
        final before = store.exportJson();
        var notifications = 0;
        store.addListener(() {
          notifications++;
        });
        controlled.failWrite = true;
        await expectLater(grade(1), throwsStateError);
        expect(store.exportJson(), before);
        expect(notifications, 0);
        expect(controlled.reloads, 1);
        controlled.failWrite = false;
        controlled.throwWrite = true;
        await expectLater(store.setTargetLevel(3), throwsStateError);
        expect(store.targetLevel, 1);
        controlled.throwWrite = false;
        await store.toggleBookmark('word-2');
        expect(store.isBookmarked('word-2'), isTrue);
        expect(notifications, 1);
      },
    );

    test('failed import preserves the previous live state', () async {
      final controlled = ControlledPreferences();
      store = makeStore(prefs: controlled);
      final empty = store.exportJson();
      await grade(0);
      controlled.failWrite = true;
      await expectLater(store.importJson(empty), throwsStateError);
      expect(store.learnedCount, 1);
    });

    test(
      'concurrent settings and reviews serialize without lost updates',
      () async {
        await Future.wait([
          grade(0),
          grade(1),
          store.toggleBookmark('word-3'),
          store.setTargetLevel(3),
          store.setDailyNewLimit(15),
        ]);
        final restarted = makeStore();
        await restarted.restore();
        expect(restarted.learnedCount, 2);
        expect(restarted.targetLevel, 3);
        expect(restarted.dailyNewLimit, 15);
        expect(restarted.isBookmarked('word-3'), isTrue);
      },
    );

    test(
      'reset clears history while preserving bookmarks and settings',
      () async {
        await grade(0);
        await store.toggleBookmark('word-0');
        await store.setTargetLevel(4);
        await store.setDailyNewLimit(15);
        await store.resetProgress();
        expect(store.progress, isEmpty);
        expect(store.todayReviewCount, 0);
        expect(store.streak, 0);
        expect(store.isBookmarked('word-0'), isTrue);
        expect(store.targetLevel, 4);
        expect(store.dailyNewLimit, 15);
        final restarted = makeStore();
        await restarted.restore();
        expect(restarted.exportJson(), store.exportJson());
      },
    );

    test('public collections cannot mutate store state', () async {
      await grade(0);
      expect(() => store.progress.clear(), throwsUnsupportedError);
      expect(() => store.bookmarks.add('word-0'), throwsUnsupportedError);
      expect(() => store.cards.clear(), throwsUnsupportedError);
    });

    test('unknown cards and duplicate curriculum IDs are rejected', () async {
      await expectLater(
        store.grade('missing', StudyMode.reading, ReviewRating.good),
        throwsArgumentError,
      );
      await expectLater(store.toggleBookmark('missing'), throwsArgumentError);
      cards = [card(0), card(0)];
      expect(makeStore, throwsArgumentError);
    });
  });
}
