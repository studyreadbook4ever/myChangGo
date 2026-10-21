import 'package:flutter_test/flutter_test.dart';
import 'package:jpstudy/domain.dart';

void main() {
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

  test('vocabulary preserves Korean, Japanese, and example fields', () {
    final word = Vocabulary.fromJson(raw);
    expect(word.id, 'day');
    expect(word.word, '日');
    expect(word.reading, 'ひ');
    expect(word.meaning, '날; 해');
    expect(word.exampleReading, 'いいひです。');
    expect(word.exampleMeaning, '좋은 날입니다.');
    expect(word.note, isEmpty);
  });

  test(
    'vocabulary rejects missing or wrong required fields and invalid levels',
    () {
      for (final change in [
        {'id': ''},
        {'word': null},
        {'reading': '  '},
        {'meaning': 1},
        {'level': 0},
        {'level': 6},
        {'level': 5.0},
        {'example': null},
      ]) {
        expect(
          () => Vocabulary.fromJson({...raw, ...change}),
          throwsFormatException,
          reason: change.toString(),
        );
      }
    },
  );

  test('kanji readings are copied into immutable lists', () {
    final onyomi = ['ニチ', 'ジツ'];
    final kanji = KanjiInfo.fromJson({
      'character': '日',
      'korean': '날 일',
      'onyomi': onyomi,
      'kunyomi': ['ひ', 'か'],
      'hint': '해와 날의 뜻',
    });
    onyomi.clear();
    expect(kanji.onyomi, ['ニチ', 'ジツ']);
    expect(kanji.korean, '날 일');
    expect(() => kanji.kunyomi.add('x'), throwsUnsupportedError);
  });

  test(
    'kanji accepts absent readings as empty lists but rejects malformed entries',
    () {
      final kanji = <String, dynamic>{
        'character': '日',
        'korean': '날 일',
        'onyomi': <String>[],
        'kunyomi': <String>[],
        'hint': '',
      };
      expect(KanjiInfo.fromJson(kanji).onyomi, isEmpty);
      for (final invalid in [
        null,
        'ひ',
        [1],
        [''],
      ]) {
        expect(
          () => KanjiInfo.fromJson({...kanji, 'kunyomi': invalid}),
          throwsFormatException,
        );
      }
    },
  );
}
