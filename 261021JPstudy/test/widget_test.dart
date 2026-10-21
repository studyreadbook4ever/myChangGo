import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:jpstudy/main.dart';
import 'package:jpstudy/domain.dart';
import 'package:jpstudy/study_store.dart';
import 'package:jpstudy/screens/study.dart';
import 'package:jpstudy/screens/quiz.dart';
import 'package:jpstudy/design.dart';

List<Vocabulary> fixtures() => [
  const Vocabulary(
    id: 'school',
    word: '学校',
    reading: 'がっこう',
    meaning: '학교',
    level: 5,
    topic: '일상',
    example: '学校に行きます。',
    exampleReading: 'がっこうにいきます。',
    exampleMeaning: '학교에 갑니다.',
    note: '學의 일본 신자체는 学이에요.',
  ),
  const Vocabulary(
    id: 'student',
    word: '学生',
    reading: 'がくせい',
    meaning: '학생',
    level: 5,
    topic: '일상',
    example: '私は学生です。',
    exampleReading: 'わたしはがくせいです。',
    exampleMeaning: '저는 학생입니다.',
    note: '',
  ),
  const Vocabulary(
    id: 'water',
    word: '水',
    reading: 'みず',
    meaning: '물',
    level: 5,
    topic: '자연',
    example: '水を飲みます。',
    exampleReading: 'みずをのみます。',
    exampleMeaning: '물을 마십니다.',
    note: '',
  ),
  const Vocabulary(
    id: 'book',
    word: '本',
    reading: 'ほん',
    meaning: '책',
    level: 5,
    topic: '일상',
    example: '本を読みます。',
    exampleReading: 'ほんをよみます。',
    exampleMeaning: '책을 읽습니다.',
    note: '',
  ),
  const Vocabulary(
    id: 'policy',
    word: '政策',
    reading: 'せいさく',
    meaning: '정책',
    level: 1,
    topic: '사회',
    example: '政策を見直します。',
    exampleReading: 'せいさくをみなおします。',
    exampleMeaning: '정책을 재검토합니다.',
    note: '',
  ),
];
Future<StudyStore> makeStore() async {
  SharedPreferences.setMockInitialValues({});
  return StudyStore(
    preferences: await SharedPreferences.getInstance(),
    cards: fixtures(),
    kanji: {
      '学': const KanjiInfo(
        character: '学',
        korean: '배울 학',
        onyomi: ['ガク'],
        kunyomi: ['まなぶ'],
        hint: '학교에서 배우는 장면을 떠올려요.',
      ),
    },
  );
}

void expectNoFlutterErrors(WidgetTester tester) {
  final error = tester.takeException();
  if (error != null) debugPrint(error.toString());
  expect(error, isNull);
}

