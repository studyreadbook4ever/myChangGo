import 'dart:math' as math;

enum StudyMode { reading, meaning }

enum ReviewRating { again, hard, good, easy }

class Vocabulary {
  const Vocabulary({
    required this.id,
    required this.word,
    required this.reading,
    required this.meaning,
    required this.level,
    required this.topic,
    required this.example,
    required this.exampleReading,
    required this.exampleMeaning,
    required this.note,
  });

  final String id;
  final String word;
  final String reading;
  final String meaning;
  final int level;
  final String topic;
  final String example;
  final String exampleReading;
  final String exampleMeaning;
  final String note;

  factory Vocabulary.fromJson(Map<String, dynamic> json) => Vocabulary(
    id: _requiredString(json, 'id'),
    word: _requiredString(json, 'word'),
    reading: _requiredString(json, 'reading'),
    meaning: _requiredString(json, 'meaning'),
    level: _boundedInt(json, 'level', 1, 5),
    topic: _requiredString(json, 'topic'),
    example: _requiredString(json, 'example'),
    exampleReading: _requiredString(json, 'exampleReading'),
    exampleMeaning: _requiredString(json, 'exampleMeaning'),
    note: _requiredString(json, 'note', allowEmpty: true),
  );
}

class KanjiInfo {
  const KanjiInfo({
    required this.character,
    required this.korean,
    required this.onyomi,
    required this.kunyomi,
    required this.hint,
  });

  final String character;
  final String korean;
  final List<String> onyomi;
  final List<String> kunyomi;
  final String hint;

  factory KanjiInfo.fromJson(Map<String, dynamic> json) => KanjiInfo(
    character: _requiredString(json, 'character'),
    korean: _requiredString(json, 'korean'),
    onyomi: _stringList(json['onyomi'], 'onyomi'),
    kunyomi: _stringList(json['kunyomi'], 'kunyomi'),
    hint: _requiredString(json, 'hint', allowEmpty: true),
  );
}

/// Independent reading / meaning memory state. Times are absolute instants;
/// calendar-day statistics are handled separately by StudyStore.
class CardProgress {
  const CardProgress({
    required this.id,
    required this.mode,
    required this.dueAt,
    required this.intervalDays,
    required this.ease,
    required this.repetitions,
    required this.lapses,
    required this.reviewCount,
    required this.introducedAt,
    required this.lastReviewedAt,
    required this.lastRating,
  });

  final String id;
  final StudyMode mode;
  final DateTime dueAt;
  final int intervalDays;
  final double ease;
  final int repetitions;
  final int lapses;
  final int reviewCount;
  final DateTime introducedAt;
  final DateTime lastReviewedAt;
  final ReviewRating lastRating;

  String get key => progressKey(id, mode);
  bool get isMastered => intervalDays >= 21;
  bool isDue(DateTime now) => !dueAt.isAfter(now);

  Map<String, dynamic> toJson() => {
    'id': id,
    'mode': mode.name,
    'dueAt': dueAt.toUtc().toIso8601String(),
    'intervalDays': intervalDays,
    'ease': ease,
    'repetitions': repetitions,
    'lapses': lapses,
    'reviewCount': reviewCount,
    'introducedAt': introducedAt.toUtc().toIso8601String(),
    'lastReviewedAt': lastReviewedAt.toUtc().toIso8601String(),
    'lastRating': lastRating.name,
  };

  factory CardProgress.fromJson(Map<String, dynamic> json) {
    final result = CardProgress(
      id: _requiredString(json, 'id'),
      mode: _enumValue(StudyMode.values, json['mode'], 'mode'),
      dueAt: _dateTime(json, 'dueAt'),
      intervalDays: _boundedInt(json, 'intervalDays', 0, 3650),
      ease: _boundedDouble(json, 'ease', 1.3, 3.0),
      repetitions: _boundedInt(json, 'repetitions', 0, 1000000),
      lapses: _boundedInt(json, 'lapses', 0, 1000000),
      reviewCount: _boundedInt(json, 'reviewCount', 1, 1000000),
      introducedAt: _dateTime(json, 'introducedAt'),
      lastReviewedAt: _dateTime(json, 'lastReviewedAt'),
      lastRating: _enumValue(
        ReviewRating.values,
        json['lastRating'],
        'lastRating',
      ),
    );
    if (result.lastReviewedAt.isBefore(result.introducedAt) ||
        !result.dueAt.isAfter(result.lastReviewedAt) ||
        result.repetitions > result.reviewCount ||
        result.lapses + result.repetitions > result.reviewCount) {
      throw const FormatException('학습 기록의 날짜 또는 횟수가 올바르지 않습니다.');
    }
    final expectedDelay = result.intervalDays > 0
        ? Duration(days: result.intervalDays)
        : result.lastRating == ReviewRating.again
        ? const Duration(minutes: 10)
        : const Duration(minutes: 30);
    final failed = result.lastRating == ReviewRating.again;
    final successful =
        result.lastRating == ReviewRating.good ||
        result.lastRating == ReviewRating.easy;
    if (result.dueAt.difference(result.lastReviewedAt) != expectedDelay ||
        (failed &&
            (result.repetitions != 0 ||
                result.intervalDays != 0 ||
                result.lapses == 0)) ||
        (successful && (result.repetitions == 0 || result.intervalDays == 0)) ||
        (result.lastRating == ReviewRating.hard &&
            ((result.repetitions == 0) != (result.intervalDays == 0)))) {
      throw const FormatException('복습 간격과 평가 기록이 일치하지 않습니다.');
    }
    return result;
  }
}

