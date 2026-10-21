import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:jpstudy/pronunciation.dart';

void main() {
  const channel = MethodChannel('flutter_tts');
  testWidgets('pending speech is cancelled when a screen stops playback', (
    tester,
  ) async {
    final readiness = Completer<bool>();
    final calls = <String>[];
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(channel, (
      call,
    ) async {
      calls.add(call.method);
      if (call.method == 'isLanguageAvailable') return readiness.future;
      return 1;
    });
    addTearDown(
      () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        channel,
        null,
      ),
    );
    late BuildContext context;
    await tester.pumpWidget(
      MaterialApp(
        home: Builder(
          builder: (c) {
            context = c;
            return const Scaffold();
          },
        ),
      ),
    );
    final speaker = Pronunciation();
    final pending = speaker.speak(context, 'がっこう');
    await tester.pump();
    await speaker.stop();
    readiness.complete(true);
    await pending;
    expect(calls, contains('stop'));
    expect(calls, isNot(contains('speak')));
  });
  testWidgets('unavailable Japanese voice gives actionable feedback', (
    tester,
  ) async {
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
      channel,
      (call) async => false,
    );
    addTearDown(
      () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        channel,
        null,
      ),
    );
    late BuildContext context;
    await tester.pumpWidget(
      MaterialApp(
        home: Builder(
          builder: (c) {
            context = c;
            return const Scaffold();
          },
        ),
      ),
    );
    await Pronunciation().speak(context, 'がっこう');
    await tester.pump();
    expect(find.text('기기의 음성 설정에서 일본어 음성을 설치해 주세요.'), findsOneWidget);
    await tester.pumpAndSettle();
  });
  testWidgets('stalled native voice reports a bounded failure', (tester) async {
    final readiness = Completer<bool>();
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(channel, (
      call,
    ) async {
      if (call.method == 'isLanguageAvailable') return readiness.future;
      return 1;
    });
    addTearDown(
      () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        channel,
        null,
      ),
    );
    late BuildContext context;
    await tester.pumpWidget(
      MaterialApp(
        home: Builder(
          builder: (c) {
            context = c;
            return const Scaffold();
          },
        ),
      ),
    );
    final pending = Pronunciation().speak(context, 'がっこう');
    await tester.pump(const Duration(seconds: 9));
    await pending;
    await tester.pump();
    expect(
      find.text('일본어 음성을 재생할 수 없어요. 기기의 TTS 설정을 확인해 주세요.'),
      findsOneWidget,
    );
    readiness.complete(true);
    await tester.pumpAndSettle();
  });
}
