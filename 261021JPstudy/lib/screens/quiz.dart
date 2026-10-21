import 'dart:math';

import 'package:flutter/material.dart';

import '../design.dart';
import '../domain.dart';
import '../study_store.dart';
import '../pronunciation.dart';
import '../quiz_logic.dart';

class QuizPage extends StatefulWidget {
  const QuizPage({super.key, required this.store});
  final StudyStore store;
  @override
  State<QuizPage> createState() => _QuizPageState();
}

class _QuizPageState extends State<QuizPage> {
  final _random = Random();
  late List<Vocabulary> _cards;
  List<String> _options = [];
  final List<Vocabulary> _missed = [];
  int _index = 0, _correct = 0;
  String? _selected;
  @override
  void initState() {
    super.initState();
    _restart();
  }

  void _restart() {
    final eligible = widget.store.eligibleCards;
    final pool = eligible
        .where(
          (card) =>
              widget.store.progressFor(card.id, StudyMode.reading) != null ||
              widget.store.progressFor(card.id, StudyMode.meaning) != null,
        )
        .toList();
    // Begin with the learner's actual vocabulary, filling a small foundation
    // pool on first use instead of jumping randomly into N1 words.
    if (pool.length < 10) {
      final ids = pool.map((card) => card.id).toSet();
      for (final card in eligible) {
        if (pool.length >= 20) break;
        if (ids.add(card.id)) pool.add(card);
      }
    }
    pool.shuffle(_random);
    pool.sort(
      (a, b) => (widget.store.isMistake(b.id) ? 1 : 0).compareTo(
        widget.store.isMistake(a.id) ? 1 : 0,
      ),
    );
    _cards = pool.take(10).toList();
    _index = 0;
    _correct = 0;
    _selected = null;
    _missed.clear();
    _makeOptions();
  }

  void _makeOptions() {
    if (_index >= _cards.length) return;
    _options = readingOptions(
      _cards[_index],
      widget.store.eligibleCards,
      _random,
    );
  }

  @override
  void dispose() {
    pronunciation.stop();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final done = _index >= _cards.length;
    return Scaffold(
      appBar: AppBar(title: const Text('읽기 확인 퀴즈')),
      body: PageBody(
        children: [
          const Eyebrow('QUICK CHECK'),
          const SizedBox(height: 12),
          if (done) ...[
            Text(
              '$_correct / ${_cards.length}',
              style: Theme.of(context).textTheme.headlineLarge,
            ),
            const SizedBox(height: 8),
            const Text('헷갈린 단어를 한 번 더 소리 내어 읽어 보세요.'),
            const SizedBox(height: 24),
            for (final c in _missed)
              Padding(
                padding: const EdgeInsets.only(bottom: 12),
                child: Surface(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      JpText(c.word),
                      JpText(c.reading, size: 19),
                      Text(c.meaning),
                      ListenButton(c.reading),
                    ],
                  ),
                ),
              ),
            FilledButton(
              onPressed: () => setState(_restart),
              child: const Text('다시 10문제'),
            ),
            const SizedBox(height: 10),
            OutlinedButton(
              onPressed: () => Navigator.pop(context),
              child: const Text('학습으로 돌아가기'),
            ),
          ] else ...[
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Text('${_index + 1} / ${_cards.length}'),
                Text('정답 $_correct개'),
              ],
            ),
            const SizedBox(height: 20),
            Surface(
              child: Column(
                children: [
                  const Text('알맞은 읽기를 골라 주세요.', style: TextStyle(color: muted)),
                  const SizedBox(height: 24),
                  JpText(
                    _cards[_index].word,
                    size: 48,
                    align: TextAlign.center,
                  ),
                  const SizedBox(height: 24),
                ],
              ),
            ),
            const SizedBox(height: 20),
            for (final option in _options)
              Padding(
                padding: const EdgeInsets.only(bottom: 10),
                child: OutlinedButton(
                  style: OutlinedButton.styleFrom(
                    backgroundColor: _selected == null
                        ? Colors.white
                        : option == _cards[_index].reading
                        ? mint
                        : option == _selected
                        ? const Color(0xFFF9E7DF)
                        : Colors.white,
                  ),
                  onPressed: _selected != null
                      ? null
                      : () => setState(() {
                          _selected = option;
                          if (option == _cards[_index].reading) {
                            _correct++;
                          } else {
                            _missed.add(_cards[_index]);
                          }
                        }),
                  child: Row(
                    children: [
                      Expanded(child: JpText(option, size: 21)),
                      if (_selected != null && option == _cards[_index].reading)
                        const Icon(Icons.check_circle, color: ink),
                    ],
                  ),
                ),
              ),
            if (_selected != null) ...[
              Text(
                _selected == _cards[_index].reading
                    ? '정답이에요! ${_cards[_index].meaning}'
                    : '정답은 ${_cards[_index].reading} · ${_cards[_index].meaning}',
                style: const TextStyle(fontWeight: FontWeight.w700),
              ),
              ListenButton(_cards[_index].reading),
              FilledButton(
                onPressed: () => setState(() {
                  _index++;
                  _selected = null;
                  _makeOptions();
                }),
                child: Text(_index == _cards.length - 1 ? '결과 보기' : '다음 문제'),
              ),
            ],
          ],
          const SizedBox(height: 20),
          const Text(
            '학습한 단어와 다음 기초 단어에서 최대 10문제.\n복습 간격은 카드를 직접 떠올리는 학습에서만 바뀝니다.',
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: 12, color: muted),
          ),
        ],
      ),
    );
  }
}
