import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:jpstudy/design.dart';
import 'package:jpstudy/domain.dart';
import 'package:jpstudy/pronunciation.dart';
import 'package:jpstudy/screens/reader.dart';
import 'package:jpstudy/study_store.dart';

const readerFixtures = [
  Vocabulary(
    id: 'school',
    word: '学校',
    reading: 'がっこう',
    meaning: '학교',
    level: 5,
    topic: '학교와 장소',
    example: '学校へ行きます。',
    exampleReading: 'がっこうへいきます。',
    exampleMeaning: '학교에 갑니다.',
    note: '学校는 がっこう로 읽어요.',
  ),
  Vocabulary(
    id: 'student',
    word: '学生',
    reading: 'がくせい',
    meaning: '학생',
    level: 5,
    topic: '사람',
    example: '私は学生です。',
    exampleReading: 'わたしはがくせいです。',
    exampleMeaning: '저는 학생입니다.',
    note: '',
  ),
  Vocabulary(
    id: 'policy',
    word: '経済政策',
    reading: 'けいざいせいさく',
    meaning: '경제 정책',
    level: 1,
    topic: '사회와 경제',
    example: '新しい経済政策を検討します。',
    exampleReading: 'あたらしいけいざいせいさくをけんとうします。',
    exampleMeaning: '새로운 경제 정책을 검토합니다.',
    note: '',
  ),
];

class ReaderTestStore extends StudyStore {
  ReaderTestStore({required super.preferences, this.hidden = false})
    : super(
        cards: readerFixtures,
        kanji: {
          '学': const KanjiInfo(
            character: '学',
            korean: '배울 학',
            onyomi: ['ガク'],
            kunyomi: ['まなぶ'],
            hint: '学校는 がっこう입니다.',
          ),
        },
      );

  final bool hidden;
  final visits = <String>[];
  bool failNext = false;
  Completer<void>? delayNext;
  Future<void> _writes = Future.value();

  @override
  bool get hideReadings => hidden;

  @override
  Future<void> markRead(String id) {
    visits.add(id);
    final delay = delayNext;
    delayNext = null;
    final fail = failNext;
    failNext = false;
    final result = _writes.then((_) async {
      if (delay != null) await delay.future;
      if (fail) throw StateError('Simulated write failure');
      await super.markRead(id);
    });
    _writes = result.catchError((Object _) {});
    return result;
  }
}

Future<ReaderTestStore> readerStore({bool hidden = false}) async {
  SharedPreferences.setMockInitialValues({});
  return ReaderTestStore(
    preferences: await SharedPreferences.getInstance(),
    hidden: hidden,
  );
}

