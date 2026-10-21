import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'domain.dart';

/// Local wordbook preferences and one reading position. Opening a word never
/// starts a schedule, records a score, or changes what the reader may open.
class StudyStore extends ChangeNotifier {
  StudyStore({
    required SharedPreferences preferences,
    required List<Vocabulary> cards,
    required Map<String, KanjiInfo> kanji,
  }) : _preferences = preferences,
       cards = List.unmodifiable(cards),
       kanji = Map.unmodifiable(kanji) {
    _byId = {for (final card in cards) card.id: card};
    if (_byId.length != cards.length) {
      throw ArgumentError('중복된 단어 ID가 있습니다.');
    }
  }

  // Keep the original key so existing local bookmarks can migrate in place.
  static const storageKey = 'jpstudy.progress.v1';
  static const backupSchema = 2;
  static const _recoveryBackupKey = 'jpstudy.progress.corrupt.v1';
  static const allowedTextScales = [1.0, 1.2, 1.4];
  final SharedPreferences _preferences;
  final List<Vocabulary> cards;
  final Map<String, KanjiInfo> kanji;
  late final Map<String, Vocabulary> _byId;
  _SavedState _state = _SavedState.empty();
  Future<void> _pending = Future.value();
  String? _corruptSavedValue;
  String? recoveryMessage;

