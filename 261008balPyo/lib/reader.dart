import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:wakelock_plus/wakelock_plus.dart';

import 'editor.dart';
import 'models.dart';

class ReaderScreen extends StatefulWidget {
  const ReaderScreen({
    super.key,
    required this.data,
    required this.onChange,
    required this.keepAwake,
    required this.saveFailed,
    required this.recovered,
  });

  final AppData data;
  final Future<bool> Function(AppData) onChange;
  final bool keepAwake;
  final bool saveFailed;
  final bool recovered;

  @override
  State<ReaderScreen> createState() => _ReaderScreenState();
}

class _ReaderScreenState extends State<ReaderScreen>
    with WidgetsBindingObserver {
  final _scroll = ScrollController();
  final _watch = Stopwatch();
  Timer? _ticker;
  bool _fullScreen = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _awake(true);
  }

  void _awake(bool enabled) {
    if (widget.keepAwake) {
      unawaited(WakelockPlus.toggle(enable: enabled).catchError((Object _) {}));
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _awake(state == AppLifecycleState.resumed);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _ticker?.cancel();
    _scroll.dispose();
    _awake(false);
    if (_fullScreen) {
      unawaited(SystemChrome.setEnabledSystemUIMode(SystemUiMode.edgeToEdge));
    }
    super.dispose();
  }

  void _go(int index) {
    if (index < 0 ||
        index >= widget.data.deck.slides.length ||
        index == widget.data.index) {
      return;
    }
    if (_scroll.hasClients) _scroll.jumpTo(0);
    unawaited(widget.onChange(widget.data.copyWith(index: index)));
  }

  void _toggleFullScreen() {
    setState(() => _fullScreen = !_fullScreen);
    unawaited(
      SystemChrome.setEnabledSystemUIMode(
        _fullScreen ? SystemUiMode.immersiveSticky : SystemUiMode.edgeToEdge,
      ),
    );
  }

  void _toggleTimer() => setState(() {
    if (_watch.isRunning) {
      _watch.stop();
      _ticker?.cancel();
      _ticker = null;
    } else {
      _watch.start();
      _ticker = Timer.periodic(const Duration(seconds: 1), (_) {
        if (mounted) setState(() {});
      });
    }
  });

  String get _time {
    final seconds = _watch.elapsed.inSeconds;
    return '${(seconds ~/ 60).toString().padLeft(2, '0')}:'
        '${(seconds % 60).toString().padLeft(2, '0')}';
  }

  Future<void> _edit() async {
    final deck = await Navigator.of(context).push<ScriptDeck>(
      MaterialPageRoute(builder: (_) => DeckEditor(deck: widget.data.deck)),
    );
    if (deck == null || !mounted) return;
    if (_scroll.hasClients) _scroll.jumpTo(0);
    final saved = await widget.onChange(
      widget.data.copyWith(deck: deck, index: 0),
    );
    if (saved && mounted) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(const SnackBar(content: Text('대본을 저장했습니다.')));
    }
  }

  Future<void> _chooseSlide() async {
    final index = await showModalBottomSheet<int>(
      context: context,
      useSafeArea: true,
      isScrollControlled: true,
      builder: (context) => SizedBox(
        height: MediaQuery.sizeOf(context).height * .7,
        child: Column(
          children: [
            const Padding(
              padding: EdgeInsets.all(20),
              child: Text('슬라이드로 이동', style: TextStyle(fontSize: 22)),
            ),
            Expanded(
              child: ListView.builder(
                itemCount: widget.data.deck.slides.length,
                itemBuilder: (context, i) => ListTile(
                  selected: i == widget.data.index,
                  leading: Text('${i + 1}'.padLeft(2, '0')),
                  title: Text(widget.data.deck.slides[i].title),
                  subtitle: Text(
                    widget.data.deck.slides[i].body,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                  onTap: () => Navigator.pop(context, i),
                ),
              ),
            ),
          ],
        ),
      ),
    );
    if (index != null && mounted) _go(index);
  }

  Future<void> _settings() async {
    var fontSize = widget.data.fontSize;
    var dark = widget.data.dark;
    await showModalBottomSheet<void>(
      context: context,
      useSafeArea: true,
      isScrollControlled: true,
      builder: (context) => StatefulBuilder(
        builder: (context, update) => SingleChildScrollView(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(24, 24, 24, 28),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const Text('편하게 읽기', style: TextStyle(fontSize: 24)),
                const SizedBox(height: 24),
                Row(
                  children: [
                    const Text('글자 크기', style: TextStyle(fontSize: 18)),
                    const Spacer(),
                    Text(
                      '${fontSize.round()}',
                      style: const TextStyle(fontSize: 18),
                    ),
                  ],
                ),
                Slider(
                  key: const ValueKey('font-size-slider'),
                  value: fontSize,
                  min: 18,
                  max: 46,
                  divisions: 14,
                  label: '${fontSize.round()}',
                  onChanged: (value) {
                    update(() => fontSize = value);
                    unawaited(
                      widget.onChange(widget.data.copyWith(fontSize: value)),
                    );
                  },
                ),
                Text(
                  '이 크기로 대본이 보입니다.',
                  style: TextStyle(fontSize: fontSize, height: 1.5),
                ),
                const SizedBox(height: 16),
                SwitchListTile(
                  contentPadding: EdgeInsets.zero,
                  title: const Text('어두운 화면'),
                  value: dark,
                  onChanged: (value) {
                    update(() => dark = value);
                    unawaited(
                      widget.onChange(widget.data.copyWith(dark: value)),
                    );
                  },
                ),
                const SizedBox(height: 12),
                OutlinedButton.icon(
                  onPressed: () async {
                    await Clipboard.setData(
                      ClipboardData(text: widget.data.deck.toText()),
                    );
                    if (context.mounted) {
                      ScaffoldMessenger.of(context).showSnackBar(
                        const SnackBar(content: Text('전체 대본을 복사했습니다.')),
                      );
                    }
                  },
                  icon: const Icon(Icons.copy_all),
                  label: const Text('전체 대본 복사'),
                ),
                TextButton.icon(
                  onPressed: () {
                    setState(() {
                      _watch.stop();
                      _watch.reset();
                      _ticker?.cancel();
                      _ticker = null;
                    });
                    Navigator.pop(context);
                  },
                  icon: const Icon(Icons.restart_alt),
                  label: const Text('발표 시간 초기화'),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final data = widget.data;
    final slide = data.deck.slides[data.index];
    final colors = Theme.of(context).colorScheme;
    return Scaffold(
      appBar: AppBar(
        toolbarHeight: _fullScreen ? 48 : 76,
        title: _fullScreen
            ? Text(
                slide.title,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(fontSize: 14),
              )
            : Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    '261008balPyo',
                    style: TextStyle(
                      fontSize: 12,
                      color: colors.primary,
                      letterSpacing: 1,
                    ),
                  ),
                  const SizedBox(height: 5),
                  Text(
                    data.deck.title,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(fontSize: 18),
                  ),
                ],
              ),
        actions: [
          if (!_fullScreen) ...[
            IconButton(
              tooltip: '대본 편집',
              onPressed: _edit,
              icon: const Icon(Icons.edit_outlined),
            ),
            IconButton(
              tooltip: '읽기 설정',
              onPressed: _settings,
              icon: const Icon(Icons.tune),
            ),
          ],
          IconButton(
            tooltip: _fullScreen ? '전체 화면 닫기' : '전체 화면',
            onPressed: _toggleFullScreen,
            icon: Icon(_fullScreen ? Icons.fullscreen_exit : Icons.fullscreen),
          ),
        ],
      ),
      body: SafeArea(
        top: false,
        child: Column(
          children: [
            if (widget.saveFailed || widget.recovered)
              Container(
                color: colors.errorContainer,
                padding: const EdgeInsets.symmetric(
                  horizontal: 16,
                  vertical: 8,
                ),
                child: Row(
                  children: [
                    Expanded(
                      child: Text(
                        widget.saveFailed
                            ? '휴대폰에 저장하지 못했습니다. 대본을 복사해 보관할 수 있어요.'
                            : '이전 백업에서 대본을 복원했습니다.',
                        style: TextStyle(color: colors.onErrorContainer),
                      ),
                    ),
                    TextButton(
                      onPressed: () => widget.onChange(data),
                      child: Text(widget.saveFailed ? '재시도' : '확인'),
                    ),
                  ],
                ),
              ),
            Expanded(
              child: LayoutBuilder(
                builder: (context, constraints) {
                  return GestureDetector(
                    key: const ValueKey('slide-touch'),
                    behavior: HitTestBehavior.opaque,
                    onTapUp: (details) => _go(
                      data.index +
                          (details.localPosition.dx < constraints.maxWidth / 2
                              ? -1
                              : 1),
                    ),
                    child: Scrollbar(
                      controller: _scroll,
                      child: SingleChildScrollView(
                        controller: _scroll,
                        padding: EdgeInsets.fromLTRB(
                          constraints.maxWidth < 380 ? 22 : 30,
                          20,
                          constraints.maxWidth < 380 ? 22 : 30,
                          56,
                        ),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Row(
                              children: [
                                Text(
                                  '${data.index + 1}'.padLeft(2, '0'),
                                  style: TextStyle(
                                    color: colors.primary,
                                    fontSize: 16,
                                    fontWeight: FontWeight.w700,
                                  ),
                                ),
                                const SizedBox(width: 12),
                                Expanded(
                                  child: Text(
                                    slide.title,
                                    style: TextStyle(
                                      fontSize: 16,
                                      height: 1.5,
                                      color: colors.onSurfaceVariant,
                                    ),
                                  ),
                                ),
                              ],
                            ),
                            const SizedBox(height: 24),
                            Text(
                              slide.body.isEmpty
                                  ? '이 슬라이드의 대본을 입력해주세요.'
                                  : slide.body,
                              key: const ValueKey('script-text'),
                              style: TextStyle(
                                fontSize: data.fontSize,
                                height: 1.65,
                                color: colors.onSurface,
                                letterSpacing: .1,
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                  );
                },
              ),
            ),
            LinearProgressIndicator(
              value: (data.index + 1) / data.deck.slides.length,
              minHeight: 2,
              backgroundColor: colors.surfaceContainerHighest,
            ),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
              child: Row(
                children: [
                  IconButton(
                    tooltip: '이전 슬라이드',
                    onPressed: data.index > 0
                        ? () => _go(data.index - 1)
                        : null,
                    icon: const Icon(Icons.chevron_left, size: 30),
                  ),
                  Expanded(
                    child: TextButton(
                      onPressed: _chooseSlide,
                      child: Text(
                        '${data.index + 1} / ${data.deck.slides.length}',
                        key: const ValueKey('slide-counter'),
                        style: const TextStyle(fontSize: 16),
                      ),
                    ),
                  ),
                  Tooltip(
                    message: _watch.isRunning ? '발표 시간 일시정지' : '발표 시간 시작',
                    child: TextButton.icon(
                      onPressed: _toggleTimer,
                      icon: Icon(
                        _watch.isRunning ? Icons.pause : Icons.play_arrow,
                        size: 20,
                      ),
                      label: Text(
                        _time,
                        style: const TextStyle(
                          fontSize: 16,
                          fontFeatures: [FontFeature.tabularFigures()],
                        ),
                      ),
                    ),
                  ),
                  IconButton(
                    tooltip: '다음 슬라이드',
                    onPressed: data.index < data.deck.slides.length - 1
                        ? () => _go(data.index + 1)
                        : null,
                    icon: const Icon(Icons.chevron_right, size: 30),
                  ),
                ],
              ),
            ),
            if (!_fullScreen)
              Padding(
                padding: const EdgeInsets.only(bottom: 10),
                child: Text(
                  '왼쪽 터치 · 이전     오른쪽 터치 · 다음',
                  style: TextStyle(
                    fontSize: 11,
                    color: colors.onSurfaceVariant,
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}
