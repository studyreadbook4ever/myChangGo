import '../lib/models.dart';

void check(bool condition, String label) {
  if (!condition) throw StateError(label);
}

void main() {
  final slides = ScriptDeck.parseText(
    '\r\n# 시작\r\n안녕하세요.\r\n\r\n---\r\n\r\n# 결과\r\n한국어 대본과 😀\r\n---\r\n',
  );
  check(slides.length == 2, 'CRLF and empty trailing slides');
  check(slides.first.title == '시작', 'Heading becomes title');
  check(slides.first.body == '안녕하세요.', 'Heading is removed from script');
  check(slides.last.body == '한국어 대본과 😀', 'Unicode is preserved');
  check(
    ScriptDeck.parseText('   \n---\n---\n').isEmpty,
    'Empty input is empty',
  );
  check(
    ScriptDeck.parseText('문장 --- 문장').length == 1,
    'Inline dashes do not split',
  );
  final deck = ScriptDeck(title: '발표', slides: slides);
  final roundTrip = ScriptDeck.parseText(deck.toText());
  check(roundTrip.last.body == slides.last.body, 'Text export round trip');
  final data = AppData(deck: deck, index: 999, fontSize: 99, dark: false);
  check(data.index == 1 && data.fontSize == 46, 'Safe upper bounds');
  final decoded = AppData.decode(data.encode());
  check(
    decoded.deck.title == '발표' && decoded.index == 1 && !decoded.dark,
    'JSON round trip',
  );
  check(
    decoded.deck.slides.last.body == slides.last.body,
    'JSON Unicode round trip',
  );
  check(
    data.copyWith(index: -1, fontSize: 1).index == 0,
    'Safe lower index bound',
  );
  check(
    data.copyWith(fontSize: double.nan).fontSize == 28,
    'Nonfinite size fallback',
  );
  var rejected = false;
  try {
    AppData.decode('{"version":1,"deck":{"title":"발표","slides":[]}}');
  } on FormatException {
    rejected = true;
  }
  check(rejected, 'Empty persisted deck is rejected');
  print('13 model checks passed.');
}
