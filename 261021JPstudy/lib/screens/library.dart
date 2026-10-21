import 'package:flutter/material.dart';
import '../design.dart';
import '../domain.dart';
import '../study_store.dart';
import 'reader.dart';

class LibraryPage extends StatefulWidget {
  const LibraryPage({super.key, required this.store});
  final StudyStore store;
  @override
  State<LibraryPage> createState() => _LibraryPageState();
}

class _LibraryPageState extends State<LibraryPage> {
  final _search = TextEditingController();
  bool _bookmarksOnly = false;
  String? _topic;
  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  void _open(Vocabulary card, List<Vocabulary> cards) {
    FocusManager.instance.primaryFocus?.unfocus();
    Navigator.push(
      context,
      MaterialPageRoute<void>(
        builder: (_) =>
            ReaderPage(store: widget.store, cards: cards, initialId: card.id),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final store = widget.store;
    final query = _search.text.trim().toLowerCase();
    final topics = store.visibleCards.map((c) => c.topic).toSet().toList();
    final selectedTopic = topics.contains(_topic) ? _topic : null;
    final cards = store.visibleCards
        .where(
          (c) =>
              (!_bookmarksOnly || store.isBookmarked(c.id)) &&
              (selectedTopic == null || c.topic == selectedTopic) &&
              (query.isEmpty ||
                  '${c.word} ${c.reading} ${c.meaning} ${c.topic} ${store.kanjiFor(c).map((k) => k.korean).join(' ')}'
                      .toLowerCase()
                      .contains(query)),
        )
        .toList();
    final last = store.lastReadCard;
    return CustomScrollView(
      key: const PageStorageKey('library-scroll'),
      keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
      slivers: [
        SliverToBoxAdapter(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(22, 16, 22, 8),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(
                  '내 속도로 읽는 단어장',
                  style: Theme.of(context).textTheme.titleLarge,
                ),
                const SizedBox(height: 10),
                Text(
                  'N5~N1 · ${store.cards.length}개 단어 · 원하는 순서로',
                  style: const TextStyle(color: muted, height: 1.7),
                ),
                const SizedBox(height: 20),
                if (last != null && query.isEmpty) ...[
                  Material(
                    color: mint,
                    borderRadius: BorderRadius.circular(18),
                    child: InkWell(
                      key: const Key('continue-reading'),
                      borderRadius: BorderRadius.circular(18),
                      onTap: () => _open(
                        last,
                        store.visibleCards.any((c) => c.id == last.id)
                            ? store.visibleCards
                            : store.cards,
                      ),
                      child: Padding(
                        padding: const EdgeInsets.all(18),
                        child: Row(
                          children: [
                            const Icon(
                              Icons.bookmark_outline_rounded,
                              color: ink,
                            ),
                            const SizedBox(width: 14),
                            Expanded(
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  const Text(
                                    '읽던 곳에서 이어 보기',
                                    style: TextStyle(
                                      fontSize: 12,
                                      color: muted,
                                    ),
                                  ),
                                  JpText(last.word, size: 24),
                                  Text(
                                    last.meaning,
                                    style: const TextStyle(fontSize: 13),
                                  ),
                                ],
                              ),
                            ),
                            const Icon(Icons.arrow_forward_rounded, color: ink),
                          ],
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(height: 16),
                ],
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
                        selected: store.preferredLevel == null,
                        onSelected: (_) => guarded(
                          context,
                          () => store.setPreferredLevel(null),
                        ),
                      ),
                      for (final level in [5, 4, 3, 2, 1])
                        Padding(
                          padding: const EdgeInsets.only(left: 6),
                          child: ChoiceChip(
                            label: Text('N$level'),
                            selected: store.preferredLevel == level,
                            onSelected: (_) => guarded(
                              context,
                              () => store.setPreferredLevel(level),
                            ),
                          ),
                        ),
                    ],
                  ),
                ),
                const SizedBox(height: 10),
                DropdownButtonFormField<String>(
                  key: ValueKey('${store.preferredLevel}:$selectedTopic'),
                  initialValue: selectedTopic ?? '',
                  isExpanded: true,
                  isDense: false,
                  decoration: const InputDecoration(
                    labelText: '주제',
                    prefixIcon: Icon(Icons.folder_open_rounded),
                  ),
                  items: [
                    const DropdownMenuItem(value: '', child: Text('모든 주제')),
                    ...topics.map(
                      (t) => DropdownMenuItem(value: t, child: Text(t)),
                    ),
                  ],
                  onChanged: (value) =>
                      setState(() => _topic = value == '' ? null : value),
                ),
                const SizedBox(height: 10),
                Wrap(
                  spacing: 8,
                  runSpacing: 4,
                  children: [
                    FilterChip(
                      label: const Text('책갈피만'),
                      avatar: const Icon(
                        Icons.bookmark_border_rounded,
                        size: 17,
                      ),
                      selected: _bookmarksOnly,
                      onSelected: (v) => setState(() => _bookmarksOnly = v),
                    ),
                    FilterChip(
                      label: const Text('읽기 가리기'),
                      selected: store.hideReadings,
                      onSelected: (v) =>
                          guarded(context, () => store.setHideReadings(v)),
                    ),
                  ],
                ),
                const SizedBox(height: 10),
                Text(
                  '${cards.length}개 단어 · 누르면 예문과 한자 풀이가 열려요.',
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
              child: Padding(
                padding: EdgeInsets.all(24),
                child: Text(
                  '표시할 단어가 없어요.\n검색어나 필터를 바꿔 보세요.',
                  textAlign: TextAlign.center,
                ),
              ),
            ),
          )
        else
          SliverPadding(
            padding: const EdgeInsets.fromLTRB(22, 8, 22, 28),
            sliver: SliverList.builder(
              itemCount: cards.length,
              itemBuilder: (context, i) {
                final card = cards[i];
                return Padding(
                  padding: const EdgeInsets.only(bottom: 10),
                  child: Material(
                    color: Colors.white,
                    borderRadius: BorderRadius.circular(18),
                    child: InkWell(
                      borderRadius: BorderRadius.circular(18),
                      onTap: () => _open(card, cards),
                      child: Padding(
                        padding: const EdgeInsets.fromLTRB(18, 15, 8, 15),
                        child: Row(
                          children: [
                            Expanded(
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Wrap(
                                    spacing: 10,
                                    crossAxisAlignment:
                                        WrapCrossAlignment.center,
                                    children: [
                                      JpText(card.word, size: 28),
                                      Tag('N${card.level}'),
                                    ],
                                  ),
                                  if (!store.hideReadings)
                                    JpText(
                                      card.reading,
                                      size: 15,
                                      color: muted,
                                    ),
                                  const SizedBox(height: 5),
                                  Text(card.meaning),
                                ],
                              ),
                            ),
                            IconButton(
                              tooltip: store.isBookmarked(card.id)
                                  ? '책갈피 해제'
                                  : '책갈피 추가',
                              onPressed: () => guarded(
                                context,
                                () => store.toggleBookmark(card.id),
                              ),
                              icon: Icon(
                                store.isBookmarked(card.id)
                                    ? Icons.bookmark_rounded
                                    : Icons.bookmark_border_rounded,
                                color: ink,
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                  ),
                );
              },
            ),
          ),
      ],
    );
  }
}
