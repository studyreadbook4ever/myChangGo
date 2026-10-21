import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_tts/flutter_tts.dart';
import 'package:integration_test/integration_test.dart';
import 'package:jpstudy/main.dart';
import 'package:jpstudy/study_store.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('Android native preferences persist across a plugin reload', (
    tester,
  ) async {
    const key = 'jpstudy.nativeSmoke';
    final preferences = await SharedPreferences.getInstance();
    await preferences.reload();
    final original = preferences.getString(key);
    try {
      await tester.pumpWidget(
        const MaterialApp(home: Scaffold(body: Text('Native channel check'))),
      );
      expect(await preferences.setString(key, '한자 · 学校 · 2026'), isTrue);
      await preferences.reload();
      expect(preferences.getString(key), '한자 · 学校 · 2026');
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
    } finally {
      if (original == null) {
        await preferences.remove(key);
      } else {
        await preferences.setString(key, original);
      }
    }
  });

  testWidgets('Android TTS plugin reports Japanese voice availability', (
    tester,
  ) async {
    final tts = FlutterTts();
    final available = await tts
        .isLanguageAvailable('ja-JP')
        .timeout(const Duration(seconds: 30));
    expect(available is bool || available is int, isTrue);
    // Voice data is optional on the emulator. The app explains installation
    // when the native engine reports Japanese unavailable.
    await tts.stop().timeout(const Duration(seconds: 5));
  });
  testWidgets(
    'Offline reading, next page, bookmark and native backup persist',
    (tester) async {
      final preferences = await SharedPreferences.getInstance();
      await preferences.reload();
      const recoveryKey = 'jpstudy.progress.corrupt.v1';
      final original = preferences.getString(StudyStore.storageKey);
      final originalRecovery = preferences.getString(recoveryKey);
      await preferences.remove(StudyStore.storageKey);
      await preferences.remove(recoveryKey);
      final stores = <StudyStore>[];
      Future<void> waitFor(bool Function() ready) async {
        final deadline = DateTime.now().add(const Duration(seconds: 30));
        while (!ready() && DateTime.now().isBefore(deadline)) {
          await tester.pump(const Duration(milliseconds: 100));
        }
        expect(ready(), isTrue);
        await tester.pumpAndSettle();
      }

      try {
        final store = await StudyStore.load(preferences: preferences);
        stores.add(store);
        expect(store.cards.length, 1000);
        final first = store.cards[0];
        final second = store.cards[1];
        await tester.pumpWidget(KanjiApp(store: store));
        await tester.pumpAndSettle();
        expect(find.text('내 속도로 읽는 단어장'), findsOneWidget);
        await tester.scrollUntilVisible(
          find.text(first.word),
          180,
          scrollable: find.byType(Scrollable).first,
        );
        await tester.tap(find.text(first.word));
        await tester.pumpAndSettle();
        await waitFor(() => store.lastReadId == first.id);
        expect(find.text(first.reading), findsWidgets);
        expect(find.text(first.meaning), findsWidgets);
        expect(find.byKey(const Key('reveal-answer')), findsNothing);

        await tester.tap(find.byKey(const Key('reader-bookmark')));
        await waitFor(() => store.isBookmarked(first.id));
        await tester.tap(find.byKey(const Key('reader-next')));
        await waitFor(() => store.lastReadId == second.id);
        expect(find.text(second.word), findsWidgets);
        expect(find.text(second.reading), findsWidgets);
        await tester.tap(find.byType(BackButton));
        await tester.pumpAndSettle();
        await tester.ensureVisible(find.byKey(const Key('continue-reading')));
        await tester.tap(find.byKey(const Key('continue-reading')));
        await tester.pumpAndSettle();
        expect(find.text(second.word), findsWidgets);
        await tester.tap(find.byType(BackButton));
        await tester.pumpAndSettle();
        await tester.tap(find.byIcon(Icons.tune_outlined));
        await tester.pumpAndSettle();
        expect(find.text('편안한 읽기 설정'), findsOneWidget);

        await store.setHideReadings(true);
        await store.setTextScale(1.2);
        await store.setPreferredLevel(3);
        await tester.pumpAndSettle();
        await preferences.reload();
        final restarted = await StudyStore.load(preferences: preferences);
        stores.add(restarted);
        expect(restarted.lastReadId, second.id);
        expect(restarted.isBookmarked(first.id), isTrue);
        expect(restarted.hideReadings, isTrue);
        expect(restarted.textScale, 1.2);
        expect(restarted.preferredLevel, 3);
        final backup = restarted.exportJson();
        await restarted.resetProgress();
        expect(restarted.lastReadId, isNull);
        expect(restarted.bookmarks, isEmpty);
        await restarted.importJson(backup);
        await preferences.reload();
        final restored = await StudyStore.load(preferences: preferences);
        stores.add(restored);
        expect(restored.exportJson(), backup);
        expect(tester.takeException(), isNull);
      } finally {
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pumpAndSettle();
        for (final store in stores) {
          store.dispose();
        }
        if (original == null) {
          await preferences.remove(StudyStore.storageKey);
        } else {
          await preferences.setString(StudyStore.storageKey, original);
        }
        if (originalRecovery == null) {
          await preferences.remove(recoveryKey);
        } else {
          await preferences.setString(recoveryKey, originalRecovery);
        }
      }
    },
  );
}
