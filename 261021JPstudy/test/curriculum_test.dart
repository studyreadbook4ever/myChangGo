import 'dart:convert';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:jpstudy/study_store.dart';
import 'package:jpstudy/domain.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  test(
    'bundled curriculum is unrestricted and persists the reading position',
    () async {
      SharedPreferences.setMockInitialValues({});
      final store = await StudyStore.load();
      expect(store.cards.length, 1000);
      expect(store.kanji.length, 300);
      expect(store.cards.map((c) => c.id).toSet().length, store.cards.length);
      expect(store.cards.map((c) => c.level).toSet(), {1, 2, 3, 4, 5});
      expect(store.visibleCards.length, 1000);
      expect(store.lastReadId, isNull);
      final advanced = store.cards.firstWhere((c) => c.level == 1);
      await store.markRead(advanced.id);
      await store.toggleBookmark(advanced.id);
      final backup = store.exportJson();
      final restored = await StudyStore.load();
      expect(restored.lastReadId, advanced.id);
      expect(restored.isBookmarked(advanced.id), isTrue);
      await restored.resetProgress();
      expect(restored.lastReadId, isNull);
      await restored.importJson(backup);
      expect(restored.lastReadId, advanced.id);
      expect(restored.isBookmarked(advanced.id), isTrue);
    },
  );
  test(
    'every vocabulary has kanji, kana reading, Korean gloss, and usable example',
    () async {
      final cards =
          jsonDecode(await rootBundle.loadString('assets/data/vocabulary.json'))
              as List;
      final kana = RegExp(r'^[ぁ-ゖーゔ・\s]+$');
      final kanji = RegExp(r'[一-龯々]');
      final korean = RegExp(r'[가-힣]');
      final pairs = <String>{};
      for (final value in cards) {
        final c = Vocabulary.fromJson(Map<String, dynamic>.from(value as Map));
        expect(kanji.hasMatch(c.word), isTrue, reason: c.word);
        expect(
          kana.hasMatch(c.reading),
          isTrue,
          reason: '${c.word}: ${c.reading}',
        );
        expect(korean.hasMatch(c.meaning), isTrue, reason: c.word);
        expect(c.example.trim(), isNotEmpty, reason: c.word);
        expect(korean.hasMatch(c.exampleMeaning), isTrue, reason: c.word);
        expect(pairs.add('${c.word}/${c.reading}'), isTrue, reason: c.word);
      }
    },
  );
}
