import 'dart:async';

import 'package:flutter/material.dart';

import '../design.dart';
import '../domain.dart';
import '../pronunciation.dart';
import '../study_store.dart';
import 'word_detail.dart';

/// A quiet, sequential view over the exact word list selected in the library.
/// Reading a page saves only its position; it does not judge or schedule a word.
class ReaderPage extends StatefulWidget {
  const ReaderPage({
    super.key,
    required this.store,
    required this.cards,
    required this.initialId,
  });

  final StudyStore store;
  final List<Vocabulary> cards;
  final String initialId;

  @override
  State<ReaderPage> createState() => _ReaderPageState();
}

class _ReaderPageState extends State<ReaderPage> {
  final _scroll = ScrollController();
  late final List<Vocabulary> _cards;
  late int _index;
  int _saveRequest = 0;
  bool _revealed = false;

  @override
  void initState() {
    super.initState();
    _cards = List.unmodifiable(widget.cards);
    final found = _cards.indexWhere((card) => card.id == widget.initialId);
    _index = found < 0 ? 0 : found;
    if (_cards.isNotEmpty) {
      final initialId = _cards[_index].id;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) unawaited(_rememberPosition(initialId));
      });
    }
  }

  Future<void> _rememberPosition(String id) async {
    final request = ++_saveRequest;
    try {
      // StudyStore serializes writes in invocation order. Capture the page ID
      // now so a delayed write cannot accidentally save a later page instead.
      await widget.store.markRead(id);
    } catch (_) {
      if (mounted && request == _saveRequest) {
        toast(context, '읽던 위치를 저장하지 못했어요. 단어는 계속 볼 수 있어요.');
      }
    }
  }

  void _move(int next) {
    if (next < 0 || next >= _cards.length || next == _index) return;
    // Native TTS may answer slowly. Cancelling it must not delay navigation.
    unawaited(pronunciation.stop());
    setState(() {
      _index = next;
      _revealed = false;
    });
    if (_scroll.hasClients) _scroll.jumpTo(0);
    // Local storage is optional for browsing. A failed save leaves the old
    // persisted position intact, while the reader stays on the chosen page.
    unawaited(_rememberPosition(_cards[next].id));
  }

  @override
  void dispose() {
    unawaited(pronunciation.stop());
    _scroll.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (_cards.isEmpty) {
      return Scaffold(
        appBar: AppBar(title: const Text('단어 읽기')),
        body: const Center(child: Text('표시할 단어가 없어요.')),
      );
    }
    final card = _cards[_index];
    return ListenableBuilder(
      listenable: widget.store,
      builder: (context, _) {
        final showReading = !widget.store.hideReadings || _revealed;
        return Scaffold(
          appBar: AppBar(
            title: const Text('단어 읽기'),
            actions: [
              IconButton(
                key: const Key('reader-bookmark'),
                tooltip: widget.store.isBookmarked(card.id) ? '저장 해제' : '단어 저장',
                onPressed: () => guarded(
                  context,
                  () => widget.store.toggleBookmark(card.id),
                ),
                icon: Icon(
                  widget.store.isBookmarked(card.id)
                      ? Icons.bookmark_rounded
                      : Icons.bookmark_border_rounded,
                ),
              ),
              const SizedBox(width: 8),
            ],
          ),
          body: SafeArea(
            top: false,
            bottom: false,
            child: Center(
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 760),
                child: SingleChildScrollView(
                  key: const Key('reader-scroll'),
                  controller: _scroll,
                  padding: const EdgeInsets.fromLTRB(24, 16, 24, 36),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Wrap(
                        spacing: 10,
                        runSpacing: 6,
                        crossAxisAlignment: WrapCrossAlignment.center,
                        children: [
                          Tag('N${card.level}'),
                          Text(
                            card.topic,
                            style: Theme.of(context).textTheme.bodySmall,
                          ),
                        ],
                      ),
                      const SizedBox(height: 24),
                      Semantics(
                        liveRegion: true,
                        child: JpText(
                          card.word,
                          size: 46,
                          weight: FontWeight.w700,
                        ),
                      ),
                      if (!showReading)
                        Align(
                          alignment: Alignment.centerLeft,
                          child: TextButton.icon(
                            key: const Key('reader-reveal'),
                            onPressed: () => setState(() => _revealed = true),
                            icon: const Icon(Icons.expand_more_rounded),
                            label: const Text('읽기 펼치기'),
                          ),
                        ),
                      WordAnswer(
                        key: ValueKey(card.id),
                        card: card,
                        store: widget.store,
                        showWord: false,
                        showReading: showReading,
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
          bottomNavigationBar: DecoratedBox(
            decoration: const BoxDecoration(
              color: paper,
              border: Border(top: BorderSide(color: line)),
            ),
            child: SafeArea(
              top: false,
              child: Padding(
                padding: const EdgeInsets.fromLTRB(20, 8, 20, 12),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Semantics(
                      label: '전체 ${_cards.length}개 중 ${_index + 1}번째 단어',
                      excludeSemantics: true,
                      child: Text(
                        '${_index + 1} / ${_cards.length}',
                        key: const Key('reader-position'),
                        style: Theme.of(context).textTheme.bodySmall,
                      ),
                    ),
                    const SizedBox(height: 8),
                    Row(
                      children: [
                        Expanded(
                          child: OutlinedButton.icon(
                            key: const Key('reader-previous'),
                            onPressed: _index == 0
                                ? null
                                : () => _move(_index - 1),
                            icon: const Icon(Icons.chevron_left_rounded),
                            label: const Text('이전'),
                          ),
                        ),
                        const SizedBox(width: 12),
                        Expanded(
                          child: OutlinedButton.icon(
                            key: const Key('reader-next'),
                            onPressed: _index == _cards.length - 1
                                ? null
                                : () => _move(_index + 1),
                            icon: const Icon(Icons.chevron_right_rounded),
                            label: const Text('다음'),
                          ),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
            ),
          ),
        );
      },
    );
  }
}