Widget readerApp(
  StudyStore store, {
  String initialId = 'school',
  List<Vocabulary> cards = readerFixtures,
  double scale = 1,
}) => MaterialApp(
  theme: appTheme(),
  builder: (context, child) => MediaQuery(
    data: MediaQuery.of(context).copyWith(textScaler: TextScaler.linear(scale)),
    child: child!,
  ),
  home: ReaderPage(store: store, cards: cards, initialId: initialId),
);

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

  testWidgets('opens requested word and saves once despite bookmark rebuilds', (
    tester,
  ) async {
    final store = await readerStore();
    await tester.pumpWidget(readerApp(store, initialId: 'student'));
    await tester.pumpAndSettle();
    expect(find.text('学生'), findsOneWidget);
    expect(find.text('がくせい'), findsOneWidget);
    expect(find.text('わたしはがくせいです。'), findsOneWidget);
    expect(find.text('2 / 3'), findsOneWidget);
    expect(store.lastReadId, 'student');
    expect(store.visits, ['student']);

    await tester.tap(find.byKey(const Key('reader-bookmark')));
    await tester.pumpAndSettle();
    expect(store.isBookmarked('student'), isTrue);
    expect(store.visits, ['student']);

    await tester.tap(find.byKey(const Key('reader-previous')));
    await tester.pumpAndSettle();
    expect(find.text('学校'), findsOneWidget);
    expect(store.lastReadId, 'school');
    expect(find.text('1 / 3'), findsOneWidget);
    expect(
      tester
          .widget<OutlinedButton>(find.byKey(const Key('reader-previous')))
          .onPressed,
      isNull,
    );
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets(
    'optional reading reveal includes examples and resets on next word',
    (tester) async {
      final store = await readerStore(hidden: true);
      await tester.pumpWidget(readerApp(store));
      await tester.pumpAndSettle();
      expect(find.text('학교'), findsOneWidget);
      expect(find.text('학교에 갑니다.'), findsOneWidget);
      expect(find.text('がっこう'), findsNothing);
      expect(find.text('がっこうへいきます。'), findsNothing);
      expect(find.text('学校는 がっこう로 읽어요.'), findsNothing);
      expect(find.text('学校는 がっこう입니다.'), findsNothing);
      expect(find.byType(ListenButton), findsNWidgets(3));

      await tester.tap(find.byKey(const Key('reader-reveal')));
      await tester.pumpAndSettle();
      expect(find.text('がっこう'), findsOneWidget);
      expect(find.text('がっこうへいきます。'), findsOneWidget);
      expect(find.byKey(const Key('reader-reveal')), findsNothing);

      await tester.tap(find.byKey(const Key('reader-next')));
      await tester.pumpAndSettle();
      expect(find.text('学生'), findsOneWidget);
      expect(find.text('がくせい'), findsNothing);
      expect(find.text('わたしはがくせいです。'), findsNothing);
      expect(find.byKey(const Key('reader-reveal')), findsOneWidget);
      expect(store.lastReadId, 'student');
      await tester.pumpWidget(const SizedBox.shrink());
    },
  );

  testWidgets(
    'browsing stays responsive while position writes remain ordered',
    (tester) async {
      final store = await readerStore();
      await tester.pumpWidget(readerApp(store));
      await tester.pumpAndSettle();
      final pending = Completer<void>();
      store.delayNext = pending;
      await tester.tap(find.byKey(const Key('reader-next')));
      await tester.pump();
      expect(find.text('学生'), findsOneWidget);
      expect(store.lastReadId, 'school');
      await tester.tap(find.byKey(const Key('reader-next')));
      await tester.pump();
      expect(store.visits, ['school', 'student', 'policy']);
      expect(find.text('経済政策'), findsOneWidget);
      expect(store.lastReadId, 'school');
      pending.complete();
      await tester.pumpAndSettle();
      expect(find.text('経済政策'), findsOneWidget);
      expect(store.lastReadId, 'policy');
      await tester.pumpWidget(const SizedBox.shrink());
    },
  );

  testWidgets('failed position save does not prevent browsing or later saves', (
    tester,
  ) async {
    final store = await readerStore();
    await tester.pumpWidget(readerApp(store));
    await tester.pumpAndSettle();
    store.failNext = true;
    await tester.tap(find.byKey(const Key('reader-next')));
    await tester.pumpAndSettle();
    expect(find.text('学生'), findsOneWidget);
    expect(store.lastReadId, 'school');
    expect(find.textContaining('단어는 계속 볼 수 있어요'), findsOneWidget);
    await tester.tap(find.byKey(const Key('reader-next')));
    await tester.pumpAndSettle();
    expect(find.text('経済政策'), findsOneWidget);
    expect(store.lastReadId, 'policy');
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('a delayed native audio stop does not block page navigation', (
    tester,
  ) async {
    final store = await readerStore();
    await tester.pumpWidget(readerApp(store));
    await tester.pumpAndSettle();
    final nativeStop = Completer<Object?>();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(const MethodChannel('flutter_tts'), (
          call,
        ) async {
          if (call.method == 'stop') return nativeStop.future;
          return 1;
        });
    await tester.tap(find.byKey(const Key('reader-next')));
    await tester.pumpAndSettle();
    expect(find.text('学生'), findsOneWidget);
    nativeStop.complete(1);
    await tester.pumpAndSettle();
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('leaving while saving does not update an unmounted page', (
    tester,
  ) async {
    final store = await readerStore();
    await tester.pumpWidget(readerApp(store));
    await tester.pumpAndSettle();
    final pending = Completer<void>();
    store.delayNext = pending;
    await tester.tap(find.byKey(const Key('reader-next')));
    await tester.pump();
    await tester.pumpWidget(const SizedBox.shrink());
    pending.complete();
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
  });

  testWidgets('empty and stale entry points are safe', (tester) async {
    final store = await readerStore();
    await tester.pumpWidget(readerApp(store, cards: const []));
    await tester.pumpAndSettle();
    expect(find.text('표시할 단어가 없어요.'), findsOneWidget);
    expect(store.visits, isEmpty);
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pumpWidget(readerApp(store, initialId: 'missing'));
    await tester.pumpAndSettle();
    expect(find.text('学校'), findsOneWidget);
    expect(store.lastReadId, 'school');
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('narrow phone and large text retain readable navigation', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(320, 640);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = await readerStore();
    await tester.pumpWidget(readerApp(store, initialId: 'policy', scale: 1.8));
    await tester.pumpAndSettle();
    expect(find.text('経済政策'), findsOneWidget);
    expect(find.text('3 / 3'), findsOneWidget);
    expect(
      tester
          .widget<OutlinedButton>(find.byKey(const Key('reader-next')))
          .onPressed,
      isNull,
    );
    expect(tester.takeException(), isNull);
    await tester.tap(find.byKey(const Key('reader-previous')));
    await tester.pumpAndSettle();
    expect(find.text('学生'), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
  });
}
