import 'dart:convert';
import 'dart:math' as math;

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'domain.dart';

class StudyStore extends ChangeNotifier {
  StudyStore({
    required SharedPreferences preferences,
    required List<Vocabulary> cards,
    required Map<String, KanjiInfo> kanji,
    DateTime Function()? clock,
  }) : _preferences = preferences,
       cards = List.unmodifiable(cards),
       kanji = Map.unmodifiable(kanji),
       _clock = clock ?? DateTime.now {
    _byId = {for (final card in cards) card.id: card};
    if (_byId.length != cards.length) {
      throw ArgumentError('중복된 단어 ID가 있습니다.');
    }
  }

  static const storageKey = 'jpstudy.progress.v1';
  static const recoveryBackupKey = 'jpstudy.progress.corrupt.v1';
  static const backupSchema = 1;
  static const maxSessionSize = 20;
  final SharedPreferences _preferences;
  final DateTime Function() _clock;
  final List<Vocabulary> cards;
  final Map<String, KanjiInfo> kanji;
  late final Map<String, Vocabulary> _byId;
  _SavedState _state = _SavedState.empty();
  Future<void> _pending = Future.value();
  String? _corruptSavedValue;
  String? recoveryMessage;

  static Future<StudyStore> load({
    SharedPreferences? preferences,
    DateTime Function()? clock,
  }) async {
    final vocabularyJson = jsonDecode(
      await rootBundle.loadString('assets/data/vocabulary.json'),
    );
    final kanjiJson = jsonDecode(
      await rootBundle.loadString('assets/data/kanji.json'),
    );
    final rawCards = vocabularyJson is List
        ? vocabularyJson
        : vocabularyJson['vocabulary'] as List;
    final rawKanji = kanjiJson is List
        ? kanjiJson
        : kanjiJson['kanji'] is List
        ? kanjiJson['kanji'] as List
        : (kanjiJson as Map).values.toList();
    final info = rawKanji
        .map((e) => KanjiInfo.fromJson(Map<String, dynamic>.from(e as Map)))
        .toList();
    final store = StudyStore(
      preferences: preferences ?? await SharedPreferences.getInstance(),
      cards: rawCards
          .map((e) => Vocabulary.fromJson(Map<String, dynamic>.from(e as Map)))
          .toList(),
      kanji: {for (final item in info) item.character: item},
      clock: clock,
    );
    await store.restore();
    return store;
  }

  int get targetLevel => _state.targetLevel;
  int get dailyNewLimit => _state.dailyNewLimit;
  Set<String> get bookmarks => Set.unmodifiable(_state.bookmarks);
  Map<String, CardProgress> get progress => Map.unmodifiable(_state.progress);
  List<Vocabulary> get eligibleCards => List.unmodifiable([
    for (var level = 5; level >= targetLevel; level--)
      ...cards.where((card) => card.level == level),
  ]);
  int get todayReviewCount => _today.reviews;
  int get todayNewCount => _today.newIds.length;
  int get remainingNewCount => math.max(0, dailyNewLimit - todayNewCount);
  int get learnedCount => _introducedIds.length;
  int get masteredCount => cards.where((card) {
    return StudyMode.values.every(
      (mode) => progressFor(card.id, mode)?.isMastered ?? false,
    );
  }).length;
  int get dueCount => _state.progress.values.where((p) {
    return (_byId[p.id]?.level ?? 0) >= targetLevel && p.isDue(_clock());
  }).length;

  int get streak {
    final now = _clock().toLocal();
    var day = DateTime(now.year, now.month, now.day);
    if ((_state.days[_dayKey(day)]?.reviews ?? 0) == 0) {
      day = DateTime(day.year, day.month, day.day - 1);
    }
    var count = 0;
    while ((_state.days[_dayKey(day)]?.reviews ?? 0) > 0) {
      count++;
      // Calendar arithmetic deliberately avoids 24-hour DST subtraction.
      day = DateTime(day.year, day.month, day.day - 1);
    }
    return count;
  }

