import 'dart:convert';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:jpstudy/study_store.dart';
import 'package:jpstudy/domain.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  test(
    'bundled curriculum parses, has all levels, and starts from foundations',
    () async {
      SharedPreferences.setMockInitialValues({});
      final store = await StudyStore.load();
      expect(store.cards.length, greaterThanOrEqualTo(1000));
      expect(store.kanji.length, greaterThanOrEqualTo(120));
      expect(store.cards.map((c) => c.id).toSet().length, store.cards.length);
      expect(store.cards.map((c) => c.level).toSet(), {1, 2, 3, 4, 5});
      expect(store.targetLevel, 1);
      expect(
        store.buildSession(StudyMode.reading).every((c) => c.level == 5),
        isTrue,
      );
      expect(store.buildSession(StudyMode.reading).length, 10);
      final backup = store.exportJson();
      await store.grade(
        store.cards.first.id,
        StudyMode.reading,
        ReviewRating.good,
      );
      final restored = await StudyStore.load();
      expect(restored.todayReviewCount, 1);
      await restored.importJson(backup);
      expect(restored.todayReviewCount, 0);
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
