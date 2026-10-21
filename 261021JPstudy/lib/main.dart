import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_localizations/flutter_localizations.dart';

import 'design.dart';
import 'study_store.dart';
import 'pronunciation.dart';
import 'screens/home.dart';
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
    _loading = StudyStore.load();
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
                          onPressed: () =>
                              setState(() => _loading = StudyStore.load()),
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
  Widget build(BuildContext context) => MaterialApp(
    title: '한자 잇다',
    debugShowCheckedModeBanner: false,
    theme: appTheme(),
    locale: const Locale('ko'),
    supportedLocales: const [Locale('ko'), Locale('ja'), Locale('en')],
    localizationsDelegates: GlobalMaterialLocalizations.delegates,
    home: AppShell(store: store),
  );
}

class AppShell extends StatefulWidget {
  const AppShell({super.key, required this.store});
  final StudyStore store;
  @override
  State<AppShell> createState() => _AppShellState();
}

class _AppShellState extends State<AppShell> with WidgetsBindingObserver {
  int _selected = 0;
  Timer? _refresh;
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _refresh = Timer.periodic(const Duration(minutes: 1), (_) {
      if (mounted) setState(() {});
    });
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && widget.store.recoveryMessage != null) {
        showDialog<void>(
          context: context,
          builder: (context) => AlertDialog(
            title: const Text('학습 기록 확인이 필요해요'),
            content: Text(widget.store.recoveryMessage!),
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
    if (state == AppLifecycleState.resumed) setState(() {});
    if (state != AppLifecycleState.resumed) pronunciation.stop();
  }

  @override
  void dispose() {
    _refresh?.cancel();
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.store,
    builder: (context, _) => Scaffold(
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
                '매일, 한 걸음',
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
              HomePage(
                store: widget.store,
                openLibrary: () => setState(() => _selected = 1),
              ),
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
            icon: Icon(Icons.grid_view_outlined),
            selectedIcon: Icon(Icons.grid_view_rounded),
            label: '오늘',
          ),
          NavigationDestination(
            icon: Icon(Icons.auto_stories_outlined),
            selectedIcon: Icon(Icons.auto_stories_rounded),
            label: '단어장',
          ),
          NavigationDestination(
            icon: Icon(Icons.tune_outlined),
            selectedIcon: Icon(Icons.tune_rounded),
            label: '내 학습',
          ),
        ],
      ),
    ),
  );
}