  _DayStats get _today => _state.days[_dayKey(_clock())] ?? _DayStats.empty();
  Set<String> get _introducedIds =>
      _state.progress.values.map((p) => p.id).toSet();
  CardProgress? progressFor(String id, StudyMode mode) =>
      _state.progress[progressKey(id, mode)];
  bool isBookmarked(String id) => _state.bookmarks.contains(id);
  bool isMistake(String id) => StudyMode.values.any(
    (mode) => progressFor(id, mode)?.lastRating == ReviewRating.again,
  );
  List<KanjiInfo> kanjiFor(Vocabulary card) => card.word.runes
      .map(String.fromCharCode)
      .toSet()
      .where(kanji.containsKey)
      .map((character) => kanji[character]!)
      .toList(growable: false);

  /// Due tracks first, then new tracks of known words, then a capped number of
  /// genuinely new words. Stable curriculum order is the dataset order.
  List<Vocabulary> buildSession(StudyMode mode, {int limit = maxSessionSize}) {
    final size = limit.clamp(0, maxSessionSize);
    final now = _clock();
    final eligible = eligibleCards;
    final due =
        eligible.where((card) {
          return progressFor(card.id, mode)?.isDue(now) ?? false;
        }).toList()..sort((a, b) {
          final order = progressFor(
            a.id,
            mode,
          )!.dueAt.compareTo(progressFor(b.id, mode)!.dueAt);
          return order != 0 ? order : a.id.compareTo(b.id);
        });
    final result = due.take(size).toList();
    final introduced = _introducedIds;
    final unseen = eligible.where((card) => progressFor(card.id, mode) == null);
    for (final card in unseen.where((card) => introduced.contains(card.id))) {
      if (result.length >= size) return result;
      result.add(card);
    }
    var allowance = remainingNewCount;
    for (final card in unseen.where((card) => !introduced.contains(card.id))) {
      if (result.length >= size || allowance <= 0) break;
      result.add(card);
      allowance--;
    }
    return result;
  }

  CardProgress previewRating(String id, StudyMode mode, ReviewRating rating) {
    _requireCard(id);
    return scheduleReview(
      id: id,
      mode: mode,
      rating: rating,
      now: _clock(),
      previous: progressFor(id, mode),
    );
  }

  /// Pass the visible card's reviewCount (0 if new) to reject duplicate/stale
  /// submissions. Early reviews are allowed for the in-session Again loop.
  /// A queued new word is rejected if another session has exhausted the cap.
  Future<bool> grade(
    String id,
    StudyMode mode,
    ReviewRating rating, {
    int? expectedReviewCount,
  }) => _enqueue(() async {
    _requireCard(id);
    final previous = progressFor(id, mode);
    if (expectedReviewCount != null &&
        expectedReviewCount != (previous?.reviewCount ?? 0)) {
      return false;
    }
    final isNewWord = !_introducedIds.contains(id);
    if (isNewWord && remainingNewCount == 0) return false;
    final next = _state.copy();
    final now = _clock();
    final updated = scheduleReview(
      id: id,
      mode: mode,
      rating: rating,
      now: now,
      previous: previous,
    );
    next.progress[updated.key] = updated;
    final day = next.days.putIfAbsent(_dayKey(now), _DayStats.empty);
    day.reviews++;
    if (isNewWord) day.newIds.add(id);
    await _commit(next);
    return true;
  });

  Future<void> setTargetLevel(int level) => _enqueue(() async {
    if (level < 1 || level > 5) throw ArgumentError.value(level, 'level');
    final next = _state.copy()..targetLevel = level;
    await _commit(next);
  });

  Future<void> setDailyNewLimit(int limit) => _enqueue(() async {
    if (limit < 1 || limit > 100) throw ArgumentError.value(limit, 'limit');
    final next = _state.copy()..dailyNewLimit = limit;
    await _commit(next);
  });

  Future<void> toggleBookmark(String id) => _enqueue(() async {
    _requireCard(id);
    final next = _state.copy();
    if (!next.bookmarks.remove(id)) next.bookmarks.add(id);
    await _commit(next);
  });

  /// Resets learning history while retaining the user's curriculum settings
  /// and bookmarks. This is always persisted before listeners see the change.
  Future<void> resetProgress() => _enqueue(() async {
    final next = _state.copy();
    next.progress.clear();
    next.days.clear();
    await _commit(next);
  });

