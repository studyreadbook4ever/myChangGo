import 'dart:convert';

class ScriptSlide {
  const ScriptSlide({required this.title, required this.body});

  final String title;
  final String body;

  Map<String, dynamic> toJson() => {'title': title, 'body': body};

  factory ScriptSlide.fromJson(Map<String, dynamic> json) {
    if (json['title'] is! String || json['body'] is! String) {
      throw const FormatException('슬라이드 형식이 올바르지 않습니다.');
    }
    return ScriptSlide(title: json['title'], body: json['body']);
  }
}

class ScriptDeck {
  ScriptDeck({required this.title, required List<ScriptSlide> slides})
    : slides = List.unmodifiable(slides) {
    if (slides.isEmpty) {
      throw const FormatException('슬라이드를 한 장 이상 넣어주세요.');
    }
  }

  final String title;
  final List<ScriptSlide> slides;

  Map<String, dynamic> toJson() => {
    'title': title,
    'slides': slides.map((slide) => slide.toJson()).toList(),
  };

  factory ScriptDeck.fromJson(Map<String, dynamic> json) {
    if (json['title'] is! String || json['slides'] is! List) {
      throw const FormatException('대본 형식이 올바르지 않습니다.');
    }
    return ScriptDeck(
      title: json['title'],
      slides: (json['slides'] as List)
          .map(
            (slide) =>
                ScriptSlide.fromJson(Map<String, dynamic>.from(slide as Map)),
          )
          .toList(),
    );
  }

  String toText() => slides
      .map((slide) => '# ${slide.title}\n${slide.body}')
      .join('\n\n---\n\n');

  static List<ScriptSlide> parseText(String text) {
    final normalized = text.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
    final parts = normalized.split(RegExp(r'^\s*---\s*$', multiLine: true));
    final slides = <ScriptSlide>[];
    for (final raw in parts) {
      final content = raw.trim();
      if (content.isEmpty) continue;
      final lines = content.split('\n');
      final heading = RegExp(r'^#{1,3}\s+(.+)$').firstMatch(lines.first);
      slides.add(
        ScriptSlide(
          title: heading?.group(1)?.trim() ?? '슬라이드 ${slides.length + 1}',
          body: heading == null ? content : lines.skip(1).join('\n').trim(),
        ),
      );
    }
    return slides;
  }

  factory ScriptDeck.sample() => ScriptDeck(
    title: '내 발표 대본',
    slides: const [
      ScriptSlide(
        title: '대본을 넣고 시작하세요',
        body:
            '오른쪽 위 연필을 눌러 발표 대본을 넣어주세요.\n\n'
            '한 슬라이드에 PPT 한 장의 대본을 적으면 됩니다.\n\n'
            '지금 보이는 글은 사용법 예시입니다.',
      ),
      ScriptSlide(
        title: '화면을 눌러 넘기기',
        body:
            '화면 오른쪽을 누르면 다음 장으로,\n'
            '왼쪽을 누르면 이전 장으로 이동합니다.\n\n'
            '대본이 길면 위아래로 스크롤하세요.\n'
            '스크롤 동작으로는 장이 넘어가지 않습니다.',
      ),
      ScriptSlide(
        title: '발표에 집중하기',
        body:
            '아래 재생 버튼으로 발표 시간을 잴 수 있습니다.\n\n'
            '설정에서 글자 크기와 밝은 화면을 고르세요.\n'
            '전체 화면에서는 도구가 작게 표시됩니다.\n\n'
            '대본과 마지막으로 본 장은 이 휴대폰에 저장됩니다.',
      ),
    ],
  );
}

class AppData {
  AppData({
    required this.deck,
    int index = 0,
    double fontSize = 28,
    this.dark = true,
  }) : index = index.clamp(0, deck.slides.length - 1),
       fontSize = fontSize.isFinite ? fontSize.clamp(18, 46) : 28;

  final ScriptDeck deck;
  final int index;
  final double fontSize;
  final bool dark;

  AppData copyWith({
    ScriptDeck? deck,
    int? index,
    double? fontSize,
    bool? dark,
  }) => AppData(
    deck: deck ?? this.deck,
    index: index ?? this.index,
    fontSize: fontSize ?? this.fontSize,
    dark: dark ?? this.dark,
  );

  String encode() => jsonEncode({
    'version': 1,
    'deck': deck.toJson(),
    'index': index,
    'fontSize': fontSize,
    'dark': dark,
  });

  factory AppData.decode(String text) {
    final json = jsonDecode(text) as Map<String, dynamic>;
    if (json['version'] != 1 || json['deck'] is! Map) {
      throw const FormatException('지원하지 않는 저장 형식입니다.');
    }
    return AppData(
      deck: ScriptDeck.fromJson(Map<String, dynamic>.from(json['deck'])),
      index: (json['index'] as num?)?.toInt() ?? 0,
      fontSize: (json['fontSize'] as num?)?.toDouble() ?? 28,
      dark: json['dark'] as bool? ?? true,
    );
  }

  factory AppData.initial() => AppData(deck: ScriptDeck.sample());
}
