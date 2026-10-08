import 'dart:io';

import 'package:path_provider/path_provider.dart';

import 'models.dart';

class LoadedData {
  const LoadedData(this.data, {this.recovered = false});
  final AppData data;
  final bool recovered;
}

abstract class DeckStorage {
  Future<LoadedData> load();
  Future<void> save(AppData data);
}

/// Private on-device JSON. Writes are ordered, flushed and atomically renamed.
/// A previous valid version is retained separately; a damaged file is never
/// silently replaced with the example script.
class JsonDeckStorage implements DeckStorage {
  JsonDeckStorage({Future<Directory> Function()? directory})
    : _directory = directory ?? getApplicationDocumentsDirectory;

  final Future<Directory> Function() _directory;
  Future<void> _writes = Future.value();

  @override
  Future<LoadedData> load() async {
    await _writes;
    final dir = await _directory();
    final primary = File('${dir.path}/balpyo.json');
    final backup = File('${dir.path}/balpyo.backup.json');
    final exists = await primary.exists();
    if (exists) {
      try {
        return LoadedData(AppData.decode(await primary.readAsString()));
      } on Object {
        // Try the previous version below, leaving the damaged file intact.
      }
    }
    if (await backup.exists()) {
      try {
        return LoadedData(
          AppData.decode(await backup.readAsString()),
          recovered: true,
        );
      } on Object {
        throw const FormatException('저장된 대본과 백업을 읽을 수 없습니다.');
      }
    }
    if (exists) throw const FormatException('저장된 대본을 읽을 수 없습니다.');
    return LoadedData(AppData.initial());
  }

  @override
  Future<void> save(AppData data) {
    final next = _writes.then((_) => _save(data));
    _writes = next.catchError((Object _) {});
    return next;
  }

  Future<void> _save(AppData data) async {
    final dir = await _directory();
    await dir.create(recursive: true);
    final primary = File('${dir.path}/balpyo.json');
    final backup = File('${dir.path}/balpyo.backup.json');
    final temporary = File('${dir.path}/balpyo.tmp');
    if (await primary.exists()) {
      try {
        final old = await primary.readAsString();
        AppData.decode(old);
        await backup.writeAsString(old, flush: true);
      } on FormatException {
        // Preserve the valid backup if the primary was recovered at startup.
      } on TypeError {
        // Malformed JSON data may also fail a typed conversion.
      }
    }
    await temporary.writeAsString(data.encode(), flush: true);
    await temporary.rename(primary.path);
  }
}
