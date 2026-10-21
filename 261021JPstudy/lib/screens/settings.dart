import 'dart:convert';
import 'dart:typed_data';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';

import '../design.dart';
import '../study_store.dart';

class SettingsPage extends StatefulWidget {
  const SettingsPage({super.key, required this.store});
  final StudyStore store;
  @override
  State<SettingsPage> createState() => _SettingsPageState();
}

class _SettingsPageState extends State<SettingsPage> {
  bool _busy = false;
  Future<bool> _confirm(String title, String body) async =>
      await showDialog<bool>(
        context: context,
        builder: (context) => AlertDialog(
          title: Text(title),
          content: Text(body),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: const Text('취소'),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(context, true),
              child: const Text('확인'),
            ),
          ],
        ),
      ) ??
      false;
  Future<void> _export() async {
    setState(() => _busy = true);
    try {
      final output = await FilePicker.saveFile(
        dialogTitle: '학습 기록 백업',
        fileName:
            'kanji-itda-${DateTime.now().toIso8601String().substring(0, 10)}.json',
        type: FileType.custom,
        allowedExtensions: ['json'],
        bytes: Uint8List.fromList(utf8.encode(widget.store.exportJson())),
      );
      if (mounted && output != null) toast(context, '학습 기록 백업을 저장했어요.');
    } catch (_) {
      if (mounted) toast(context, '파일을 저장하지 못했어요. 다시 시도해 주세요.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _import() async {
    setState(() => _busy = true);
    try {
      final file = await FilePicker.pickFile(
        type: FileType.custom,
        allowedExtensions: ['json'],
      );
      if (file == null || !mounted) return;
      final size = await file.length();
      if (size != null && size > 5 * 1024 * 1024) {
        throw const FormatException('too large');
      }
      final bytes = await file.readAsBytes();
      if (bytes.length > 5 * 1024 * 1024) {
        throw const FormatException('too large');
      }
      if (!mounted) return;
      final confirmed = await _confirm(
        '백업을 복원할까요?',
        '현재 학습 기록·저장한 단어·설정이 백업 내용으로 바뀝니다. 필요하면 먼저 현재 기록을 백업하세요.',
      );
      if (!confirmed) return;
      await widget.store.importJson(utf8.decode(bytes));
      if (mounted) toast(context, '학습 기록을 복원했어요.');
    } on FormatException {
      if (mounted) toast(context, '올바른 한자 잇다 백업 파일이 아니에요. 현재 기록은 유지됩니다.');
    } catch (_) {
      if (mounted) toast(context, '복원하지 못했어요. 파일과 저장 공간을 확인해 주세요.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => PageBody(
    children: [
      const Eyebrow('AT YOUR OWN PACE'),
      const SizedBox(height: 10),
      Text('나에게 맞는 학습', style: Theme.of(context).textTheme.headlineMedium),
      const SizedBox(height: 24),
      const SectionTitle(
        '목표 급수',
        subtitle: '선택한 급수까지 기초 단어를 함께 배워요. 단어장은 모든 급수를 볼 수 있어요.',
      ),
      Wrap(
        spacing: 8,
        runSpacing: 8,
        children: [
          for (final n in [5, 4, 3, 2, 1])
            ChoiceChip(
              label: Text('N$n'),
              selected: widget.store.targetLevel == n,
              onSelected: _busy
                  ? null
                  : (_) =>
                        guarded(context, () => widget.store.setTargetLevel(n)),
            ),
        ],
      ),
      const SizedBox(height: 24),
      const SectionTitle(
        '하루 새 단어',
        subtitle: '처음이라면 10개를 권해요. 예정된 복습은 이 한도와 별개예요.',
      ),
      Wrap(
        spacing: 8,
        runSpacing: 8,
        children: [
          for (final n in [5, 10, 15, 20, 30])
            ChoiceChip(
              label: Text('$n개'),
              selected: widget.store.dailyNewLimit == n,
              onSelected: _busy
                  ? null
                  : (_) => guarded(
                      context,
                      () => widget.store.setDailyNewLimit(n),
                    ),
            ),
        ],
      ),
      const SizedBox(height: 30),
      const SectionTitle(
        '내 학습 기록',
        subtitle: '계정 없이 이 기기에 저장해요. 앱 삭제·기기 교체 전 백업하세요.',
      ),
      Surface(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            OutlinedButton.icon(
              onPressed: _busy ? null : _export,
              icon: const Icon(Icons.file_download_outlined),
              label: const Text('백업 파일 저장'),
            ),
            const SizedBox(height: 10),
            OutlinedButton.icon(
              onPressed: _busy ? null : _import,
              icon: const Icon(Icons.restore_rounded),
              label: const Text('백업 파일 복원'),
            ),
            if (_busy)
              const Padding(
                padding: EdgeInsets.only(top: 16),
                child: LinearProgressIndicator(),
              ),
          ],
        ),
      ),
      const SizedBox(height: 30),
      const SectionTitle('왜 이렇게 배우나요?'),
      const Surface(
        color: mint,
        child: Text(
          '• 한자 하나의 모든 음을 외우기보다, 이미 아는 단어의 소리와 글자를 연결해요.\n\n• 정답을 보기 전에 기억해 내는 연습이 핵심이에요. 읽기와 뜻의 복습 간격을 따로 기록해요.\n\n• 한국 한자음은 뜻을 이해하는 다리예요. 일본어 발음을 한국 한자음으로 대체하지 않아요.\n\n• 카드 간격은 답변에 따라 달라져요. 어려운 단어는 짧게, 쉬운 단어는 길게 복습해요.',
        ),
      ),
      const SizedBox(height: 24),
      Text(
        '수록 단어 ${widget.store.cards.length}개 · 한자 풀이 ${widget.store.kanji.length}자',
        style: Theme.of(context).textTheme.titleMedium,
      ),
      const SizedBox(height: 8),
      const Text(
        '급수는 학습 편의를 위한 추정 분류입니다. JLPT는 공식 어휘·한자 목록을 공개하지 않으며 이 앱은 시험 전체 범위를 보장하지 않습니다.\n\n발음은 기기의 일본어 TTS를 사용합니다. 오프라인 발음에는 일본어 음성 데이터가 필요할 수 있어요.',
        style: TextStyle(fontSize: 12, color: muted),
      ),
      const SizedBox(height: 20),
      TextButton(
        onPressed: () => showLicensePage(
          context: context,
          applicationName: '한자 잇다',
          applicationVersion: '1.0.0',
        ),
        child: const Text('오픈소스 라이선스'),
      ),
      TextButton(
        onPressed: _busy
            ? null
            : () async {
                if (await _confirm(
                  '학습 기록을 초기화할까요?',
                  '학습 횟수와 복습 일정을 삭제합니다. 저장한 단어와 학습 설정은 유지합니다. 필요한 기록을 먼저 백업하세요.',
                )) {
                  if (!context.mounted) return;
                  await guarded(context, () => widget.store.resetProgress());
                }
              },
        child: const Text('학습 기록 초기화', style: TextStyle(color: accent)),
      ),
    ],
  );
}
