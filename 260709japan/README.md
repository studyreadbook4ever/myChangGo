# Kanji Wake

[APK 바로 다운로드](https://github.com/studyreadbook4ever/myChangGo/releases/download/260709japan-debug-v0.1.0/app-debug.apk)

일본어 한자 단어를 4지선다 퀴즈로 풀어야 지나갈 수 있는 Kotlin Android 테스트 앱입니다. 잠금화면을 완전히 대체하는 앱이 아니라, Android 정책 안에서 동작하는 soft lock 방식으로 만들었습니다.

## 들어있는 기능

- 일본어 한자 복합명사와 한자 기반 동사구를 랜덤으로 출제합니다.
- 생성 단어장 9,000개 이상과 직접 넣은 기본 시드 단어를 함께 로컬 DB에 넣습니다.
- 한글 뜻을 4지선다 중에서 고릅니다.
- 정답을 맞히면 읽는 법, 자세한 설명, 일본어 예문, 예문 한글 뜻을 보여줍니다.
- `Endless Mode`에서 문제를 계속 풀 수 있고, 우측 상단 `모드 종료` 버튼으로 나갈 수 있습니다.
- soft lock 테스트 모드에서는 우측 상단에 `10`부터 `0`까지 카운트다운이 보이고, 이후 `광고 보고 잠금해제` 버튼이 나타납니다.
- 앱에서 잠금 후 퀴즈를 켜면 Foreground Service가 잠금 해제 이벤트 뒤 퀴즈 화면을 띄웁니다.
- 단어 데이터는 `app/src/main/assets/vocabulary.tsv`와 기본 시드에서 로컬 SQLite DB로 들어갑니다.

## 빌드

```bash
./gradlew assembleDebug
```

빌드된 APK 위치:

```text
app/build/outputs/apk/debug/app-debug.apk
```

## 단어장 생성/검증

```bash
python3 tools/generate_vocabulary.py
python3 tools/validate_vocabulary.py
```

검증 스크립트는 생성 단어장이 3,000개 이상인지, 중복이 없는지, 한자가 들어있는지, 너무 쉬운 단어가 섞이지 않았는지 확인합니다.

## 참고

Android는 일반 앱이 시스템 잠금화면을 완전히 대체하거나 강제로 막는 것을 허용하지 않습니다. 그래서 이 앱은 사용자가 켠 경우 Foreground Service로 잠금 해제 이벤트를 감지한 뒤 퀴즈 Activity를 띄우는 soft lock 구조입니다.
