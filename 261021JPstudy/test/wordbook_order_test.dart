import 'dart:math';

import 'package:flutter_test/flutter_test.dart';
import 'package:jpstudy/wordbook_order.dart';

class CountingRandom extends Fake implements Random {
  final _delegate = Random(42);
  int calls = 0;

  @override
  int nextInt(int max) {
    calls++;
    return _delegate.nextInt(max);
  }
}

void main() {
  test('promotes five unique words and preserves the remaining order', () {
    final source = List.generate(100, (i) => i);
    for (var seed = 0; seed < 100; seed++) {
      final result = randomFirst(source, random: Random(seed));
      final promoted = result.take(5).toSet();
      expect(promoted.length, 5);
      expect(result, unorderedEquals(source));
      expect(result.skip(5), source.where((item) => !promoted.contains(item)));
      expect(source, List.generate(100, (i) => i));
    }
  });

  test('samples a large wordbook using only five random draws', () {
    final random = CountingRandom();
    final source = List.generate(10000, (i) => i);
    final result = randomFirst(source, random: random);
    expect(result.length, source.length);
    expect(random.calls, 5);
  });

  test('empty and short wordbooks never lose or duplicate entries', () {
    for (final length in [0, 1, 2, 4, 5]) {
      final random = CountingRandom();
      final source = List.generate(length, (i) => i);
      final result = randomFirst(source, random: random);
      expect(result, unorderedEquals(source));
      expect(result.toSet().length, length);
      expect(random.calls, lessThanOrEqualTo(length));
    }
  });

  test('a custom sample size keeps an immutable input intact', () {
    const source = [0, 1, 2, 3, 4, 5];
    final result = randomFirst(source, count: 2, random: Random(7));
    final promoted = result.take(2).toSet();
    expect(promoted.length, 2);
    expect(result.skip(2), source.where((item) => !promoted.contains(item)));
    expect(source, [0, 1, 2, 3, 4, 5]);
  });

  test('nonpositive sample sizes preserve order without random work', () {
    for (final count in [-1, 0]) {
      final random = CountingRandom();
      expect(randomFirst([0, 1, 2], count: count, random: random), [0, 1, 2]);
      expect(random.calls, 0);
    }
  });
}
