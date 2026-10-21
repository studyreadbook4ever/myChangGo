import 'dart:async';
import 'package:flutter/material.dart';

import '../design.dart';
import '../domain.dart';
import '../study_store.dart';
import '../pronunciation.dart';
import 'word_detail.dart';

class StudyPage extends StatefulWidget {
  const StudyPage({super.key, required this.store, required this.mode});
  final StudyStore store;
  final StudyMode mode;
  @override
  State<StudyPage> createState() => _StudyPageState();
}

class _StudyPageState extends State<StudyPage> {
  late final List<Vocabulary> _queue;
  final Map<String, int> _attempts = {};
  int _index = 0, _remembered = 0, _again = 0;
  bool _revealed = false, _saving = false;
  final _scroll = ScrollController();
  @override
  void initState() {
    super.initState();
    _queue = widget.store.buildSession(widget.mode);
  }

  @override
  void dispose() {
    _scroll.dispose();
    pronunciation.stop();
    super.dispose();
  }

  Future<void> _rate(ReviewRating rating) async {
    if (_saving) return;
    setState(() => _saving = true);
    final card = _queue[_index];
    final version =
        widget.store.progressFor(card.id, widget.mode)?.reviewCount ?? 0;
    try {
      final saved = await widget.store.grade(
        card.id,
        widget.mode,
        rating,
        expectedReviewCount: version,
      );
      if (!mounted) return;
      if (!saved) {
        toast(context, '학습 기록이나 오늘의 한도가 바뀌었어요. 뒤로 가서 학습을 다시 시작해 주세요.');
        return;
      }
      _attempts[card.id] = (_attempts[card.id] ?? 0) + 1;
      if (rating == ReviewRating.again) {
        _again++;
        if (_attempts[card.id]! < 3) {
          final at = (_index + 4).clamp(0, _queue.length);
          _queue.insert(at, card);
        }
      } else {
        _remembered++;
      }
      setState(() {
        _index++;
        _revealed = false;
      });
      if (_scroll.hasClients) _scroll.jumpTo(0);
      unawaited(pronunciation.stop());
    } catch (_) {
      if (mounted) toast(context, '학습 기록을 저장하지 못했어요. 다시 눌러 주세요.');
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  String _interval(ReviewRating rating) {
    final p = widget.store.previewRating(
      _queue[_index].id,
      widget.mode,
      rating,
    );
    if (rating == ReviewRating.again) return '곧 다시';
    if (p.intervalDays < 1) return '잠시 후';
    return '${p.intervalDays.round()}일 뒤';
  }

  @override
  Widget build(BuildContext context) {
    final done = _index >= _queue.length;
    return Scaffold(
      appBar: AppBar(
        title: Text(widget.mode == StudyMode.reading ? '한자 → 읽기' : '한자 → 뜻'),
      ),
      body: done
          ? PageBody(
              children: [
                const SizedBox(height: 40),
                const Icon(
                  Icons.check_circle_outline_rounded,
                  size: 72,
                  color: ink,
                ),
                const SizedBox(height: 24),
                Text(
                  _queue.isEmpty ? '지금은 복습할 카드가 없어요' : '한 번 더, 기억에 가까이',
                  textAlign: TextAlign.center,
                  style: Theme.of(context).textTheme.headlineMedium,
                ),
                const SizedBox(height: 16),
                Text(
                  _queue.isEmpty
                      ? '예정된 복습을 마쳤거나 오늘의 새 단어 한도에 도달했어요.\n다른 학습 모드나 단어장을 둘러보세요.'
                      : '기억했어요 $_remembered회 · 다시 익혔어요 $_again회\n답변마다 자동으로 저장했어요.',
                  textAlign: TextAlign.center,
                ),
                const SizedBox(height: 24),
                FilledButton(
                  onPressed: () => Navigator.pop(context),
                  child: const Text('오늘의 학습으로'),
                ),
              ],
            )
          : Column(
              children: [
                Padding(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 24,
                    vertical: 10,
                  ),
                  child: Column(
                    children: [
                      Row(
                        mainAxisAlignment: MainAxisAlignment.spaceBetween,
                        children: [
                          const Expanded(child: Eyebrow('RECALL, THEN REVEAL')),
                          const SizedBox(width: 12),
                          Text('${_index + 1} / ${_queue.length}'),
                        ],
                      ),
                      const SizedBox(height: 10),
                      ClipRRect(
                        borderRadius: BorderRadius.circular(8),
                        child: LinearProgressIndicator(
                          value: _index / _queue.length,
                          minHeight: 6,
                          backgroundColor: line,
                        ),
                      ),
                    ],
                  ),
                ),
                Expanded(
                  child: SingleChildScrollView(
                    controller: _scroll,
                    padding: const EdgeInsets.fromLTRB(22, 12, 22, 24),
                    child: Center(
                      child: ConstrainedBox(
                        constraints: const BoxConstraints(maxWidth: 680),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.stretch,
                          children: [
                            Surface(
                              padding: const EdgeInsets.all(26),
                              child: Column(
                                children: [
                                  Row(
                                    mainAxisAlignment:
                                        MainAxisAlignment.spaceBetween,
                                    children: [
                                      Tag('N${_queue[_index].level}'),
                                      Text(
                                        _queue[_index].topic,
                                        style: Theme.of(
                                          context,
                                        ).textTheme.bodySmall,
                                      ),
                                    ],
                                  ),
                                  const SizedBox(height: 34),
                                  JpText(
                                    _queue[_index].word,
                                    size: 54,
                                    weight: FontWeight.w700,
                                    align: TextAlign.center,
                                  ),
                                  const SizedBox(height: 24),
                                  Text(
                                    widget.mode == StudyMode.reading
                                        ? '어떻게 읽을까요?\n소리 내어 읽고 정답을 확인하세요.'
                                        : '어떤 뜻일까요?\n한국어 뜻을 떠올려 보세요.',
                                    textAlign: TextAlign.center,
                                    style: const TextStyle(color: muted),
                                  ),
                                  const SizedBox(height: 24),
                                  if (!_revealed)
                                    FilledButton.icon(
                                      key: const Key('reveal-answer'),
                                      onPressed: () =>
                                          setState(() => _revealed = true),
                                      icon: const Icon(
                                        Icons.visibility_outlined,
                                      ),
                                      label: const Text('정답 확인'),
                                    ),
                                  if (_revealed) ...[
                                    const Divider(height: 30),
                                    WordAnswer(
                                      card: _queue[_index],
                                      store: widget.store,
                                      showWord: false,
                                    ),
                                  ],
                                ],
                              ),
                            ),
                            if (!_revealed) ...[
                              const SizedBox(height: 20),
                              const Text(
                                '눈에 익숙한 것과 기억해 낸 것은 달라요.\n정답을 보기 전에 3초만 떠올려 보세요.',
                                textAlign: TextAlign.center,
                                style: TextStyle(color: muted, fontSize: 12),
                              ),
                            ],
                          ],
                        ),
                      ),
                    ),
                  ),
                ),
                if (_revealed)
                  SafeArea(
                    top: false,
                    child: Container(
                      color: paper,
                      padding: const EdgeInsets.fromLTRB(16, 10, 16, 12),
                      child: Column(
                        children: [
                          const Text(
                            '정답을 보기 전의 기억으로 골라 주세요.',
                            style: TextStyle(fontSize: 11, color: muted),
                          ),
                          const SizedBox(height: 8),
                          LayoutBuilder(
                            builder: (context, constraints) {
                              final width = (constraints.maxWidth - 8) / 2;
                              return Wrap(
                                spacing: 8,
                                runSpacing: 8,
                                children: [
                                  for (final (rating, label, color) in [
                                    (
                                      ReviewRating.again,
                                      '몰랐어요',
                                      const Color(0xFFF9E7DF),
                                    ),
                                    (
                                      ReviewRating.hard,
                                      '어려웠어요',
                                      const Color(0xFFF5EDD9),
                                    ),
                                    (ReviewRating.good, '기억했어요', mint),
                                    (
                                      ReviewRating.easy,
                                      '쉬웠어요',
                                      const Color(0xFFDEEAEF),
                                    ),
                                  ])
                                    SizedBox(
                                      width: width,
                                      child: FilledButton(
                                        key: Key('rate-${rating.name}'),
                                        style: FilledButton.styleFrom(
                                          backgroundColor: color,
                                          foregroundColor: ink,
                                          padding: const EdgeInsets.symmetric(
                                            vertical: 10,
                                          ),
                                        ),
                                        onPressed: _saving
                                            ? null
                                            : () => _rate(rating),
                                        child: Column(
                                          children: [
                                            Text(label),
                                            Text(
                                              _interval(rating),
                                              style: const TextStyle(
                                                fontSize: 11,
                                                fontWeight: FontWeight.normal,
                                              ),
                                            ),
                                          ],
                                        ),
                                      ),
                                    ),
                                ],
                              );
                            },
                          ),
                        ],
                      ),
                    ),
                  ),
              ],
            ),
    );
  }
}
