import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'models.dart';

class DeckEditor extends StatefulWidget {
  const DeckEditor({super.key, required this.deck});
  final ScriptDeck deck;

  @override
  State<DeckEditor> createState() => _DeckEditorState();
}

class _DeckEditorState extends State<DeckEditor> {
  late final TextEditingController _title;
  late List<ScriptSlide> _slides;
  bool _dirty = false;
  bool _asking = false;

  @override
  void initState() {
    super.initState();
    _slides = List.of(widget.deck.slides);
    _title = TextEditingController(text: widget.deck.title);
    _title.addListener(() => setState(() => _dirty = true));
  }

  @override
  void dispose() {
    _title.dispose();
    super.dispose();
  }

  Future<void> _leave() async {
    if (_asking) return;
    if (_dirty) {
      _asking = true;
      final discard = await showDialog<bool>(
        context: context,
        builder: (context) => AlertDialog(
          title: const Text('저장하지 않고 나갈까요?'),
          content: const Text('계속 편집하거나 저장 버튼으로 반영할 수 있습니다.'),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context, true),
              child: const Text('수정 취소'),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(context, false),
              child: const Text('계속 편집'),
            ),
          ],
        ),
      );
      _asking = false;
      if (discard != true || !mounted) return;
    }
    if (mounted) Navigator.pop(context);
  }

  Future<void> _slideEditor(int? index) async {
    final slide = await showModalBottomSheet<ScriptSlide>(
      context: context,
      useSafeArea: true,
      isScrollControlled: true,
      builder: (context) => SlideEditor(
        slide: index == null
            ? ScriptSlide(title: '슬라이드 ${_slides.length + 1}', body: '')
            : _slides[index],
      ),
    );
    if (slide == null || !mounted) return;
    setState(() {
      index == null ? _slides.add(slide) : _slides[index] = slide;
      _dirty = true;
    });
  }

  Future<void> _pasteAll() async {
    final slides = await Navigator.of(context).push<List<ScriptSlide>>(
      MaterialPageRoute(builder: (_) => const PasteScreen()),
    );
    if (slides == null || !mounted) return;
    setState(() {
      _slides = slides;
      _dirty = true;
    });
  }

  void _save() {
    final title = _title.text.trim();
    final result = ScriptDeck(
      title: title.isEmpty ? '내 발표 대본' : title,
      slides: _slides,
    );
    Navigator.pop(context, result);
  }

  @override
  Widget build(BuildContext context) => PopScope(
    canPop: !_dirty,
    onPopInvokedWithResult: (didPop, result) {
      if (!didPop) _leave();
    },
    child: Scaffold(
      appBar: AppBar(
        leading: IconButton(
          tooltip: '편집 닫기',
          onPressed: _leave,
          icon: const Icon(Icons.arrow_back),
        ),
        title: const Text('대본 편집'),
        actions: [TextButton(onPressed: _save, child: const Text('저장'))],
      ),
      body: SafeArea(
        top: false,
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 8, 20, 16),
              child: TextField(
                controller: _title,
                decoration: const InputDecoration(labelText: '발표 제목'),
              ),
            ),
            const Padding(
              padding: EdgeInsets.symmetric(horizontal: 20),
              child: Align(
                alignment: Alignment.centerLeft,
                child: Text(
                  '한 장에 PPT 한 장의 대본을 적으세요.\n'
                  '슬라이드를 눌러 수정하고 손잡이로 순서를 바꿉니다.',
                ),
              ),
            ),
            const SizedBox(height: 12),
            Expanded(
              child: ReorderableListView.builder(
                padding: const EdgeInsets.symmetric(horizontal: 16),
                buildDefaultDragHandles: false,
                itemCount: _slides.length,
                onReorder: (oldIndex, newIndex) => setState(() {
                  if (oldIndex < newIndex) newIndex--;
                  _slides.insert(newIndex, _slides.removeAt(oldIndex));
                  _dirty = true;
                }),
                itemBuilder: (context, index) {
                  final slide = _slides[index];
                  return Card(
                    key: ObjectKey(slide),
                    margin: const EdgeInsets.only(bottom: 10),
                    child: ListTile(
                      contentPadding: const EdgeInsets.fromLTRB(16, 8, 8, 8),
                      leading: Text(
                        '${index + 1}'.padLeft(2, '0'),
                        style: TextStyle(
                          color: Theme.of(context).colorScheme.primary,
                        ),
                      ),
                      title: Text(
                        slide.title,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                      ),
                      subtitle: Text(
                        slide.body.isEmpty ? '대본을 입력하세요.' : slide.body,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                      ),
                      onTap: () => _slideEditor(index),
                      trailing: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          IconButton(
                            tooltip: '슬라이드 삭제',
                            onPressed: _slides.length == 1
                                ? null
                                : () => setState(() {
                                    _slides.removeAt(index);
                                    _dirty = true;
                                  }),
                            icon: const Icon(Icons.delete_outline, size: 20),
                          ),
                          ReorderableDragStartListener(
                            index: index,
                            child: const Padding(
                              padding: EdgeInsets.all(8),
                              child: Icon(Icons.drag_handle),
                            ),
                          ),
                        ],
                      ),
                    ),
                  );
                },
              ),
            ),
            Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  FilledButton.icon(
                    onPressed: () => _slideEditor(null),
                    icon: const Icon(Icons.add),
                    label: const Text('슬라이드 추가'),
                  ),
                  const SizedBox(height: 8),
                  OutlinedButton.icon(
                    onPressed: _pasteAll,
                    icon: const Icon(Icons.content_paste),
                    label: const Text('전체 대본 붙여넣기'),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    ),
  );
}

