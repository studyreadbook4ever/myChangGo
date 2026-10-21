import 'package:flutter/material.dart';

import '../design.dart';
import '../domain.dart';
import '../pronunciation.dart';
import '../study_store.dart';

/// Shared, read-only word content. The reader owns navigation and saved position.
class WordAnswer extends StatelessWidget {
  const WordAnswer({
    super.key,
    required this.card,
    required this.store,
    this.showWord = true,
    this.showReading = true,
  });

  final Vocabulary card;
  final StudyStore store;
  final bool showWord;
  final bool showReading;

  @override
  Widget build(BuildContext context) {
    final kanji = store.kanjiFor(card);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (showWord) JpText(card.word, size: 42, weight: FontWeight.w700),
        Wrap(
          crossAxisAlignment: WrapCrossAlignment.center,
          children: [
            if (showReading) JpText(card.reading, size: 23),
            ListenButton(card.reading),
            ListenButton(card.reading, slow: true),
          ],
        ),
        Text(card.meaning, style: Theme.of(context).textTheme.titleLarge),
        const SizedBox(height: 28),
        Surface(
          color: paper,
          padding: const EdgeInsets.all(18),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Eyebrow('예문'),
              const SizedBox(height: 12),
              JpText(card.example, size: 19),
              if (showReading) ...[
                const SizedBox(height: 6),
                JpText(card.exampleReading, size: 14, color: muted),
              ],
              const SizedBox(height: 8),
              Text(card.exampleMeaning),
              Align(
                alignment: Alignment.centerRight,
                child: ListenButton(card.exampleReading),
              ),
            ],
          ),
        ),
        if (kanji.isNotEmpty) ...[
          const SizedBox(height: 28),
          const SectionTitle(
            '한자 풀이',
            subtitle: '한국 훈음으로 뜻을 연결하고, 일본어 읽기는 단어에서 확인하세요.',
          ),
          ...kanji.map(
            (k) => Padding(
              padding: const EdgeInsets.only(bottom: 10),
              child: Surface(
                padding: const EdgeInsets.all(16),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        JpText(k.character, size: 36),
                        const SizedBox(width: 16),
                        Expanded(
                          child: Text(
                            k.korean,
                            style: Theme.of(context).textTheme.titleMedium,
                          ),
                        ),
                      ],
                    ),
                    if (showReading && k.onyomi.isNotEmpty)
                      Text(
                        '음독  ${k.onyomi.join(' · ')}',
                        style: const TextStyle(fontFamily: 'NotoSansJP'),
                      ),
                    if (showReading && k.kunyomi.isNotEmpty)
                      Text(
                        '훈독  ${k.kunyomi.join(' · ')}',
                        style: const TextStyle(fontFamily: 'NotoSansJP'),
                      ),
                    // Hints often contain the full reading of the headword.
                    // Keep them behind the same single reveal control.
                    if (showReading && k.hint.isNotEmpty) ...[
                      const SizedBox(height: 8),
                      Text(
                        k.hint,
                        style: Theme.of(context).textTheme.bodySmall,
                      ),
                    ],
                  ],
                ),
              ),
            ),
          ),
        ],
        if (showReading && card.note.isNotEmpty) ...[
          const SizedBox(height: 16),
          Surface(color: paper, child: Text(card.note)),
        ],
      ],
    );
  }
}
