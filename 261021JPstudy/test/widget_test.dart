import 'dart:math';

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:jpstudy/main.dart';
import 'package:jpstudy/domain.dart';
import 'package:jpstudy/study_store.dart';
import 'package:jpstudy/screens/library.dart';
import 'package:jpstudy/screens/reader.dart';

class CountingRandom extends Fake implements Random {
  final _delegate = Random(42);
  int calls = 0;

  @override
  int nextInt(int max) {
    calls++;
    return _delegate.nextInt(max);
  }
}

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
  testWidgets('random words refresh on lookup and navigation, not redraws', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(800, 1800);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = await makeStore();
    final random = CountingRandom();
    Widget host({bool active = true}) => MaterialApp(
      home: Scaffold(
        body: ListenableBuilder(
          listenable: store,
          builder: (context, _) =>
              LibraryPage(store: store, random: random, isActive: active),
        ),
      ),
    );

    await tester.pumpWidget(host());
    await tester.pumpAndSettle();
    final firstLookup = random.calls;
    expect(firstLookup, greaterThan(0));
    expect(firstLookup, lessThanOrEqualTo(5));
    await tester.pumpWidget(host());
    await store.setHideReadings(true);
    await store.toggleBookmark('school');
    await store.markRead('student');
    await tester.pumpAndSettle();
    expect(random.calls, firstLookup);

    await tester.pumpWidget(host(active: false));
    await store.setPreferredLevel(5);
    await tester.pumpAndSettle();
    expect(random.calls, firstLookup);
    await tester.pumpWidget(host());
    await tester.pumpAndSettle();
    expect(random.calls, greaterThan(firstLookup));

    final beforeSearch = random.calls;
    await tester.enterText(find.byType(TextField), '일상');
    await tester.pumpAndSettle();
    expect(random.calls, greaterThan(beforeSearch));
    expect(random.calls, lessThanOrEqualTo(beforeSearch + 3));
    final searched = random.calls;
    await tester.enterText(find.byType(TextField), ' 일상 ');
    await tester.pumpAndSettle();
    expect(random.calls, searched);

    await tester.tap(find.text('学校'));
    await tester.pumpAndSettle();
    final reader = tester.widget<ReaderPage>(find.byType(ReaderPage));
    expect(
      reader.cards.map((card) => card.id),
      unorderedEquals(['school', 'student', 'book']),
    );
    expect(random.calls, searched);
    await tester.tap(find.byType(BackButton));
    await tester.pumpAndSettle();
    expect(random.calls, greaterThan(searched));

    final beforeEmptyQuery = random.calls;
    await store.setPreferredLevel(1);
    await tester.pumpAndSettle();
    expect(random.calls, beforeEmptyQuery);
    expect(find.textContaining('표시할 단어가 없어요'), findsOneWidget);
    expectNoFlutterErrors(tester);
    await tester.pumpWidget(const SizedBox.shrink());
  });
  testWidgets('bookmarks-only lookup tracks candidate membership changes', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(800, 1800);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = await makeStore();
    for (final id in ['school', 'student', 'water']) {
      await store.toggleBookmark(id);
    }
    final random = CountingRandom();
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: ListenableBuilder(
            listenable: store,
            builder: (context, _) => LibraryPage(store: store, random: random),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilterChip, '책갈피만'));
    await tester.pumpAndSettle();
    final bookmarkedLookup = random.calls;
    final before = tester.widget<SliverList>(find.byType(SliverList)).delegate;
    expect(before.estimatedChildCount, 3);
    await store.toggleBookmark('water');
    await tester.pumpAndSettle();
    expect(random.calls, greaterThan(bookmarkedLookup));
    final after = tester.widget<SliverList>(find.byType(SliverList)).delegate;
    expect(after.estimatedChildCount, 2);
    expect(find.text('水'), findsNothing);
    final beforeReader = random.calls;
    await tester.tap(find.text('学校'));
    await tester.pumpAndSettle();
    await store.toggleBookmark('student');
    await tester.pumpAndSettle();
    expect(random.calls, beforeReader);
    final reader = tester.widget<ReaderPage>(find.byType(ReaderPage));
    expect(
      reader.cards.map((card) => card.id),
      unorderedEquals(['school', 'student']),
    );
    await tester.tap(find.byType(BackButton));
    await tester.pumpAndSettle();
    final list = tester.widget<SliverList>(find.byType(SliverList));
    expect(list.delegate.estimatedChildCount, 1);
    expectNoFlutterErrors(tester);
    await tester.pumpWidget(const SizedBox.shrink());
  });
  testWidgets('opens a readable wordbook, searches, bookmarks and resumes', (
    tester,
  ) async {
    final store = await makeStore();
    await tester.pumpWidget(KanjiApp(store: store));
    await tester.pumpAndSettle();
    expect(find.text('내 속도로 읽는 단어장'), findsOneWidget);
    await tester.enterText(find.byType(TextField), '학교');
    await tester.pumpAndSettle();
    expect(find.text('がっこう'), findsOneWidget);
    expect(find.text('学校'), findsOneWidget);
    expect(find.text('学生'), findsNothing);
    await tester.ensureVisible(find.byTooltip('책갈피 추가'));
    await tester.pumpAndSettle();
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
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('검색 지우기'));
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.byKey(const Key('continue-reading')));
    await tester.pumpAndSettle();
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
    await tester.pumpAndSettle();
    await tester.tap(n1);
    await tester.pumpAndSettle();
    expect(store.preferredLevel, 1);
    expect(find.text('政策'), findsOneWidget);
    expect(find.text('学校'), findsNothing);
    final all = find.widgetWithText(ChoiceChip, '모든 급수');
    await tester.ensureVisible(all);
    await tester.pumpAndSettle();
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
    await tester.pumpAndSettle();
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
  testWidgets('long topic stays fully readable with combined large text', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(320, 640);
    tester.view.devicePixelRatio = 1;
    tester.platformDispatcher.textScaleFactorTestValue = 1.5;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
    const topic = '문맥 속 고유어와 한자';
    SharedPreferences.setMockInitialValues({});
    final store = StudyStore(
      preferences: await SharedPreferences.getInstance(),
      cards: const [
        Vocabulary(
          id: 'atmosphere',
          word: '趣',
          reading: 'おもむき',
          meaning: '정취; 취지',
          level: 1,
          topic: topic,
          example: 'この庭には落ち着いた趣がある。',
          exampleReading: 'このにわにはおちついたおもむきがある。',
          exampleMeaning: '이 정원에는 차분한 정취가 있다.',
          note: '',
        ),
      ],
      kanji: const {},
    );
    await store.setTextScale(1.4);
    await tester.pumpWidget(KanjiApp(store: store));
    await tester.pumpAndSettle();
    final field = find.byType(DropdownButtonFormField<String>);
    await tester.ensureVisible(field);
    await tester.pumpAndSettle();
    await tester.tap(field);
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.text(topic).last);
    await tester.pumpAndSettle();
    await tester.tap(find.text(topic).last);
    await tester.pumpAndSettle();
    await tester.ensureVisible(field);
    await tester.pumpAndSettle();

    final selected = find.descendant(of: field, matching: find.text(topic));
    expect(selected, findsOneWidget);
    final paragraph = tester.renderObject<RenderParagraph>(selected);
    final neededHeight = paragraph.getMaxIntrinsicHeight(paragraph.size.width);
    final singleLineHeight = paragraph.getMaxIntrinsicHeight(double.infinity);
    // Exercise real wrapping, and compare against the full un-clipped text
    // height. A constrained Text's layout rect alone can hide clipped lines.
    expect(neededHeight, greaterThan(singleLineHeight));
    expect(paragraph.size.height, greaterThanOrEqualTo(neededHeight - 0.5));
    final labelRect = tester.getRect(selected);
    final fieldRect = tester.getRect(field);
    expect(labelRect.top, greaterThanOrEqualTo(fieldRect.top));
    expect(labelRect.bottom, lessThanOrEqualTo(fieldRect.bottom + 0.5));
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
