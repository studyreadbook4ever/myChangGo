import 'package:flutter/material.dart';

import 'models.dart';
import 'reader.dart';
import 'storage.dart';

class ScriptReaderApp extends StatefulWidget {
  const ScriptReaderApp({
    super.key,
    required this.storage,
    this.keepAwake = true,
  });

  final DeckStorage storage;
  final bool keepAwake;

  @override
  State<ScriptReaderApp> createState() => _ScriptReaderAppState();
}

class _ScriptReaderAppState extends State<ScriptReaderApp> {
  AppData? _data;
  Object? _loadError;
  bool _saveFailed = false;
  bool _recovered = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _loadError = null);
    try {
      final loaded = await widget.storage.load();
      if (!mounted) return;
      setState(() {
        _data = loaded.data;
        _recovered = loaded.recovered;
      });
    } on Object catch (error) {
      if (mounted) setState(() => _loadError = error);
    }
  }

  Future<bool> _update(AppData next) async {
    setState(() => _data = next);
    try {
      await widget.storage.save(next);
      if (mounted) {
        setState(() {
          _saveFailed = false;
          _recovered = false;
        });
      }
      return true;
    } on Object {
      if (mounted) setState(() => _saveFailed = true);
      return false;
    }
  }

  ThemeData _theme(bool dark) {
    final scheme = ColorScheme.fromSeed(
      seedColor: const Color(0xffe4b75b),
      brightness: dark ? Brightness.dark : Brightness.light,
      surface: dark ? const Color(0xff13171e) : const Color(0xfffaf8f2),
    );
    return ThemeData(
      colorScheme: scheme,
      scaffoldBackgroundColor: scheme.surface,
      useMaterial3: true,
      appBarTheme: AppBarTheme(
        backgroundColor: scheme.surface,
        foregroundColor: scheme.onSurface,
        elevation: 0,
        scrolledUnderElevation: 0,
      ),
      inputDecorationTheme: const InputDecorationTheme(
        border: OutlineInputBorder(),
        contentPadding: EdgeInsets.all(16),
      ),
    );
  }

  @override
  Widget build(BuildContext context) => MaterialApp(
    title: '261008balPyo',
    debugShowCheckedModeBanner: false,
    theme: _theme(_data?.dark ?? true),
    home: _data != null
        ? ReaderScreen(
            data: _data!,
            onChange: _update,
            keepAwake: widget.keepAwake,
            saveFailed: _saveFailed,
            recovered: _recovered,
          )
        : Scaffold(
            body: SafeArea(
              child: Center(
                child: _loadError == null
                    ? const CircularProgressIndicator()
                    : Padding(
                        padding: const EdgeInsets.all(28),
                        child: Column(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            const Icon(Icons.description_outlined, size: 48),
                            const SizedBox(height: 20),
                            const Text(
                              '저장된 대본을 열지 못했습니다.',
                              style: TextStyle(fontSize: 22),
                            ),
                            const SizedBox(height: 12),
                            const Text(
                              '원본 파일은 그대로 보관됩니다.\n'
                              '앱을 다시 열거나 아래 버튼으로 재시도하세요.',
                              textAlign: TextAlign.center,
                            ),
                            const SizedBox(height: 24),
                            FilledButton.icon(
                              onPressed: _load,
                              icon: const Icon(Icons.refresh),
                              label: const Text('다시 열기'),
                            ),
                          ],
                        ),
                      ),
              ),
            ),
          ),
  );
}
