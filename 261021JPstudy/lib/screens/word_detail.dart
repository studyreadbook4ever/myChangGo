import 'package:flutter/material.dart';

import '../design.dart';
import '../domain.dart';
import '../study_store.dart';
import '../pronunciation.dart';

Future<void> showWord(
  BuildContext context,
  StudyStore store,
  Vocabulary card,
) async {
  await showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    backgroundColor: paper,
    builder: (_) => DraggableScrollableSheet(
      expand: false,
      initialChildSize: .84,
      minChildSize: .4,
      maxChildSize: .95,
      builder: (context, controller) => ListenableBuilder(
        listenable: store,
        builder: (context, _) => ListView(
          controller: controller,
          padding: const EdgeInsets.fromLTRB(24, 0, 24, 40),
          children: [
            Row(
              children: [
                Tag('N${card.level}'),
                const SizedBox(width: 8),
                Expanded(child: Text(card.topic)),
                IconButton(
                  tooltip: store.isBookmarked(card.id) ? '저장 해제' : '단어 저장',
                  onPressed: () =>
                      guarded(context, () => store.toggleBookmark(card.id)),
                  icon: Icon(
                    store.isBookmarked(card.id)
                        ? Icons.bookmark_rounded
                        : Icons.bookmark_border_rounded,
                  ),
                ),
              ],
            ),
            WordAnswer(card: card, store: store),
          ],
        ),
      ),
    ),
  );
  await pronunciation.stop();
}

class WordAnswer extends StatelessWidget {
  const WordAnswer({
    super.key,
    required this.card,
    required this.store,
    this.showWord = true,
  });
  final Vocabulary card;
  final StudyStore store;
  final bool showWord;
  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      if (showWord) JpText(card.word, size: 42, weight: FontWeight.w700),
      Wrap(
        crossAxisAlignment: WrapCrossAlignment.center,
        children: [
          JpText(card.reading, size: 23),
          ListenButton(card.reading),
          ListenButton(card.reading, slow: true),
        ],
      ),
      Text(card.meaning, style: Theme.of(context).textTheme.titleLarge),
      const SizedBox(height: 24),
      Surface(
        color: paper,
        padding: const EdgeInsets.all(18),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Eyebrow('문장 속에서 기억하기'),
            const SizedBox(height: 12),
            JpText(card.example, size: 19),
            const SizedBox(height: 6),
            JpText(card.exampleReading, size: 13, color: muted),
            const SizedBox(height: 8),
            Text(card.exampleMeaning),
            Align(
              alignment: Alignment.centerRight,
              child: ListenButton(card.exampleReading),
            ),
          ],
        ),
      ),
      if (store.kanjiFor(card).isNotEmpty) ...[
        const SizedBox(height: 24),
        const SectionTitle(
          '한 글자씩 연결하기',
          subtitle: '한국 한자음은 뜻을 잇는 힌트예요. 일본어 읽기는 단어째 기억하세요.',
        ),
        ...store
            .kanjiFor(card)
            .map(
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
                      if (k.onyomi.isNotEmpty)
                        Text(
                          '음독  ${k.onyomi.join(' · ')}',
                          style: const TextStyle(fontFamily: 'NotoSansJP'),
                        ),
                      if (k.kunyomi.isNotEmpty)
                        Text(
                          '훈독  ${k.kunyomi.join(' · ')}',
                          style: const TextStyle(fontFamily: 'NotoSansJP'),
                        ),
                      if (k.hint.isNotEmpty) ...[
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
      if (card.note.isNotEmpty) ...[
        const SizedBox(height: 16),
        Surface(color: mint, child: Text(card.note)),
      ],
    ],
  );
}
