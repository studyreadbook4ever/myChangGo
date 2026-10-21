import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_tts/flutter_tts.dart';
import 'package:integration_test/integration_test.dart';
import 'package:jpstudy/domain.dart';
import 'package:jpstudy/main.dart';
import 'package:jpstudy/study_store.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets(
    'Android study, navigation, native persistence and backup round trip',
    (tester) async {
      // Uses the actual Android plugin, never mock preferences. Preserve any
      // pre-existing app state so a developer can run this on their own device.
      final preferences = await SharedPreferences.getInstance();
      await preferences.reload();
      final original = preferences.getString(StudyStore.storageKey);
      final originalRecovery = preferences.getString(
        StudyStore.recoveryBackupKey,
      );
      await preferences.remove(StudyStore.storageKey);
      await preferences.remove(StudyStore.recoveryBackupKey);
      try {
        final store = await StudyStore.load(preferences: preferences);
        expect(store.cards.length, greaterThanOrEqualTo(500));
        final first = store.buildSession(StudyMode.reading).first;
        await tester.pumpWidget(KanjiApp(store: store));
        await tester.pumpAndSettle();
        expect(find.text('한자 잇다'), findsOneWidget);

        await tester.ensureVisible(find.byKey(const Key('start-reading')));
        await tester.tap(find.byKey(const Key('start-reading')));
        await tester.pumpAndSettle();
        expect(find.text(first.word), findsOneWidget);
        expect(find.text(first.reading), findsNothing);
        await tester.tap(find.byKey(const Key('reveal-answer')));
        await tester.pumpAndSettle();
        expect(find.text(first.reading), findsWidgets);
        await tester.tap(find.byKey(const Key('rate-good')));
        await tester.pumpAndSettle();
        final saveDeadline = DateTime.now().add(const Duration(seconds: 30));
        while (store.todayReviewCount == 0 &&
            DateTime.now().isBefore(saveDeadline)) {
          await tester.pump(const Duration(milliseconds: 100));
        }
        await tester.pumpAndSettle();
        expect(store.todayReviewCount, 1);
        expect(store.progressFor(first.id, StudyMode.reading)?.reviewCount, 1);
        expect(store.progressFor(first.id, StudyMode.meaning), isNull);

        await tester.pageBack();
        await tester.pumpAndSettle();
        await tester.tap(find.byIcon(Icons.auto_stories_outlined));
        await tester.pumpAndSettle();
        expect(find.text('모든 급수'), findsOneWidget);
        await tester.tap(find.byIcon(Icons.tune_outlined));
        await tester.pumpAndSettle();
        expect(find.text('나에게 맞는 학습'), findsOneWidget);

        await store.toggleBookmark(first.id);
        await store.setTargetLevel(3);
        await store.setDailyNewLimit(5);
        await preferences.reload();
        final restarted = await StudyStore.load(preferences: preferences);
        expect(restarted.todayReviewCount, 1);
        expect(restarted.isBookmarked(first.id), isTrue);
        expect(restarted.targetLevel, 3);
        expect(restarted.dailyNewLimit, 5);
        expect(
          restarted.progressFor(first.id, StudyMode.reading)?.reviewCount,
          1,
        );

        final backup = restarted.exportJson();
        await restarted.resetProgress();
        expect(restarted.learnedCount, 0);
        await restarted.importJson(backup);
        await preferences.reload();
        final restored = await StudyStore.load(preferences: preferences);
        expect(restored.exportJson(), backup);
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pumpAndSettle();
        store.dispose();
        restarted.dispose();
        restored.dispose();
      } finally {
        if (original == null) {
          await preferences.remove(StudyStore.storageKey);
        } else {
          await preferences.setString(StudyStore.storageKey, original);
        }
        if (originalRecovery == null) {
          await preferences.remove(StudyStore.recoveryBackupKey);
        } else {
          await preferences.setString(
            StudyStore.recoveryBackupKey,
            originalRecovery,
          );
        }
      }
    },
  );

  testWidgets('Android TTS plugin can report Japanese voice availability', (
    tester,
  ) async {
    final tts = FlutterTts();
    final available = await tts
        .isLanguageAvailable('ja-JP')
        .timeout(const Duration(seconds: 30));
    expect(available is bool || available is int, isTrue);
    // A voice need not be installed on an emulator. The application explains
    // how to install one when the native plugin reports it unavailable.
    await tts.stop();
  });
}
