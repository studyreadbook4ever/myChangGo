import 'package:flutter/material.dart';

import '../design.dart';
import '../domain.dart';
import '../study_store.dart';
import 'word_detail.dart';

class LibraryPage extends StatefulWidget {
  const LibraryPage({super.key, required this.store});
  final StudyStore store;
  @override
  State<LibraryPage> createState() => _LibraryPageState();
}

class _LibraryPageState extends State<LibraryPage> {
  final _search = TextEditingController();
  int? _level;
  String _filter = '전체';
  bool _hideReading = false;
  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final store = widget.store;
    final query = _search.text.trim().toLowerCase();
    final cards = store.cards
        .where(
          (c) =>
              (_level == null || c.level == _level) &&
              (_filter != '저장' || store.isBookmarked(c.id)) &&
              (_filter != '약점' || store.isMistake(c.id)) &&
              (query.isEmpty ||
                  '${c.word} ${c.reading} ${c.meaning} ${c.topic} ${store.kanjiFor(c).map((k) => k.korean).join(' ')}'
                      .toLowerCase()
                      .contains(query)),
        )
        .toList();
    return CustomScrollView(
      keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
      slivers: [
        SliverToBoxAdapter(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(22, 18, 22, 8),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Eyebrow('YOUR WORD COLLECTION'),
                const SizedBox(height: 8),
                Text(
                  '소리와 글자를 잇는 단어장',
                  style: Theme.of(context).textTheme.titleLarge,
                ),
                const SizedBox(height: 18),
                TextField(
                  controller: _search,
                  onChanged: (_) => setState(() {}),
                  decoration: InputDecoration(
                    hintText: '学校 · がっこう · 학교 · 배울 학',
                    prefixIcon: const Icon(Icons.search_rounded),
                    suffixIcon: query.isEmpty
                        ? null
                        : IconButton(
                            tooltip: '검색 지우기',
                            onPressed: () {
                              _search.clear();
                              setState(() {});
                            },
                            icon: const Icon(Icons.close),
                          ),
                  ),
                ),
                const SizedBox(height: 12),
                SingleChildScrollView(
                  scrollDirection: Axis.horizontal,
                  child: Row(
                    children: [
                      ChoiceChip(
                        label: const Text('모든 급수'),
                        selected: _level == null,
                        onSelected: (_) => setState(() => _level = null),
                      ),
                      for (final level in [5, 4, 3, 2, 1])
                        Padding(
                          padding: const EdgeInsets.only(left: 6),
                          child: ChoiceChip(
                            label: Text('N$level'),
                            selected: _level == level,
                            onSelected: (_) => setState(() => _level = level),
                          ),
                        ),
                    ],
                  ),
                ),
                const SizedBox(height: 8),
                Wrap(
                  spacing: 6,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: [
                    for (final filter in ['전체', '저장', '약점'])
                      ChoiceChip(
                        label: Text(filter),
                        selected: _filter == filter,
                        onSelected: (_) => setState(() => _filter = filter),
                      ),
                    FilterChip(
                      label: const Text('읽기 가리기'),
                      selected: _hideReading,
                      onSelected: (v) => setState(() => _hideReading = v),
                    ),
                  ],
                ),
                const SizedBox(height: 8),
                Text(
                  '${cards.length}개 단어 · 급수는 학습용 추정 분류',
                  style: Theme.of(context).textTheme.bodySmall,
                ),
              ],
            ),
          ),
        ),
        if (cards.isEmpty)
          const SliverFillRemaining(
            hasScrollBody: false,
            child: Center(
              child: Text(
                '조건에 맞는 단어가 없어요.\n검색어나 필터를 바꿔 보세요.',
                textAlign: TextAlign.center,
              ),
            ),
          )
        else
          SliverPadding(
            padding: const EdgeInsets.fromLTRB(22, 8, 22, 28),
            sliver: SliverList.builder(
              itemCount: cards.length,
              itemBuilder: (context, i) => Padding(
                padding: const EdgeInsets.only(bottom: 10),
                child: _wordTile(context, cards[i]),
              ),
            ),
          ),
      ],
    );
  }

  Widget _wordTile(BuildContext context, Vocabulary card) => Material(
    color: Colors.white,
    borderRadius: BorderRadius.circular(18),
    child: InkWell(
      borderRadius: BorderRadius.circular(18),
      onTap: () => showWord(context, widget.store, card),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(18, 14, 8, 14),
        child: Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Wrap(
                    spacing: 10,
                    crossAxisAlignment: WrapCrossAlignment.center,
                    children: [
                      JpText(card.word, size: 26),
                      Tag('N${card.level}'),
                    ],
                  ),
                  if (!_hideReading)
                    JpText(card.reading, size: 13, color: muted),
                  const SizedBox(height: 4),
                  Text(card.meaning),
                ],
              ),
            ),
            IconButton(
              tooltip: widget.store.isBookmarked(card.id) ? '저장 해제' : '단어 저장',
              onPressed: () =>
                  guarded(context, () => widget.store.toggleBookmark(card.id)),
              icon: Icon(
                widget.store.isBookmarked(card.id)
                    ? Icons.bookmark_rounded
                    : Icons.bookmark_border_rounded,
                color: ink,
              ),
            ),
          ],
        ),
      ),
    ),
  );
}
