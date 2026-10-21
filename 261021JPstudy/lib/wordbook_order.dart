import 'dart:math';

/// Promotes a uniform sample without replacement, keeping the remaining order.
/// Only the promoted items need random draws; the dictionary is never shuffled.
List<T> randomFirst<T>(List<T> items, {required Random random, int count = 5}) {
  final size = min(max(count, 0), items.length);
  final moved = <int, int>{};
  final selected = <int>{};
  for (var i = 0; i < size; i++) {
    final remaining = items.length - i;
    final index = random.nextInt(remaining);
    selected.add(moved[index] ?? index);
    moved[index] = moved[remaining - 1] ?? remaining - 1;
  }
  return List<T>.unmodifiable([
    for (final index in selected) items[index],
    for (var i = 0; i < items.length; i++)
      if (!selected.contains(i)) items[i],
  ]);
}