String progressKey(String id, StudyMode mode) => '$id:${mode.name}';

/// A transparent, bounded SM-2-inspired scheduler, not FSRS. Again / a first
/// Hard keep the card in short relearning; established cards get day intervals.
/// Preview and commit use this same pure function.
CardProgress scheduleReview({
  required String id,
  required StudyMode mode,
  required ReviewRating rating,
  required DateTime now,
  CardProgress? previous,
}) {
  if (previous != null && (previous.id != id || previous.mode != mode)) {
    throw ArgumentError('이전 학습 기록의 단어 또는 모드가 다릅니다.');
  }
  var ease = previous?.ease ?? 2.5;
  var repetitions = previous?.repetitions ?? 0;
  var lapses = previous?.lapses ?? 0;
  var interval = previous?.intervalDays ?? 0;
  late Duration delay;
  switch (rating) {
    case ReviewRating.again:
      ease = math.max(1.3, ease - 0.2);
      repetitions = 0;
      lapses++;
      interval = 0;
      delay = const Duration(minutes: 10);
    case ReviewRating.hard:
      ease = math.max(1.3, ease - 0.15);
      if (repetitions == 0) {
        interval = 0;
        delay = const Duration(minutes: 30);
      } else {
        interval = (math.max(1, interval) * 1.2).ceil().clamp(1, 3650);
        delay = Duration(days: interval);
      }
    case ReviewRating.good:
      final graduatedInterval = switch (repetitions) {
        0 => 1,
        1 => 3,
        _ => (math.max(1, interval) * ease).round().clamp(1, 3650),
      };
      interval = math.max(interval, graduatedInterval);
      repetitions++;
      delay = Duration(days: interval);
    case ReviewRating.easy:
      ease = math.min(3.0, ease + 0.15);
      interval = repetitions == 0
          ? 4
          : math
                .max(4, (math.max(1, interval) * ease * 1.3).round())
                .clamp(1, 3650);
      repetitions++;
      delay = Duration(days: interval);
  }
  // A backwards device clock must not create internally invalid backups.
  final reviewedAt = previous != null && now.isBefore(previous.lastReviewedAt)
      ? previous.lastReviewedAt
      : now;
  return CardProgress(
    id: id,
    mode: mode,
    dueAt: reviewedAt.add(delay),
    intervalDays: interval,
    ease: ease,
    repetitions: repetitions,
    lapses: lapses,
    reviewCount: (previous?.reviewCount ?? 0) + 1,
    introducedAt: previous?.introducedAt ?? reviewedAt,
    lastReviewedAt: reviewedAt,
    lastRating: rating,
  );
}

String _requiredString(
  Map<String, dynamic> json,
  String key, {
  bool allowEmpty = false,
}) {
  final value = json[key];
  if (value is! String || (!allowEmpty && value.trim().isEmpty)) {
    throw FormatException('$key: 문자열이 필요합니다.');
  }
  return value;
}

int _boundedInt(Map<String, dynamic> json, String key, int min, int max) {
  final value = json[key];
  if (value is! int || value < min || value > max) {
    throw FormatException('$key: $min~$max 정수가 필요합니다.');
  }
  return value;
}

double _boundedDouble(
  Map<String, dynamic> json,
  String key,
  double min,
  double max,
) {
  final value = json[key];
  if (value is! num || !value.isFinite || value < min || value > max) {
    throw FormatException('$key: 올바른 숫자가 필요합니다.');
  }
  return value.toDouble();
}

DateTime _dateTime(Map<String, dynamic> json, String key) {
  final value = _requiredString(json, key);
  // Backups carry explicit UTC instants, so imports never reinterpret a time.
  if (!value.endsWith('Z')) throw FormatException('$key: UTC 시간이 필요합니다.');
  final parsed = DateTime.tryParse(value);
  if (parsed == null ||
      parsed.year < 2000 ||
      parsed.year > 2200 ||
      parsed.toUtc().toIso8601String() != value) {
    throw FormatException('$key: 날짜가 올바르지 않습니다.');
  }
  return parsed;
}

T _enumValue<T extends Enum>(List<T> values, Object? value, String key) {
  for (final candidate in values) {
    if (candidate.name == value) return candidate;
  }
  throw FormatException('$key: 알 수 없는 값입니다.');
}

List<String> _stringList(Object? value, String key) {
  if (value is! List || value.any((item) => item is! String)) {
    throw FormatException('$key: 문자열 목록이 필요합니다.');
  }
  return List<String>.unmodifiable(value.cast<String>());
}