  static Future<StudyStore> load({SharedPreferences? preferences}) async {
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
    );
    await store.restore();
    return store;
  }

  Set<String> get bookmarks => Set.unmodifiable(_state.bookmarks);
  String? get lastReadId => _state.lastReadId;
  Vocabulary? get lastReadCard => _byId[_state.lastReadId];
  bool get hideReadings => _state.hideReadings;
  double get textScale => _state.textScale;
  int? get preferredLevel => _state.preferredLevel;
  List<Vocabulary> get visibleCards => List.unmodifiable(
    cards.where(
      (card) => preferredLevel == null || card.level == preferredLevel,
    ),
  );

  bool isBookmarked(String id) => _state.bookmarks.contains(id);
  List<KanjiInfo> kanjiFor(Vocabulary card) => card.word.runes
      .map(String.fromCharCode)
      .toSet()
      .where(kanji.containsKey)
      .map((character) => kanji[character]!)
      .toList(growable: false);

  Future<void> toggleBookmark(String id) => _enqueue(() async {
    _requireCard(id);
    final next = _state.copy();
    if (!next.bookmarks.remove(id)) next.bookmarks.add(id);
    await _commit(next);
  });

  Future<void> markRead(String id) => _enqueue(() async {
    _requireCard(id);
    if (_state.lastReadId == id) return;
    final next = _state.copy()..lastReadId = id;
    await _commit(next);
  });

  Future<void> setHideReadings(bool value) => _enqueue(() async {
    if (_state.hideReadings == value) return;
    final next = _state.copy()..hideReadings = value;
    await _commit(next);
  });

  Future<void> setTextScale(double value) => _enqueue(() async {
    if (!allowedTextScales.contains(value)) {
      throw ArgumentError.value(
        value,
        'value',
        '글자 크기는 1.0, 1.2, 1.4 중 하나입니다.',
      );
    }
    if (_state.textScale == value) return;
    final next = _state.copy()..textScale = value;
    await _commit(next);
  });

  Future<void> setPreferredLevel(int? value) => _enqueue(() async {
    if (value != null && (value < 1 || value > 5)) {
      throw ArgumentError.value(value, 'value', '급수는 1~5 또는 전체(null)입니다.');
    }
    if (_state.preferredLevel == value) return;
    final next = _state.copy()..preferredLevel = value;
    await _commit(next);
  });

  /// Clears saved words, the last reading position, and all view preferences.
  /// The bundled dictionary is never modified.
  Future<void> resetProgress() => _enqueue(() => _commit(_SavedState.empty()));

  String exportJson() =>
      const JsonEncoder.withIndent('  ').convert(_state.toJson());

  /// Captures a backup after every previously requested change has settled.
  /// Later writes cannot alter the returned snapshot.
  Future<String> exportSnapshot() => _enqueue(() async => exportJson());

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
          '저장된 단어장 설정을 읽지 못했습니다. 기존 저장 내용은 '
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
    // Legacy preferences update their cache before the platform write finishes.
    // Failed writes never become visible through this store.
    try {
      if (_corruptSavedValue != null) {
        final backedUp = await _preferences.setString(
          _recoveryBackupKey,
          _corruptSavedValue!,
        );
        if (!backedUp) throw StateError('기존 기록의 복구용 사본을 저장하지 못했습니다.');
      }
      final success = await _preferences.setString(storageKey, encoded);
      if (!success) throw StateError('단어장 설정을 저장하지 못했습니다. 다시 시도해 주세요.');
    } on Object {
      try {
        await _preferences.reload();
      } on Object {
        // Preserve the original write error if reloading also fails.
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
        value['schema'] is! int ||
        (value['schema'] != 1 && value['schema'] != backupSchema)) {
      throw const FormatException('이 앱에서 만든 지원되는 백업 파일이 아닙니다.');
    }
    final rawBookmarks = value['bookmarks'];
    if (rawBookmarks is! List) {
      throw const FormatException('저장한 단어 목록 형식이 올바르지 않습니다.');
    }
    final bookmarks = <String>{};
    for (final id in rawBookmarks) {
      if (id is! String || !_byId.containsKey(id) || !bookmarks.add(id)) {
        throw const FormatException('저장한 단어에 중복되거나 알 수 없는 항목이 있습니다.');
      }
    }
    if (value['schema'] == 1) return _migrateLegacy(value, bookmarks);
    if (!value.containsKey('lastReadId') ||
        !value.containsKey('preferredLevel')) {
      throw const FormatException('읽던 위치나 보기 설정이 누락되었습니다.');
    }
    final lastRead = value['lastReadId'];
    final hidden = value['hideReadings'];
    final scale = value['textScale'];
    final level = value['preferredLevel'];
    if ((lastRead != null &&
            (lastRead is! String || !_byId.containsKey(lastRead))) ||
        hidden is! bool ||
        scale is! num ||
        !allowedTextScales.contains(scale) ||
        (level != null && (level is! int || level < 1 || level > 5))) {
      throw const FormatException('읽던 위치나 보기 설정이 올바르지 않습니다.');
    }
    return _SavedState(
      bookmarks: bookmarks,
      lastReadId: lastRead as String?,
      hideReadings: hidden,
      textScale: scale.toDouble(),
      preferredLevel: level as int?,
    );
  }

  /// Old reviews only identify the most recently opened word. All old scores,
  /// goals, caps, due dates, and statistics are deliberately discarded.
  _SavedState _migrateLegacy(
    Map<String, dynamic> value,
    Set<String> bookmarks,
  ) {
    final rawProgress = value['progress'];
    if (rawProgress is! Map) {
      throw const FormatException('이전 백업의 단어 기록 형식이 올바르지 않습니다.');
    }
    String? lastRead;
    DateTime? latest;
    for (final entry in rawProgress.entries) {
      final record = entry.value;
      if (record is! Map<String, dynamic>) {
        throw const FormatException('이전 백업의 단어 기록이 올바르지 않습니다.');
      }
      final id = record['id'];
      final mode = record['mode'];
      final timestamp = record['lastReviewedAt'];
      final at = timestamp is String ? DateTime.tryParse(timestamp) : null;
      if (id is! String ||
          !_byId.containsKey(id) ||
          (mode != 'reading' && mode != 'meaning') ||
          entry.key != '$id:$mode' ||
          at == null ||
          !timestamp.endsWith('Z') ||
          at.toUtc().toIso8601String() != timestamp) {
        throw const FormatException('이전 백업의 단어 또는 날짜가 올바르지 않습니다.');
      }
      if (latest == null || !at.isBefore(latest)) {
        latest = at;
        lastRead = id;
      }
    }
    return _SavedState.empty()
      ..bookmarks.addAll(bookmarks)
      ..lastReadId = lastRead;
  }
}

class _SavedState {
  _SavedState({
    required this.bookmarks,
    required this.lastReadId,
    required this.hideReadings,
    required this.textScale,
    required this.preferredLevel,
  });
  factory _SavedState.empty() => _SavedState(
    bookmarks: {},
    lastReadId: null,
    hideReadings: false,
    textScale: 1.0,
    preferredLevel: null,
  );
  final Set<String> bookmarks;
  String? lastReadId;
  bool hideReadings;
  double textScale;
  int? preferredLevel;
  _SavedState copy() => _SavedState(
    bookmarks: {...bookmarks},
    lastReadId: lastReadId,
    hideReadings: hideReadings,
    textScale: textScale,
    preferredLevel: preferredLevel,
  );
  Map<String, dynamic> toJson() => {
    'app': '261021JPstudy',
    'schema': StudyStore.backupSchema,
    'bookmarks': bookmarks.toList()..sort(),
    'lastReadId': lastReadId,
    'hideReadings': hideReadings,
    'textScale': textScale,
    'preferredLevel': preferredLevel,
  };
}