  String exportJson() =>
      const JsonEncoder.withIndent('  ').convert(_state.toJson());

  Future<void> importJson(String source) => _enqueue(() async {
    final next = _parseState(source);
    await _commit(next);
  });

  Future<void> restore() => _enqueue(() async {
    final saved = _preferences.get(storageKey);
    if (saved == null) return;
    try {
      if (saved is! String) throw const FormatException('저장 형식 오류');
      _state = _parseState(saved);
      recoveryMessage = null;
      _corruptSavedValue = null;
    } on Object {
      _corruptSavedValue = saved is String ? saved : jsonEncode(saved);
      recoveryMessage =
          '저장된 학습 기록을 읽지 못했습니다. 기존 저장 내용은 '
          '보존하며 기본 상태로 시작합니다. 다음 저장 전에 복구용 사본을 만듭니다.';
      _state = _SavedState.empty();
    }
    notifyListeners();
  });

  void _requireCard(String id) {
    if (!_byId.containsKey(id)) throw ArgumentError.value(id, 'id', '없는 단어');
  }

  Future<T> _enqueue<T>(Future<T> Function() operation) {
    final next = _pending.then((_) => operation());
    _pending = next.then<void>((_) {}, onError: (Object _, StackTrace _) {});
    return next;
  }

  Future<void> _commit(_SavedState next) async {
    final encoded = jsonEncode(next.toJson());
    // setString updates the plugin cache even on platform failure. Reload it
    // before propagating the error; listeners never see a failed mutation.
    try {
      if (_corruptSavedValue != null) {
        final backedUp = await _preferences.setString(
          recoveryBackupKey,
          _corruptSavedValue!,
        );
        if (!backedUp) throw StateError('기존 기록의 복구용 사본을 저장하지 못했습니다.');
      }
      final success = await _preferences.setString(storageKey, encoded);
      if (!success) throw StateError('학습 기록을 저장하지 못했습니다. 다시 시도해 주세요.');
    } on Object {
      try {
        await _preferences.reload();
      } on Object {
        // Keep the original write error if the platform also cannot reload.
      }
      rethrow;
    }
    _state = next;
    _corruptSavedValue = null;
    recoveryMessage = null;
    notifyListeners();
  }

