import 'dart:async';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'design.dart';
import 'study_store.dart';
import 'pronunciation.dart';
import 'screens/library.dart';
import 'screens/settings.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  LicenseRegistry.addLicense(() async* {
    for (final font in ['NotoSansJP', 'NotoSansKR']) {
      yield LicenseEntryWithLineBreaks([
        font,
      ], await rootBundle.loadString('assets/fonts/OFL-$font.txt'));
    }
  });
  runApp(const Bootstrap());
}

class Bootstrap extends StatefulWidget {
  const Bootstrap({super.key});
  @override
  State<Bootstrap> createState() => _BootstrapState();
}

class _BootstrapState extends State<Bootstrap> {
  late Future<StudyStore> _loading;
  @override
  void initState() {
    super.initState();
    _loading = _load();
  }

  Future<StudyStore> _load() async {
    try {
      return await StudyStore.load();
    } catch (error, stack) {
      FlutterError.reportError(
        FlutterErrorDetails(
          exception: error,
          stack: stack,
          library: 'jpstudy',
          context: ErrorDescription('loading the local wordbook'),
        ),
      );
      rethrow;
    }
  }

  @override
  Widget build(BuildContext context) => FutureBuilder<StudyStore>(
    future: _loading,
    builder: (context, state) {
      if (state.hasData) return KanjiApp(store: state.data!);
      return MaterialApp(
        theme: appTheme(),
        debugShowCheckedModeBanner: false,
        home: Scaffold(
          body: Center(
            child: Padding(
              padding: const EdgeInsets.all(24),
              child: state.hasError
                  ? Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        const Text('단어장을 불러오지 못했어요.'),
                        const SizedBox(height: 16),
                        FilledButton(
                          onPressed: () => setState(() => _loading = _load()),
                          child: const Text('다시 시도'),
                        ),
                      ],
                    )
                  : const CircularProgressIndicator(),
            ),
          ),
        ),
      );
    },
  );
}

class KanjiApp extends StatelessWidget {
  const KanjiApp({super.key, required this.store});
  final StudyStore store;
  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: store,
    builder: (context, _) => MaterialApp(
      title: '한자 잇다',
      debugShowCheckedModeBanner: false,
      theme: appTheme(),
      locale: const Locale('ko'),
      supportedLocales: const [Locale('ko'), Locale('ja'), Locale('en')],
      localizationsDelegates: GlobalMaterialLocalizations.delegates,
      builder: (context, child) => MediaQuery(
        data: MediaQuery.of(context).copyWith(
          textScaler: AppTextScaler(
            MediaQuery.textScalerOf(context),
            store.textScale,
          ),
        ),
        child: child!,
      ),
      home: AppShell(store: store),
    ),
  );
}

/// Adds the reader's preferred size without flattening the platform's
/// nonlinear accessibility scaling curve.
class AppTextScaler extends TextScaler {
  const AppTextScaler(this.platform, this.factor)
    : assert(factor >= 0 && factor < double.infinity);

  final TextScaler platform;
  final double factor;

  @override
  double scale(double fontSize) => platform.scale(fontSize) * factor;

  // Legacy callers receive an estimate at the default body font size.
  @override
  double get textScaleFactor => scale(14) / 14;

  @override
  bool operator ==(Object other) =>
      other is AppTextScaler &&
      other.platform == platform &&
      other.factor == factor;

  @override
  int get hashCode => Object.hash(platform, factor);
}

class AppShell extends StatefulWidget {
  const AppShell({super.key, required this.store});
  final StudyStore store;
  @override
  State<AppShell> createState() => _AppShellState();
}

class _AppShellState extends State<AppShell> with WidgetsBindingObserver {
  int _selected = 0;
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && widget.store.recoveryMessage != null) {
        final message = widget.store.recoveryMessage!;
        showDialog<void>(
          context: context,
          builder: (context) => AlertDialog(
            title: const Text('저장 기록 확인이 필요해요'),
            content: Text(message),
            actions: [
              TextButton(
                onPressed: () => Navigator.pop(context),
                child: const Text('확인'),
              ),
            ],
          ),
        );
      }
    });
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state != AppLifecycleState.resumed) unawaited(pronunciation.stop());
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(
      title: Row(
        children: [
          Container(
            width: 34,
            height: 34,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: ink,
              borderRadius: BorderRadius.circular(10),
            ),
            child: const JpText('字', size: 22, color: Colors.white),
          ),
          const SizedBox(width: 10),
          const Flexible(
            child: Text(
              '한자 잇다',
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(fontWeight: FontWeight.w800, fontSize: 19),
            ),
          ),
        ],
      ),
      actions: [
        if (MediaQuery.sizeOf(context).width > 400)
          const Padding(
            padding: EdgeInsets.only(right: 22),
            child: Text(
              '소리와 글자를 잇다',
              style: TextStyle(fontSize: 11, color: muted),
            ),
          ),
      ],
    ),
    body: Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 1000),
        child: IndexedStack(
          index: _selected,
          children: [
            LibraryPage(store: widget.store),
            SettingsPage(store: widget.store),
          ],
        ),
      ),
    ),
    bottomNavigationBar: NavigationBar(
      selectedIndex: _selected,
      onDestinationSelected: (i) {
        FocusManager.instance.primaryFocus?.unfocus();
        setState(() => _selected = i);
      },
      destinations: const [
        NavigationDestination(
          icon: Icon(Icons.auto_stories_outlined),
          selectedIcon: Icon(Icons.auto_stories_rounded),
          label: '단어장',
        ),
        NavigationDestination(
          icon: Icon(Icons.tune_outlined),
          selectedIcon: Icon(Icons.tune_rounded),
          label: '설정',
        ),
      ],
    ),
  );
}
