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
    level: _level(json['level']),
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

int _level(Object? value) {
  if (value is! int || value < 1 || value > 5) {
    throw const FormatException('level: 1~5 정수가 필요합니다.');
  }
  return value;
}

List<String> _stringList(Object? value, String key) {
  if (value is! List ||
      value.any((item) => item is! String || item.trim().isEmpty)) {
    throw FormatException('$key: 문자열 목록이 필요합니다.');
  }
  return List<String>.unmodifiable(value.cast<String>());
}
