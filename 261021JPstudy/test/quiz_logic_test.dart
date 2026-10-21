import 'dart:math';
import 'package:flutter_test/flutter_test.dart';
import 'package:jpstudy/domain.dart';
import 'package:jpstudy/quiz_logic.dart';

Vocabulary word(String id, String reading) => Vocabulary(
  id: id,
  word: '語',
  reading: reading,
  meaning: '말',
  level: 5,
  topic: '언어',
  example: '日本語です。',
  exampleReading: 'にほんごです。',
  exampleMeaning: '일본어입니다.',
  note: '',
);
void main() {
  test(
    'distractors use similar readings and exclude duplicate pronunciations',
    () {
      final answer = word('a', 'がっこう');
      final pool = [
        answer,
        word('b', 'がっこう'),
        word('c', 'がっき'),
        word('d', 'がくせい'),
        word('e', 'がっか'),
        word('f', 'しょうぼうじどうしゃ'),
      ];
      final options = readingOptions(answer, pool, Random(1));
      expect(options.length, 4);
      expect(options.toSet().length, 4);
      expect(options.where((r) => r == 'がっこう').length, 1);
      expect(options, isNot(contains('しょうぼうじどうしゃ')));
    },
  );
  test('small unique pools do not produce fake or duplicated options', () {
    final answer = word('a', 'ひと');
    expect(readingOptions(answer, [answer, word('b', 'ひと')], Random(1)), [
      'ひと',
    ]);
  });
}
