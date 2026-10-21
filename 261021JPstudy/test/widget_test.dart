import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:jpstudy/main.dart';
import 'package:jpstudy/domain.dart';
import 'package:jpstudy/study_store.dart';

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

class NonlinearTestScaler extends TextScaler {
  const NonlinearTestScaler();
  @override
  double scale(double fontSize) => fontSize + (fontSize < 14 ? fontSize : 14);
  @override
  double get textScaleFactor => 2;
}

void main() {
  test('app text size preserves the platform accessibility curve', () {
    const scaler = AppTextScaler(NonlinearTestScaler(), 1.4);
    expect(scaler.scale(28), closeTo(58.8, 0.0001));
    expect(scaler.scale(14), closeTo(39.2, 0.0001));
  });
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
  testWidgets('opens a readable wordbook, searches, bookmarks and resumes', (
    tester,
  ) async {
    final store = await makeStore();
    await tester.pumpWidget(KanjiApp(store: store));
    await tester.pumpAndSettle();
    expect(find.text('내 속도로 읽는 단어장'), findsOneWidget);
    expect(find.text('がっこう'), findsOneWidget);
    await tester.enterText(find.byType(TextField), '학교');
    await tester.pumpAndSettle();
    expect(find.text('学校'), findsOneWidget);
    expect(find.text('学生'), findsNothing);
    await tester.ensureVisible(find.byTooltip('책갈피 추가'));
    await tester.tap(find.byTooltip('책갈피 추가'));
    await tester.pumpAndSettle();
    expect(store.isBookmarked('school'), isTrue);
    await tester.tap(find.text('学校'));
    await tester.pumpAndSettle();
    expect(find.text('がっこう'), findsOneWidget);
    expect(find.text('학교에 갑니다.'), findsOneWidget);
    expect(store.lastReadId, 'school');
    await tester.tap(find.byType(BackButton));
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.byTooltip('검색 지우기'));
    await tester.tap(find.byTooltip('검색 지우기'));
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.byKey(const Key('continue-reading')));
    await tester.tap(find.byKey(const Key('continue-reading')));
    await tester.pumpAndSettle();
    expect(find.text('단어 읽기'), findsOneWidget);
    expect(find.text('学校'), findsOneWidget);
    await tester.pumpWidget(const SizedBox.shrink());
  });
  testWidgets('exact level, topic and bookmarks can narrow the wordbook', (
    tester,
  ) async {
    final store = await makeStore();
    await store.toggleBookmark('water');
    await tester.pumpWidget(KanjiApp(store: store));
    await tester.pumpAndSettle();
    final n1 = find.widgetWithText(ChoiceChip, 'N1');
    await tester.ensureVisible(n1);
    await tester.tap(n1);
    await tester.pumpAndSettle();
    expect(store.preferredLevel, 1);
    expect(find.text('政策'), findsOneWidget);
    expect(find.text('学校'), findsNothing);
    final all = find.widgetWithText(ChoiceChip, '모든 급수');
    await tester.ensureVisible(all);
    await tester.tap(all);
    await tester.pumpAndSettle();
    await tester.tap(find.byType(DropdownButtonFormField<String>));
    await tester.pumpAndSettle();
    await tester.tap(find.text('자연').last);
    await tester.pumpAndSettle();
    expect(find.text('水'), findsOneWidget);
    expect(find.text('学校'), findsNothing);
    await tester.tap(find.text('책갈피만'));
    await tester.pumpAndSettle();
    expect(find.text('水'), findsOneWidget);
    await tester.ensureVisible(find.byTooltip('책갈피 해제'));
    await tester.tap(find.byTooltip('책갈피 해제'));
    await tester.pumpAndSettle();
    expect(find.textContaining('표시할 단어가 없어요'), findsOneWidget);
    expect(store.bookmarks, isEmpty);
    await tester.pumpWidget(const SizedBox.shrink());
  });
  testWidgets('reading preferences apply to the library and reader', (
    tester,
  ) async {
    final store = await makeStore();
    await tester.pumpWidget(KanjiApp(store: store));
    await tester.pumpAndSettle();
    await tester.tap(find.text('설정'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('크게'));
    await tester.pumpAndSettle();
    expect(store.textScale, 1.2);
    await tester.tap(find.byType(SwitchListTile));
    await tester.pumpAndSettle();
    expect(store.hideReadings, isTrue);
    await tester.tap(find.text('단어장').last);
    await tester.pumpAndSettle();
    expect(find.text('がっこう'), findsNothing);
    await tester.ensureVisible(find.text('学校'));
    await tester.tap(find.text('学校'));
    await tester.pumpAndSettle();
    expect(find.text('がっこう'), findsNothing);
    await tester.tap(find.byKey(const Key('reader-reveal')));
    await tester.pumpAndSettle();
    expect(find.text('がっこう'), findsOneWidget);
    expectNoFlutterErrors(tester);
    await tester.pumpWidget(const SizedBox.shrink());
  });
  testWidgets('search stays usable with keyboard and 2x accessibility text', (
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
    await tester.tap(find.text('설정'));
    await tester.pumpAndSettle();
    expect(tester.testTextInput.isVisible, isFalse);
    expectNoFlutterErrors(tester);
    await tester.pumpWidget(const SizedBox.shrink());
  });
  for (final size in [
    const Size(320, 640),
    const Size(390, 844),
    const Size(1024, 768),
  ]) {
    testWidgets('wordbook and settings fit ${size.width} with large text', (
      tester,
    ) async {
      tester.view.physicalSize = size;
      tester.view.devicePixelRatio = 1;
      tester.platformDispatcher.textScaleFactorTestValue = 1.5;
      addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final store = await makeStore();
      await tester.pumpWidget(KanjiApp(store: store));
      await tester.pumpAndSettle();
      expectNoFlutterErrors(tester);
      await tester.tap(find.text('설정'));
      await tester.pumpAndSettle();
      expectNoFlutterErrors(tester);
      await tester.tap(find.text('더 크게'));
      await tester.pumpAndSettle();
      expectNoFlutterErrors(tester);
      await tester.tap(find.text('단어장').last);
      await tester.pumpAndSettle();
      expectNoFlutterErrors(tester);
      await tester.pumpWidget(const SizedBox.shrink());
    });
  }
}
