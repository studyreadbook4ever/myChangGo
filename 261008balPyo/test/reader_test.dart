import 'package:balpyo_261008/app.dart';
import 'package:balpyo_261008/models.dart';
import 'package:balpyo_261008/storage.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

class MemoryStorage implements DeckStorage {
  MemoryStorage(this.data);
  AppData data;
  bool fail = false;

  @override
  Future<LoadedData> load() async => LoadedData(data);
  @override
  Future<void> save(AppData next) async {
    if (fail) throw StateError('Storage unavailable');
    data = next;
  }
}

Future<void> boot(
  WidgetTester tester,
  MemoryStorage storage, {
  Size size = const Size(360, 780),
}) async {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = size;
  addTearDown(() async {
    await tester.pumpWidget(const SizedBox());
    tester.view.resetPhysicalSize();
    tester.view.resetDevicePixelRatio();
    tester.view.resetViewInsets();
  });
  await tester.pumpWidget(ScriptReaderApp(storage: storage, keepAwake: false));
  await tester.pumpAndSettle();
}

Future<void> tapHalf(WidgetTester tester, {required bool right}) async {
  final rect = tester.getRect(find.byKey(const ValueKey('slide-touch')));
  await tester.tapAt(
    Offset(
      rect.left + rect.width * (right ? .85 : .15),
      rect.top + rect.height * .55,
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('Body left and right taps navigate and stop at both boundaries', (
    tester,
  ) async {
    final storage = MemoryStorage(AppData.initial());
    await boot(tester, storage, size: const Size(320, 700));
    await tapHalf(tester, right: false);
    expect(find.text('1 / 3'), findsOneWidget);
    await tapHalf(tester, right: true);
    expect(find.text('2 / 3'), findsOneWidget);
    await tapHalf(tester, right: true);
    await tapHalf(tester, right: true);
    expect(find.text('3 / 3'), findsOneWidget);
    await tapHalf(tester, right: false);
    expect(find.text('2 / 3'), findsOneWidget);
    expect(storage.data.index, 1);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'Vertical scrolling does not advance and a new page starts at the top',
    (tester) async {
      final storage = MemoryStorage(
        AppData(
          deck: ScriptDeck(
            title: '긴 대본',
            slides: [
              ScriptSlide(
                title: '첫 장',
                body: List.filled(70, '긴 대본을 읽습니다.').join('\n'),
              ),
              const ScriptSlide(title: '둘째 장', body: '다음 장입니다.'),
            ],
          ),
        ),
      );
      await boot(tester, storage);
      await tester.drag(
        find.byKey(const ValueKey('slide-touch')),
        const Offset(0, -380),
      );
      await tester.pumpAndSettle();
      expect(find.text('1 / 2'), findsOneWidget);
      expect(
        tester
            .state<ScrollableState>(find.byType(Scrollable).first)
            .position
            .pixels,
        greaterThan(0),
      );
      await tapHalf(tester, right: true);
      expect(find.text('2 / 2'), findsOneWidget);
      expect(
        tester
            .state<ScrollableState>(find.byType(Scrollable).first)
            .position
            .pixels,
        0,
      );
    },
  );

  testWidgets('Paste, save and reopen keep the actual script and last page', (
    tester,
  ) async {
    final storage = MemoryStorage(AppData.initial());
    await boot(tester, storage);
    await tester.tap(find.byTooltip('대본 편집'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('전체 대본 붙여넣기'));
    await tester.pumpAndSettle();
    await tester.enterText(
      find.byKey(const ValueKey('bulk-script-editor')),
      '# 인사\n실제 발표 대본입니다.\n\n---\n\n# 결과\n감사합니다.',
    );
    await tester.pump();
    await tester.tap(find.text('이 대본으로 바꾸기 · 2장'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('저장'));
    await tester.pumpAndSettle();
    expect(find.text('실제 발표 대본입니다.'), findsOneWidget);
    await tapHalf(tester, right: true);
    await tester.pumpWidget(const SizedBox());
    await tester.pumpWidget(
      ScriptReaderApp(storage: storage, keepAwake: false),
    );
    await tester.pumpAndSettle();
    expect(find.text('2 / 2'), findsOneWidget);
    expect(find.text('감사합니다.'), findsOneWidget);
  });

  testWidgets('Large type remains scrollable in a small landscape viewport', (
    tester,
  ) async {
    final storage = MemoryStorage(AppData.initial().copyWith(fontSize: 46));
    await boot(tester, storage, size: const Size(640, 320));
    expect(find.byKey(const ValueKey('script-text')), findsOneWidget);
    await tester.drag(
      find.byKey(const ValueKey('slide-touch')),
      const Offset(0, -180),
    );
    await tester.pumpAndSettle();
    expect(find.text('1 / 3'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('The slide editor can be used with the phone keyboard open', (
    tester,
  ) async {
    final storage = MemoryStorage(AppData.initial());
    await boot(tester, storage, size: const Size(320, 640));
    await tester.tap(find.byTooltip('대본 편집'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('대본을 넣고 시작하세요'));
    await tester.pumpAndSettle();
    tester.view.viewInsets = const FakeViewPadding(bottom: 280);
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    await tester.enterText(
      find.byKey(const ValueKey('slide-body-editor')),
      '수정한 대본',
    );
    await tester.tap(find.text('이 슬라이드 적용'));
    await tester.pumpAndSettle();
    tester.view.resetViewInsets();
    await tester.pump();
    await tester.tap(find.text('저장'));
    await tester.pumpAndSettle();
    expect(storage.data.deck.slides.first.body, '수정한 대본');
  });

  testWidgets('A failed write is visible and retry keeps the current script', (
    tester,
  ) async {
    final storage = MemoryStorage(AppData.initial())..fail = true;
    await boot(tester, storage);
    await tapHalf(tester, right: true);
    expect(find.text('재시도'), findsOneWidget);
    storage.fail = false;
    await tester.tap(find.text('재시도'));
    await tester.pumpAndSettle();
    expect(find.text('재시도'), findsNothing);
    expect(storage.data.index, 1);
  });
}
