import 'package:flutter/material.dart';
import 'package:flutter_tts/flutter_tts.dart';
import 'design.dart';

class Pronunciation {
  final FlutterTts _tts = FlutterTts();
  int _generation = 0;
  Future<void> speak(
    BuildContext context,
    String reading, {
    bool slow = false,
  }) async {
    final request = ++_generation;
    bool cancelled() => request != _generation || !context.mounted;
    try {
      final available = await _tts.isLanguageAvailable('ja-JP');
      if (cancelled()) return;
      if (available != true && available != 1) {
        if (context.mounted) {
          toast(context, '기기의 음성 설정에서 일본어 음성을 설치해 주세요.');
        }
        return;
      }
      await _tts.stop();
      if (cancelled()) return;
      await _tts.setLanguage('ja-JP');
      if (cancelled()) return;
      await _tts.setSpeechRate(slow ? 0.30 : 0.45);
      if (cancelled()) return;
      await _tts.speak(reading);
    } catch (_) {
      if (context.mounted && !cancelled()) {
        toast(context, '일본어 음성을 재생할 수 없어요. 기기의 TTS 설정을 확인해 주세요.');
      }
    }
  }

  Future<void> stop() async {
    ++_generation;
    try {
      await _tts.stop();
    } catch (_) {}
  }
}

final pronunciation = Pronunciation();

class ListenButton extends StatelessWidget {
  const ListenButton(this.reading, {super.key, this.slow = false});
  final String reading;
  final bool slow;
  @override
  Widget build(BuildContext context) => IconButton(
    tooltip: slow ? '천천히 듣기' : '일본어 발음 듣기',
    onPressed: () => pronunciation.speak(context, reading, slow: slow),
    icon: Icon(
      slow ? Icons.slow_motion_video_rounded : Icons.volume_up_outlined,
    ),
  );
}