void main() {
  setUp(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
          const MethodChannel('flutter_tts'),
          (_) async => 1,
        );
  });
  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(const MethodChannel('flutter_tts'), null);
  });
  testWidgets('home, searchable library, bookmark, detail and settings work', (
    tester,
  ) async {
    final store = await makeStore();
    await tester.pumpWidget(KanjiApp(store: store));
    await tester.pumpAndSettle();
    expect(find.text('아는 소리에,\n한자를 잇다.'), findsOneWidget);
    await tester.tap(find.text('단어장').last);
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField), '학교');
    await tester.pumpAndSettle();
    expect(find.text('学校'), findsOneWidget);
    expect(find.text('学生'), findsNothing);
    await tester.tap(find.byTooltip('단어 저장'));
    await tester.pumpAndSettle();
    expect(store.isBookmarked('school'), isTrue);
    await tester.tap(find.text('学校'));
    await tester.pumpAndSettle();
    expect(find.text('배울 학'), findsOneWidget);
    expect(find.text('학교에 갑니다.'), findsOneWidget);
    Navigator.of(tester.element(find.text('학교에 갑니다.'))).pop();
    await tester.pumpAndSettle();
    await tester.tap(find.text('내 학습'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('N3').last);
    await tester.pumpAndSettle();
    expect(store.targetLevel, 3);
    await tester.tap(find.text('15개'));
    await tester.pumpAndSettle();
    expect(store.dailyNewLimit, 15);
    await tester.pumpWidget(const SizedBox.shrink());
  });
  testWidgets('answer hidden before recall and grading advances exactly once', (
    tester,
  ) async {
    final store = await makeStore();
    await tester.pumpWidget(
      MaterialApp(
        theme: appTheme(),
        home: StudyPage(store: store, mode: StudyMode.reading),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('がっこう'), findsNothing);
    expect(find.byKey(const Key('rate-good')), findsNothing);
    await tester.tap(find.byKey(const Key('reveal-answer')));
    await tester.pumpAndSettle();
    expect(find.text('がっこう'), findsOneWidget);
    await tester.tap(find.byKey(const Key('rate-good')));
    await tester.pumpAndSettle();
    expect(store.todayReviewCount, 1);
    expect(store.todayNewCount, 1);
    expect(find.text('学生'), findsOneWidget);
    expect(find.text('がくせい'), findsNothing);
    await tester.pumpWidget(const SizedBox.shrink());
  });
  testWidgets('Again retries are bounded and a session finishes', (
    tester,
  ) async {
    final store = await makeStore();
    await store.setDailyNewLimit(1);
    await tester.pumpWidget(
      MaterialApp(
        theme: appTheme(),
        home: StudyPage(store: store, mode: StudyMode.reading),
      ),
    );
    for (var n = 0; n < 3; n++) {
      await tester.pumpAndSettle();
      expect(
        find.byKey(const Key('reveal-answer')),
        findsOneWidget,
        reason:
            'attempt $n, saved ${store.todayReviewCount}, errors ${find.textContaining("저장하지 못").evaluate().length}',
      );
      await tester.tap(find.byKey(const Key('reveal-answer')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('rate-again')));
      await tester.pumpAndSettle();
    }
    expect(find.text('한 번 더, 기억에 가까이'), findsOneWidget);
    expect(store.todayReviewCount, 3);
    expect(store.todayNewCount, 1);
    await tester.pumpWidget(const SizedBox.shrink());
  });
  testWidgets(
    'quiz reveals feedback then finishes without altering scheduling',
    (tester) async {
      final store = await makeStore();
      await store.setTargetLevel(5);
      await tester.pumpWidget(
        MaterialApp(
          theme: appTheme(),
          home: QuizPage(store: store),
        ),
      );
      for (var n = 0; n < 4; n++) {
        await tester.pumpAndSettle();
        final visible = fixtures().firstWhere(
          (c) => find.text(c.word).evaluate().isNotEmpty,
        );
        await tester.tap(find.text(visible.reading));
        await tester.pumpAndSettle();
        expect(find.textContaining('정답이에요!'), findsOneWidget);
        final next = find.text(n == 3 ? '결과 보기' : '다음 문제');
        await tester.ensureVisible(next);
        await tester.tap(next);
        await tester.pumpAndSettle();
      }
      expect(find.text('4 / 4'), findsOneWidget);
      expect(store.progress, isEmpty);
      await tester.pumpWidget(const SizedBox.shrink());
    },
  );
  testWidgets('search remains usable with keyboard and 2x accessibility text', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(320, 640);
    tester.view.devicePixelRatio = 1;
    tester.platformDispatcher.textScaleFactorTestValue = 2;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.view.resetViewInsets);
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
    final store = await makeStore();
    await tester.pumpWidget(KanjiApp(store: store));
    await tester.pumpAndSettle();
    expectNoFlutterErrors(tester);
    await tester.tap(find.text('단어장').last);
    await tester.pumpAndSettle();
    tester.view.viewInsets = const FakeViewPadding(bottom: 280);
    await tester.enterText(find.byType(TextField), '학교');
    await tester.pumpAndSettle();
    expectNoFlutterErrors(tester);
    await tester.scrollUntilVisible(
      find.text('学校'),
      150,
      scrollable: find
          .descendant(
            of: find.byType(CustomScrollView),
            matching: find.byType(Scrollable),
          )
          .first,
    );
    await tester.pumpAndSettle();
    expect(find.text('学校'), findsOneWidget);
    await tester.pumpWidget(const SizedBox.shrink());
  });
  for (final size in [
    const Size(320, 640),
    const Size(390, 844),
    const Size(1024, 768),
  ]) {
    testWidgets(
      'responsive pages and revealed card at ${size.width} with large text',
      (tester) async {
        tester.view.physicalSize = size;
        tester.view.devicePixelRatio = 1;
        tester.platformDispatcher.textScaleFactorTestValue = 1.5;
        addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        final store = await makeStore();
        await tester.pumpWidget(
          MediaQuery(
            data: const MediaQueryData(textScaler: TextScaler.linear(1.5)),
            child: KanjiApp(store: store),
          ),
        );
        await tester.pumpAndSettle();
        expectNoFlutterErrors(tester);
        for (final tab in ['단어장', '내 학습', '오늘']) {
          await tester.tap(find.text(tab).last);
          await tester.pumpAndSettle();
          expectNoFlutterErrors(tester);
        }
        await tester.ensureVisible(find.byKey(const Key('start-reading')));
        await tester.tap(find.byKey(const Key('start-reading')));
        await tester.pumpAndSettle();
        await tester.ensureVisible(find.byKey(const Key('reveal-answer')));
        await tester.tap(find.byKey(const Key('reveal-answer')));
        await tester.pumpAndSettle();
        expectNoFlutterErrors(tester);
        await tester.pumpWidget(const SizedBox.shrink());
      },
    );
  }
}
