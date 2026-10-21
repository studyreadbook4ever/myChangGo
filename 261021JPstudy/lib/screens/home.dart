import 'package:flutter/material.dart';

import '../design.dart';
import '../domain.dart';
import '../study_store.dart';
import 'study.dart';
import 'quiz.dart';
import 'word_detail.dart';

class HomePage extends StatelessWidget {
  const HomePage({super.key, required this.store, required this.openLibrary});
  final StudyStore store;
  final VoidCallback openLibrary;
  void _study(BuildContext context, StudyMode mode) => Navigator.push(
    context,
    MaterialPageRoute<void>(
      builder: (_) => StudyPage(store: store, mode: mode),
    ),
  );
  @override
  Widget build(BuildContext context) {
    final eligible = store.eligibleCards;
    final today = eligible.isEmpty
        ? null
        : eligible[DateTime.now().difference(DateTime(2026)).inDays.abs() %
              eligible.length];
    return PageBody(
      children: [
        const Eyebrow('SMALL STEPS. LASTING WORDS.'),
        const SizedBox(height: 12),
        Text(
          '아는 소리에,\n한자를 잇다.',
          style: Theme.of(context).textTheme.headlineLarge,
        ),
        const SizedBox(height: 10),
        const Text(
          '들으면 아는 일본어를\n이제 눈으로도 읽을 수 있도록.',
          style: TextStyle(color: muted, height: 1.7),
        ),
        const SizedBox(height: 26),
        Surface(
          color: ink,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  const Icon(
                    Icons.auto_awesome_outlined,
                    color: Color(0xFFD7E9A9),
                    size: 20,
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      '오늘의 연결',
                      style: Theme.of(
                        context,
                      ).textTheme.titleMedium?.copyWith(color: Colors.white),
                    ),
                  ),
                  Tag(
                    'N5${store.targetLevel < 5 ? ' → N${store.targetLevel}' : ' 기초'}',
                    color: const Color(0xFFD7E9A9),
                  ),
                ],
              ),
              const SizedBox(height: 24),
              Wrap(
                spacing: 30,
                runSpacing: 16,
                children: [
                  _heroStat('${store.dueCount}', '복습할 카드'),
                  _heroStat('${store.remainingNewCount}', '남은 새 단어 한도'),
                  _heroStat('${store.streak}', '일 연속 학습'),
                ],
              ),
              const SizedBox(height: 22),
              const Divider(color: Color(0xFF426156)),
              const SizedBox(height: 12),
              const Text(
                '복습 먼저, 새 단어는 조금씩. 한 번에 최대 20개 단어.',
                style: TextStyle(color: Color(0xFFD6E3D7), fontSize: 12),
              ),
              const SizedBox(height: 18),
              SizedBox(
                width: double.infinity,
                child: FilledButton.icon(
                  key: const Key('start-reading'),
                  style: FilledButton.styleFrom(
                    backgroundColor: const Color(0xFFD7E9A9),
                    foregroundColor: ink,
                  ),
                  onPressed: () => _study(context, StudyMode.reading),
                  icon: const Icon(Icons.arrow_forward_rounded),
                  label: const Text('읽기 떠올리기'),
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 16),
        LayoutBuilder(
          builder: (context, box) => Wrap(
            spacing: 12,
            runSpacing: 12,
            children: [
              SizedBox(
                width: (box.maxWidth - 12) / 2,
                child: _action(
                  context,
                  Icons.translate_rounded,
                  '뜻 떠올리기',
                  '읽기와 따로 복습',
                  () => _study(context, StudyMode.meaning),
                ),
              ),
              SizedBox(
                width: (box.maxWidth - 12) / 2,
                child: _action(
                  context,
                  Icons.fact_check_outlined,
                  '10문제 퀴즈',
                  '헷갈리는 읽기 확인',
                  () => Navigator.push(
                    context,
                    MaterialPageRoute<void>(
                      builder: (_) => QuizPage(store: store),
                    ),
                  ),
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 30),
        const SectionTitle('차곡차곡 쌓이는 기록'),
        Surface(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Wrap(
                alignment: WrapAlignment.spaceBetween,
                spacing: 16,
                runSpacing: 8,
                children: [
                  const Text('오늘 떠올린 횟수'),
                  Text(
                    '${store.todayReviewCount}회',
                    style: const TextStyle(fontWeight: FontWeight.w800),
                  ),
                ],
              ),
              const Divider(height: 28),
              Wrap(
                alignment: WrapAlignment.spaceBetween,
                spacing: 16,
                runSpacing: 8,
                children: [
                  const Text('시작한 단어'),
                  Text('${store.learnedCount} / ${store.cards.length}개'),
                ],
              ),
              const SizedBox(height: 12),
              ClipRRect(
                borderRadius: BorderRadius.circular(8),
                child: LinearProgressIndicator(
                  value: store.cards.isEmpty
                      ? 0
                      : store.learnedCount / store.cards.length,
                  minHeight: 7,
                  backgroundColor: line,
                ),
              ),
              const SizedBox(height: 12),
              Align(
                alignment: Alignment.centerLeft,
                child: Text(
                  '읽기·뜻 모두 21일 이상 간격에 도달한 단어 ${store.masteredCount}개',
                  style: Theme.of(context).textTheme.bodySmall,
                ),
              ),
            ],
          ),
        ),
        if (today != null) ...[
          const SizedBox(height: 30),
          Row(
            children: [
              const Expanded(child: SectionTitle('오늘의 한 단어')),
              TextButton(onPressed: openLibrary, child: const Text('단어장 전체')),
            ],
          ),
          Material(
            color: Colors.white,
            borderRadius: BorderRadius.circular(24),
            child: InkWell(
              borderRadius: BorderRadius.circular(24),
              onTap: () => showWord(context, store, today),
              child: Padding(
                padding: const EdgeInsets.all(24),
                child: Row(
                  children: [
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Tag('N${today.level} · ${today.topic}'),
                          const SizedBox(height: 12),
                          JpText(today.word, size: 36),
                          JpText(today.reading, size: 16, color: muted),
                          const SizedBox(height: 8),
                          Text(today.meaning),
                        ],
                      ),
                    ),
                    const Icon(Icons.north_east_rounded, color: ink),
                  ],
                ),
              ),
            ),
          ),
        ],
        const SizedBox(height: 26),
        const Surface(
          color: mint,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('처음이라면 이렇게', style: TextStyle(fontWeight: FontWeight.w800)),
              SizedBox(height: 8),
              Text(
                '① 한자를 보고 아는 소리를 떠올려요.\n② 정답에서 한국 한자음과 뜻을 연결해요.\n③ 몰랐던 단어는 잠시 뒤 다시 만나요.\n④ 다음 날은 밀린 복습부터 시작해요.',
                style: TextStyle(height: 1.9),
              ),
            ],
          ),
        ),
      ],
    );
  }

  Widget _heroStat(String value, String label) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Text(
        value,
        style: const TextStyle(
          fontSize: 34,
          fontWeight: FontWeight.w700,
          color: Colors.white,
        ),
      ),
      Text(
        label,
        style: const TextStyle(fontSize: 11, color: Color(0xFFD6E3D7)),
      ),
    ],
  );
  Widget _action(
    BuildContext context,
    IconData icon,
    String title,
    String subtitle,
    VoidCallback onTap,
  ) => Material(
    color: Colors.white,
    borderRadius: BorderRadius.circular(20),
    child: InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(20),
      child: Padding(
        padding: const EdgeInsets.all(18),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(icon, color: ink),
            const SizedBox(height: 14),
            Text(title, style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 5),
            Text(subtitle, style: Theme.of(context).textTheme.bodySmall),
          ],
        ),
      ),
    ),
  );
}