class SlideEditor extends StatefulWidget {
  const SlideEditor({super.key, required this.slide});
  final ScriptSlide slide;

  @override
  State<SlideEditor> createState() => _SlideEditorState();
}

class _SlideEditorState extends State<SlideEditor> {
  late final _title = TextEditingController(text: widget.slide.title);
  late final _body = TextEditingController(text: widget.slide.body);

  @override
  void dispose() {
    _title.dispose();
    _body.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Padding(
    padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
    child: SizedBox(
      height: MediaQuery.sizeOf(context).height * .9,
      child: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          children: [
            Expanded(
              child: SingleChildScrollView(
                child: Column(
                  children: [
                    const Text('슬라이드 대본', style: TextStyle(fontSize: 22)),
                    const SizedBox(height: 16),
                    TextField(
                      controller: _title,
                      decoration: const InputDecoration(labelText: '슬라이드 제목'),
                    ),
                    const SizedBox(height: 14),
                    TextField(
                      key: const ValueKey('slide-body-editor'),
                      controller: _body,
                      keyboardType: TextInputType.multiline,
                      textAlignVertical: TextAlignVertical.top,
                      minLines: 8,
                      maxLines: 18,
                      style: const TextStyle(fontSize: 20, height: 1.6),
                      decoration: const InputDecoration(
                        labelText: '발표할 대본',
                        alignLabelWithHint: true,
                        hintText: '이 PPT 슬라이드에서 할 말을 적으세요.',
                      ),
                    ),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 16),
            SizedBox(
              width: double.infinity,
              child: FilledButton(
                onPressed: () => Navigator.pop(
                  context,
                  ScriptSlide(
                    title: _title.text.trim().isEmpty
                        ? '슬라이드'
                        : _title.text.trim(),
                    body: _body.text.trim(),
                  ),
                ),
                child: const Text('이 슬라이드 적용'),
              ),
            ),
          ],
        ),
      ),
    ),
  );
}

class PasteScreen extends StatefulWidget {
  const PasteScreen({super.key});

  @override
  State<PasteScreen> createState() => _PasteScreenState();
}

class _PasteScreenState extends State<PasteScreen> {
  final _text = TextEditingController();
  int _count = 0;

  @override
  void initState() {
    super.initState();
    _text.addListener(
      () => setState(() {
        _count = ScriptDeck.parseText(_text.text).length;
      }),
    );
  }

  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(
      title: const Text('전체 대본 붙여넣기'),
      actions: [
        IconButton(
          tooltip: '클립보드에서 붙여넣기',
          onPressed: () async {
            final clipboard = await Clipboard.getData(Clipboard.kTextPlain);
            if (mounted && clipboard?.text != null)
              _text.text = clipboard!.text!;
          },
          icon: const Icon(Icons.content_paste),
        ),
      ],
    ),
    body: SafeArea(
      top: false,
      child: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Text(
              '장 사이에 --- 를 한 줄로 넣으세요.\n'
              '첫 줄에 # 제목을 쓰면 슬라이드 제목이 됩니다.',
            ),
            const SizedBox(height: 12),
            Expanded(
              child: TextField(
                key: const ValueKey('bulk-script-editor'),
                controller: _text,
                expands: true,
                maxLines: null,
                keyboardType: TextInputType.multiline,
                textAlignVertical: TextAlignVertical.top,
                style: const TextStyle(fontSize: 18, height: 1.5),
                decoration: const InputDecoration(
                  hintText:
                      '# 1. 발표 시작\n안녕하세요. 오늘 발표할 내용은…\n\n'
                      '---\n\n# 2. 연구 배경\n이 주제를 선택한 이유는…',
                ),
              ),
            ),
            const SizedBox(height: 12),
            Text(
              '$_count장으로 나뉩니다. 기존 슬라이드를 교체하며,\n'
              '편집 화면에서 저장을 누르면 발표 대본에 반영됩니다.',
              style: Theme.of(context).textTheme.bodySmall,
            ),
            const SizedBox(height: 12),
            FilledButton(
              onPressed: _count == 0
                  ? null
                  : () => Navigator.pop(
                      context,
                      ScriptDeck.parseText(_text.text),
                    ),
              child: Text('이 대본으로 바꾸기 · $_count장'),
            ),
          ],
        ),
      ),
    ),
  );
}
