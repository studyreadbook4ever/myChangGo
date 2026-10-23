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
      final snapshot = await widget.store.exportSnapshot();
      if (!mounted) return;
      final output = await FilePicker.saveFile(
        dialogTitle: '읽기 기록 백업',
        fileName:
            'kanji-itda-${DateTime.now().toIso8601String().substring(0, 10)}.json',
        type: FileType.custom,
        allowedExtensions: ['json'],
        bytes: Uint8List.fromList(utf8.encode(snapshot)),
      );
      if (mounted && output != null) toast(context, '읽기 기록 백업을 저장했어요.');
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
        '현재 책갈피·읽던 위치·표시 설정이 백업 내용으로 바뀝니다. 필요하면 먼저 현재 기록을 백업하세요.',
      );
      if (!confirmed) return;
      await widget.store.importJson(utf8.decode(bytes));
      if (mounted) toast(context, '읽기 기록을 복원했어요.');
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
      Text('편안한 읽기 설정', style: Theme.of(context).textTheme.headlineMedium),
      const SizedBox(height: 24),
      const SectionTitle('글자 크기', subtitle: '기기의 접근성 글자 크기에 더해 적용해요.'),
      Wrap(
        spacing: 8,
        runSpacing: 8,
        children: [
          for (final (size, label) in [(1.0, '기본'), (1.2, '크게'), (1.4, '더 크게')])
            ChoiceChip(
              label: Text(label),
              selected: widget.store.textScale == size,
              onSelected: _busy
                  ? null
                  : (_) =>
                        guarded(context, () => widget.store.setTextScale(size)),
            ),
        ],
      ),
      const SizedBox(height: 16),
      SwitchListTile.adaptive(
        contentPadding: EdgeInsets.zero,
        title: const Text('히라가나 읽기 가리기'),
        subtitle: const Text('단어 상세에서 필요할 때 펼쳐 볼 수 있어요.'),
        value: widget.store.hideReadings,
        onChanged: _busy
            ? null
            : (v) => guarded(context, () => widget.store.setHideReadings(v)),
      ),
      const SizedBox(height: 28),
      const SectionTitle(
        '책갈피와 읽던 곳 보관',
        subtitle: '이 기기에 자동으로 저장해요. 다른 기기로 옮길 때 파일로 보관하세요.',
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
      const SizedBox(height: 28),
      const Surface(
        color: mint,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('내 페이스에 맞게', style: TextStyle(fontWeight: FontWeight.w700)),
            SizedBox(height: 10),
            Text(
              '관심 있는 급수나 주제를 골라 읽어 보세요. 익숙한 단어는 가볍게 넘기고, 다시 보고 싶은 단어에는 책갈피를 남겨요.\n\n아는 일본어 소리에 한자 모양과 한국어 뜻을 연결해 보세요. 읽던 단어는 다음에 이어서 볼 수 있어요.',
            ),
          ],
        ),
      ),
      const SizedBox(height: 24),
      Text(
        '단어 ${widget.store.cards.length}개 · 한자 풀이 ${widget.store.kanji.length}자',
        style: Theme.of(context).textTheme.titleMedium,
      ),
      const SizedBox(height: 8),
      const Text(
        '급수는 학습용 추정 분류이며 JLPT 전체 범위를 보장하지 않습니다. 한자 풀이는 기초·연결 한자에 제공해요.\n\n발음은 기기의 일본어 TTS를 사용합니다. 오프라인으로 들으려면 일본어 음성 데이터를 설치해야 할 수 있어요.',
        style: TextStyle(fontSize: 12, color: muted),
      ),
      const SizedBox(height: 16),
      TextButton(
        onPressed: () => showLicensePage(
          context: context,
          applicationName: '한자 잇다',
          applicationVersion: '1.0.1',
        ),
        child: const Text('오픈소스 라이선스'),
      ),
      TextButton(
        onPressed: _busy
            ? null
            : () async {
                if (await _confirm(
                  '읽기 기록과 설정을 초기화할까요?',
                  '책갈피와 읽던 위치를 지우고 표시 설정을 기본값으로 되돌립니다. 필요한 기록은 먼저 백업하세요.',
                )) {
                  if (!context.mounted) return;
                  await guarded(context, () => widget.store.resetProgress());
                }
              },
        child: const Text('읽기 기록·설정 초기화', style: TextStyle(color: accent)),
      ),
    ],
  );
}
