import 'dart:math';
import 'domain.dart';

/// Prefer plausible real readings of similar length/sound. Never manufacture
/// nonexistent words, repeat an option, or duplicate another valid reading.
List<String> readingOptions(
  Vocabulary answer,
  Iterable<Vocabulary> pool,
  Random random,
) {
  final readings = pool.map((c) => c.reading).toSet()..remove(answer.reading);
  final candidates = readings.toList()..shuffle(random);
  int score(String reading) =>
      _distance(answer.reading, reading) * 3 +
      (answer.reading.runes.length - reading.runes.length).abs() * 2;
  candidates.sort((a, b) => score(a).compareTo(score(b)));
  return [answer.reading, ...candidates.take(3)]..shuffle(random);
}

int _distance(String a, String b) {
  final left = a.runes.toList(), right = b.runes.toList();
  var previous = List.generate(right.length + 1, (i) => i);
  for (var i = 0; i < left.length; i++) {
    final row = <int>[i + 1];
    for (var j = 0; j < right.length; j++) {
      row.add(
        min(
          min(row[j] + 1, previous[j + 1] + 1),
          previous[j] + (left[i] == right[j] ? 0 : 1),
        ),
      );
    }
    previous = row;
  }
  return previous.last;
}