  _SavedState _parseState(String source) {
    if (source.length > 5 * 1024 * 1024) {
      throw const FormatException('백업 파일은 5MB 이하여야 합니다.');
    }
    final value = jsonDecode(source);
    if (value is! Map<String, dynamic> ||
        value['app'] != '261021JPstudy' ||
        value['schema'] != backupSchema) {
      throw const FormatException('이 앱에서 만든 지원되는 백업 파일이 아닙니다.');
    }
    final level = value['targetLevel'];
    final limit = value['dailyNewLimit'];
    if (level is! int ||
        level < 1 ||
        level > 5 ||
        limit is! int ||
        limit < 1 ||
        limit > 100) {
      throw const FormatException('학습 설정이 올바르지 않습니다.');
    }
    final bookmarkJson = value['bookmarks'];
    final progressJson = value['progress'];
    final daysJson = value['days'];
    if (bookmarkJson is! List || progressJson is! Map || daysJson is! Map) {
      throw const FormatException('백업의 학습 기록 형식이 올바르지 않습니다.');
    }
    final bookmarkIds = <String>{};
    for (final id in bookmarkJson) {
      if (id is! String || !_byId.containsKey(id) || !bookmarkIds.add(id)) {
        throw const FormatException('즐겨찾기에 잘못된 단어가 있습니다.');
      }
    }
    final records = <String, CardProgress>{};
    for (final entry in progressJson.entries) {
      if (entry.value is! Map<String, dynamic>) {
        throw const FormatException('단어 학습 기록 형식 오류');
      }
      final record = CardProgress.fromJson(entry.value as Map<String, dynamic>);
      if (!_byId.containsKey(record.id) || entry.key != record.key) {
        throw const FormatException('알 수 없는 단어 또는 일치하지 않는 기록입니다.');
      }
      records[record.key] = record;
    }
    final days = <String, _DayStats>{};
    final allNewIds = <String>{};
    var totalReviews = 0;
    for (final entry in daysJson.entries) {
      if (entry.key is! String ||
          !_validDayKey(entry.key as String) ||
          entry.value is! Map<String, dynamic>) {
        throw const FormatException('일별 학습 기록 날짜 또는 형식 오류');
      }
      final raw = entry.value as Map<String, dynamic>;
      final reviews = raw['reviews'];
      final ids = raw['newIds'];
      if (reviews is! int || reviews < 1 || reviews > 1000000 || ids is! List) {
        throw const FormatException('일별 학습 횟수 오류');
      }
      final dayIds = <String>{};
      for (final id in ids) {
        if (id is! String ||
            !_byId.containsKey(id) ||
            !dayIds.add(id) ||
            !allNewIds.add(id)) {
          throw const FormatException('중복되거나 알 수 없는 새 단어 기록입니다.');
        }
      }
      if (dayIds.length > reviews) {
        throw const FormatException('새 단어 수가 복습 수보다 많습니다.');
      }
      totalReviews += reviews;
      days[entry.key as String] = _DayStats(reviews: reviews, newIds: dayIds);
    }
    final introduced = records.values.map((p) => p.id).toSet();
    final recordedReviews = records.values.fold<int>(
      0,
      (sum, p) => sum + p.reviewCount,
    );
    if (totalReviews != recordedReviews ||
        introduced.length != allNewIds.length ||
        !introduced.containsAll(allNewIds)) {
      throw const FormatException('일별 합계와 단어별 학습 기록이 일치하지 않습니다.');
    }
    return _SavedState(
      targetLevel: level,
      dailyNewLimit: limit,
      bookmarks: bookmarkIds,
      progress: records,
      days: days,
    );
  }
}

String _dayKey(DateTime value) {
  final local = value.toLocal();
  return '${local.year.toString().padLeft(4, '0')}-'
      '${local.month.toString().padLeft(2, '0')}-'
      '${local.day.toString().padLeft(2, '0')}';
}

bool _validDayKey(String value) {
  if (!RegExp(r'^\d{4}-\d{2}-\d{2}$').hasMatch(value)) return false;
  final parsed = DateTime.tryParse(value);
  return parsed != null &&
      parsed.year >= 2000 &&
      parsed.year <= 2200 &&
      _dayKey(parsed) == value;
}

class _DayStats {
  _DayStats({required this.reviews, required this.newIds});
  factory _DayStats.empty() => _DayStats(reviews: 0, newIds: {});
  int reviews;
  final Set<String> newIds;
  _DayStats copy() => _DayStats(reviews: reviews, newIds: {...newIds});
  Map<String, dynamic> toJson() => {
    'reviews': reviews,
    'newIds': newIds.toList()..sort(),
  };
}

class _SavedState {
  _SavedState({
    required this.targetLevel,
    required this.dailyNewLimit,
    required this.bookmarks,
    required this.progress,
    required this.days,
  });
  factory _SavedState.empty() => _SavedState(
    targetLevel: 1,
    dailyNewLimit: 10,
    bookmarks: {},
    progress: {},
    days: {},
  );
  int targetLevel;
  int dailyNewLimit;
  final Set<String> bookmarks;
  final Map<String, CardProgress> progress;
  final Map<String, _DayStats> days;
  _SavedState copy() => _SavedState(
    targetLevel: targetLevel,
    dailyNewLimit: dailyNewLimit,
    bookmarks: {...bookmarks},
    progress: {...progress},
    days: {for (final entry in days.entries) entry.key: entry.value.copy()},
  );
  Map<String, dynamic> toJson() => {
    'app': '261021JPstudy',
    'schema': StudyStore.backupSchema,
    'targetLevel': targetLevel,
    'dailyNewLimit': dailyNewLimit,
    'bookmarks': bookmarks.toList()..sort(),
    'progress': {
      for (final entry in progress.entries) entry.key: entry.value.toJson(),
    },
    'days': {for (final entry in days.entries) entry.key: entry.value.toJson()},
  };
}
