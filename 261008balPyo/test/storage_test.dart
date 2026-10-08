import 'dart:io';

import 'package:balpyo_261008/models.dart';
import 'package:balpyo_261008/storage.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  late Directory directory;
  late JsonDeckStorage storage;
  setUp(() async {
    directory = await Directory.systemTemp.createTemp('balpyo-test-');
    storage = JsonDeckStorage(directory: () async => directory);
  });
  tearDown(() async => directory.delete(recursive: true));

  test(
    'Rapid writes preserve the newest page and Unicode after reopening',
    () async {
      final original = AppData(
        deck: ScriptDeck(
          title: '발표 😀',
          slides: const [
            ScriptSlide(title: '첫 장', body: '한국어 대본'),
            ScriptSlide(title: '둘째 장', body: '결과입니다.'),
          ],
        ),
      );
      await Future.wait([
        storage.save(original),
        storage.save(original.copyWith(index: 1, fontSize: 36)),
      ]);
      final reopened = JsonDeckStorage(directory: () async => directory);
      final loaded = await reopened.load();
      expect(loaded.data.deck.title, '발표 😀');
      expect(loaded.data.index, 1);
      expect(loaded.data.fontSize, 36);
      expect(loaded.data.deck.slides.first.body, '한국어 대본');
    },
  );

  test(
    'A damaged primary recovers the previous version and preserves backup',
    () async {
      final first = AppData.initial().copyWith(fontSize: 30);
      await storage.save(first);
      await storage.save(first.copyWith(fontSize: 32));
      await File('${directory.path}/balpyo.json').writeAsString('{damaged');
      final restored = await storage.load();
      expect(restored.recovered, true);
      expect(restored.data.fontSize, 30);
      await storage.save(restored.data.copyWith(index: 1));
      expect(
        AppData.decode(
          await File('${directory.path}/balpyo.backup.json').readAsString(),
        ).fontSize,
        30,
      );
    },
  );

  test(
    'Unreadable data is preserved instead of reset to example slides',
    () async {
      final primary = File('${directory.path}/balpyo.json');
      await primary.writeAsString('broken');
      await expectLater(storage.load(), throwsFormatException);
      expect(await primary.readAsString(), 'broken');
    },
  );

  test('A valid backup is read even when the primary is missing', () async {
    final data = AppData.initial().copyWith(index: 2);
    await File(
      '${directory.path}/balpyo.backup.json',
    ).writeAsString(data.encode());
    final restored = await storage.load();
    expect(restored.recovered, true);
    expect(restored.data.index, 2);
  });
}
