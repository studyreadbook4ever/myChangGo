import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:jpstudy/domain.dart';
import 'package:jpstudy/study_store.dart';
import 'package:shared_preferences/shared_preferences.dart';

Vocabulary card(int index, {int level = 5}) => Vocabulary(
  id: 'word-$index',
  word: '日日$index',
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
  int writes = 0;
  Completer<void>? writeGate;
  @override
  Object? get(String key) => values[key];
  @override
  Future<bool> setString(String key, String value) async {
    writes++;
    if (writeGate != null) await writeGate!.future;
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

Map<String, dynamic> legacyBackup() => {
  'app': '261021JPstudy',
  'schema': 1,
  'targetLevel': 1,
  'dailyNewLimit': 10,
  'bookmarks': ['word-0'],
  'progress': {
    'word-0:reading': {
      'id': 'word-0',
      'mode': 'reading',
      'lastReviewedAt': '2026-10-21T12:00:00.000Z',
      'reviewCount': 9,
      'dueAt': '2026-10-22T12:00:00.000Z',
    },
    'word-1:meaning': {
      'id': 'word-1',
      'mode': 'meaning',
      'lastReviewedAt': '2026-10-22T12:00:00.000Z',
      'reviewCount': 1,
      'dueAt': '2026-10-23T12:00:00.000Z',
    },
  },
  'days': {},
};

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late SharedPreferences preferences;
  late List<Vocabulary> cards;
  late StudyStore store;
  const kanji = KanjiInfo(
    character: '日',
    korean: '날 일',
    onyomi: ['ニチ'],
    kunyomi: ['ひ'],
    hint: '',
  );
  StudyStore makeStore({SharedPreferences? prefs}) => StudyStore(
    preferences: prefs ?? preferences,
    cards: cards,
    kanji: {'日': kanji},
  );

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    preferences = await SharedPreferences.getInstance();
    cards = [card(0), card(1, level: 3), card(2, level: 1)];
    store = makeStore();
  });

  test(
    'default wordbook shows all words and readings without a saved position',
    () {
      expect(store.visibleCards, cards);
      expect(store.preferredLevel, isNull);
      expect(store.lastReadId, isNull);
      expect(store.lastReadCard, isNull);
      expect(store.hideReadings, isFalse);
      expect(store.textScale, 1.0);
      expect(store.bookmarks, isEmpty);
    },
  );

  test(
    'level filter selects exactly one level and can return to all words',
    () async {
      await store.setPreferredLevel(3);
      expect(store.visibleCards.map((c) => c.id), ['word-1']);
      await store.setPreferredLevel(null);
      expect(store.visibleCards.length, 3);
      for (final invalid in [0, 6]) {
        await expectLater(
          store.setPreferredLevel(invalid),
          throwsArgumentError,
        );
      }
      expect(store.preferredLevel, isNull);
    },
  );

  test(
    'reading is unrestricted and stores only the most recent position',
    () async {
      for (var i = 0; i < 30; i++) {
        await store.markRead('word-${i % 3}');
      }
      expect(store.lastReadId, 'word-2');
      expect(store.lastReadCard, cards[2]);
      expect(jsonDecode(store.exportJson()), {
        'app': '261021JPstudy',
        'schema': 2,
        'bookmarks': [],
        'lastReadId': 'word-2',
        'hideReadings': false,
        'textScale': 1.0,
        'preferredLevel': null,
      });
    },
  );

  test(
    'readings and supported text sizes are persisted independently',
    () async {
      await store.setHideReadings(true);
      for (final size in [1.2, 1.4, 1.0]) {
        await store.setTextScale(size);
        expect(store.textScale, size);
      }
      expect(store.hideReadings, isTrue);
      for (final invalid in [0.0, 1.1, 2.0, double.nan, double.infinity]) {
        await expectLater(store.setTextScale(invalid), throwsArgumentError);
      }
      expect(store.textScale, 1.0);
    },
  );

  test('bookmark toggle changes only the requested word', () async {
    await store.toggleBookmark('word-0');
    await store.toggleBookmark('word-1');
    await store.toggleBookmark('word-0');
    expect(store.bookmarks, {'word-1'});
    expect(store.isBookmarked('word-0'), isFalse);
    expect(store.lastReadId, isNull);
  });

  test(
    'same reading position and same preferences do not cause redundant writes',
    () async {
      final controlled = ControlledPreferences();
      store = makeStore(prefs: controlled);
      await store.markRead('word-0');
      await store.markRead('word-0');
      await store.setTextScale(1.0);
      await store.setHideReadings(false);
      await store.setPreferredLevel(null);
      expect(controlled.writes, 1);
    },
  );

  test('kanji breakdown keeps character order and removes duplicates', () {
    expect(store.kanjiFor(cards[0]), [kanji]);
  });

  test('public collections cannot mutate live state', () {
    expect(() => store.bookmarks.add('word-0'), throwsUnsupportedError);
    expect(() => store.cards.clear(), throwsUnsupportedError);
    expect(() => store.kanji.clear(), throwsUnsupportedError);
    expect(() => store.visibleCards.clear(), throwsUnsupportedError);
  });

  test('unknown words and duplicate vocabulary IDs are rejected', () async {
    await expectLater(store.markRead('missing'), throwsArgumentError);
    await expectLater(store.toggleBookmark('missing'), throwsArgumentError);
    cards = [card(0), card(0)];
    expect(makeStore, throwsArgumentError);
  });

  test(
    'restart preserves saved words, reading position, and view preferences',
    () async {
      await store.toggleBookmark('word-0');
      await store.markRead('word-1');
      await store.setHideReadings(true);
      await store.setTextScale(1.4);
      await store.setPreferredLevel(3);
      final restarted = makeStore();
      await restarted.restore();
      expect(restarted.exportJson(), store.exportJson());
      expect(restarted.recoveryMessage, isNull);
    },
  );

  test('backup roundtrip replaces state and survives restart', () async {
    await store.toggleBookmark('word-0');
    await store.markRead('word-1');
    final backup = store.exportJson();
    await store.markRead('word-2');
    await store.setTextScale(1.4);
    await store.importJson(backup);
    expect(store.exportJson(), backup);
    final restarted = makeStore();
    await restarted.restore();
    expect(restarted.exportJson(), backup);
  });

  test(
    'backup snapshot waits for pending changes and excludes later ones',
    () async {
      final controlled = ControlledPreferences();
      final gate = Completer<void>();
      controlled.writeGate = gate;
      store = makeStore(prefs: controlled);
      final pending = store.setTextScale(1.4);
      var captured = false;
      final snapshot = store.exportSnapshot().then((value) {
        captured = true;
        return value;
      });
      final later = store.setTextScale(1.2);
      await Future<void>.delayed(Duration.zero);
      expect(captured, isFalse);
      expect(store.textScale, 1.0);
      gate.complete();
      await pending;
      expect((jsonDecode(await snapshot) as Map)['textScale'], 1.4);
      await later;
      expect(store.textScale, 1.2);
    },
  );

  test(
    'backup snapshot remains available after a pending write fails',
    () async {
      final controlled = ControlledPreferences();
      store = makeStore(prefs: controlled);
      await store.markRead('word-0');
      final before = store.exportJson();
      controlled.failWrite = true;
      final failed = expectLater(store.markRead('word-1'), throwsStateError);
      final snapshot = store.exportSnapshot();
      await failed;
      expect(await snapshot, before);
    },
  );

  test(
    'malformed backup is rejected atomically without changing memory or disk',
    () async {
      await store.markRead('word-0');
      final before = store.exportJson();
      final persisted = preferences.getString(StudyStore.storageKey);
      final original = jsonDecode(before) as Map<String, dynamic>;
      final cases = [
        '{',
        '[]',
        '{}',
        jsonEncode({...original, 'app': 'another app'}),
        jsonEncode({...original, 'schema': 99}),
        jsonEncode({...original, 'schema': 2.0}),
        jsonEncode({...original, 'lastReadId': 'missing'}),
        jsonEncode({
          ...original,
          'bookmarks': ['missing'],
        }),
        jsonEncode({
          ...original,
          'bookmarks': ['word-0', 'word-0'],
        }),
        jsonEncode({...original, 'bookmarks': 'word-0'}),
        jsonEncode({...original, 'hideReadings': 'false'}),
        jsonEncode({...original, 'textScale': 1.1}),
        jsonEncode({...original, 'preferredLevel': 6}),
        jsonEncode({...original, 'preferredLevel': 3.0}),
        jsonEncode(Map.of(original)..remove('lastReadId')),
        jsonEncode(Map.of(original)..remove('preferredLevel')),
      ];
      for (final backup in cases) {
        await expectLater(
          store.importJson(backup),
          throwsFormatException,
          reason: backup,
        );
        expect(store.exportJson(), before);
        expect(preferences.getString(StudyStore.storageKey), persisted);
      }
    },
  );

  test('oversized backup is rejected before parsing', () async {
    await expectLater(
      store.importJson(' ' * (5 * 1024 * 1024 + 1)),
      throwsFormatException,
    );
  });

  test(
    'legacy restore keeps bookmarks and the latest word while dropping grading data',
    () async {
      await preferences.setString(
        StudyStore.storageKey,
        jsonEncode(legacyBackup()),
      );
      await store.restore();
      expect(store.bookmarks, {'word-0'});
      expect(store.lastReadId, 'word-1');
      expect(store.textScale, 1.0);
      expect(store.hideReadings, isFalse);
      expect(store.preferredLevel, isNull);
      final exported = jsonDecode(store.exportJson()) as Map;
      expect(exported['schema'], 2);
      expect(exported.containsKey('progress'), isFalse);
      expect(exported.containsKey('days'), isFalse);
      await store.setHideReadings(true);
      expect(
        jsonDecode(preferences.getString(StudyStore.storageKey)!)['schema'],
        2,
      );
    },
  );

  test(
    'legacy import handles an empty history and migrates into schema 2 on disk',
    () async {
      final legacy = legacyBackup()..['progress'] = <String, dynamic>{};
      await store.importJson(jsonEncode(legacy));
      expect(store.bookmarks, {'word-0'});
      expect(store.lastReadId, isNull);
      expect(
        jsonDecode(preferences.getString(StudyStore.storageKey)!)['schema'],
        2,
      );
    },
  );

  test(
    'malformed legacy records cannot partially migrate valid bookmarks',
    () async {
      await store.markRead('word-2');
      final before = store.exportJson();
      for (final invalid in [
        {
          'id': 'missing',
          'mode': 'reading',
          'lastReviewedAt': '2026-10-21T12:00:00.000Z',
        },
        {
          'id': 'word-0',
          'mode': 'other',
          'lastReviewedAt': '2026-10-21T12:00:00.000Z',
        },
        {
          'id': 'word-0',
          'mode': 'reading',
          'lastReviewedAt': '2026-02-31T12:00:00.000Z',
        },
        {'id': 'word-0', 'mode': 'reading', 'lastReviewedAt': null},
      ]) {
        final legacy = legacyBackup()
          ..['progress'] = {'word-0:reading': invalid};
        await expectLater(
          store.importJson(jsonEncode(legacy)),
          throwsFormatException,
        );
        expect(store.exportJson(), before);
      }
    },
  );

  test(
    'corrupt saved data is preserved separately before the first replacement write',
    () async {
      await preferences.setString(StudyStore.storageKey, '{broken');
      await store.restore();
      expect(store.recoveryMessage, isNotNull);
      expect(preferences.getString(StudyStore.storageKey), '{broken');
      await store.markRead('word-0');
      expect(preferences.getString('jpstudy.progress.corrupt.v1'), '{broken');
      expect(store.recoveryMessage, isNull);
      final restarted = makeStore();
      await restarted.restore();
      expect(restarted.lastReadId, 'word-0');
    },
  );

  test(
    'wrong-type saved data also recovers without overwriting the original',
    () async {
      await preferences.setInt(StudyStore.storageKey, 42);
      await store.restore();
      expect(store.recoveryMessage, isNotNull);
      expect(preferences.getInt(StudyStore.storageKey), 42);
    },
  );

  test(
    'failed corruption backup prevents overwriting the original data',
    () async {
      final controlled = ControlledPreferences();
      controlled.values[StudyStore.storageKey] = '{original';
      store = makeStore(prefs: controlled);
      await store.restore();
      controlled.failWrite = true;
      await expectLater(store.markRead('word-0'), throwsStateError);
      expect(controlled.values[StudyStore.storageKey], '{original');
      expect(store.lastReadId, isNull);
      controlled.failWrite = false;
      await store.markRead('word-0');
      expect(controlled.values['jpstudy.progress.corrupt.v1'], '{original');
    },
  );

  test(
    'failed writes preserve state and listeners and do not poison the queue',
    () async {
      final controlled = ControlledPreferences();
      store = makeStore(prefs: controlled);
      await store.markRead('word-0');
      final before = store.exportJson();
      var notifications = 0;
      store.addListener(() {
        notifications++;
      });
      controlled.failWrite = true;
      await expectLater(store.markRead('word-1'), throwsStateError);
      expect(store.exportJson(), before);
      expect(notifications, 0);
      expect(controlled.reloads, 1);
      controlled.failWrite = false;
      controlled.throwWrite = true;
      await expectLater(store.setTextScale(1.4), throwsStateError);
      expect(store.textScale, 1.0);
      controlled.throwWrite = false;
      await store.toggleBookmark('word-1');
      expect(store.bookmarks, {'word-1'});
      expect(notifications, 1);
    },
  );

  test('failed import preserves the current reading position', () async {
    final controlled = ControlledPreferences();
    store = makeStore(prefs: controlled);
    final empty = store.exportJson();
    await store.markRead('word-0');
    controlled.failWrite = true;
    await expectLater(store.importJson(empty), throwsStateError);
    expect(store.lastReadId, 'word-0');
  });

  test(
    'concurrent changes serialize without lost bookmarks or preferences',
    () async {
      await Future.wait([
        store.markRead('word-0'),
        store.markRead('word-1'),
        store.toggleBookmark('word-2'),
        store.setHideReadings(true),
        store.setTextScale(1.2),
        store.setPreferredLevel(3),
      ]);
      final restarted = makeStore();
      await restarted.restore();
      expect(restarted.lastReadId, 'word-1');
      expect(restarted.bookmarks, {'word-2'});
      expect(restarted.hideReadings, isTrue);
      expect(restarted.textScale, 1.2);
      expect(restarted.preferredLevel, 3);
    },
  );

  test(
    'reset clears position, bookmarks, and view preferences but keeps the dictionary',
    () async {
      await store.markRead('word-0');
      await store.toggleBookmark('word-1');
      await store.setHideReadings(true);
      await store.setTextScale(1.4);
      await store.setPreferredLevel(1);
      await store.resetProgress();
      expect(store.lastReadId, isNull);
      expect(store.bookmarks, isEmpty);
      expect(store.hideReadings, isFalse);
      expect(store.textScale, 1.0);
      expect(store.preferredLevel, isNull);
      expect(store.cards.length, 3);
      final restarted = makeStore();
      await restarted.restore();
      expect(restarted.exportJson(), store.exportJson());
    },
  );
}
