📱 **[한자 잇다 APK 다운로드](https://github.com/studyreadbook4ever/myChangGo/releases/download/jpstudy-v1.0.0/kanji-itda-v1.0.0.apk)** · [릴리스·SHA-256](https://github.com/studyreadbook4ever/myChangGo/releases/tag/jpstudy-v1.0.0)

# 한자 잇다 · 261021JPstudy

**아는 소리에, 한자를 잇다.** 일본어 말하기·듣기는 익숙하지만 한자는 어려운 한국인 학습자를 위한 Flutter 단어장입니다. N1을 목표로, 기초부터 고급까지 원하는 순서와 속도로 읽습니다.

N5~N1 선별 어휘 **1,000개**, 한자 풀이 **300자**를 담았습니다. 한국어 뜻·히라가나·예문을 처음부터 함께 보여주며, 필요할 때만 읽기를 가릴 수 있습니다. 계정이나 서버 없이 오프라인에서 사용합니다.

## 설치

1. 맨 위 APK 링크를 Android 기기에서 엽니다.
2. 다운로드한 APK를 열고 Android가 요청하면 해당 브라우저/파일 앱의 ‘알 수 없는 앱 설치’를 허용합니다.
3. **한자 잇다**를 열고 관심 있는 단어를 누릅니다.
4. 발음을 듣고 싶다면 기기 TTS 설정에서 일본어 음성을 설치합니다. 오프라인 지원은 음성 엔진에 따라 다릅니다.

Android **7.0 이상**을 지원합니다. 앱 삭제 전 `설정 → 백업 파일 저장`으로 책갈피와 읽던 위치를 보관하세요. [검증 기록](docs/testing.md)

## 내 페이스로 읽기

단어장에서는 큰 한자 아래에 히라가나와 한국어 뜻이 나란히 보입니다. 단어를 누르면 예문과 번역, 한국식 훈음, 음독·훈독, 연결 힌트를 살펴볼 수 있습니다. `이전`과 `다음`으로 넘기고, 다시 보고 싶은 단어에만 책갈피를 남기세요. 앱을 다시 열면 읽던 곳에서 이어 볼 수 있습니다.

하루 목표량·점수·출석·오답노트·복습 알림은 없습니다. 쉬운 단어는 넘기고 궁금한 단어에 머무는, 편하게 읽는 책에 가까운 앱입니다.

| 기능 | 사용 방법 |
| --- | --- |
| 검색 | 한자·히라가나·한국어 뜻·훈음으로 찾기 |
| 원하는 범위 | N5~N1 급수, 주제, 책갈피로 좁혀 보기 |
| 단어 읽기 | 예문·문장 읽기·번역·한자 풀이, 이전/다음 이동 |
| 선택적 읽기 가리기 | 기본은 표시, 원할 때 가리고 상세에서 펼치기 |
| 발음 | 기기 일본어 음성으로 단어·예문 듣기, 느리게 듣기 |
| 편한 표시 | 기본·크게·더 크게, 기기 접근성 글자 크기도 반영 |
| 이어 읽기 | 마지막 단어 자동 저장, 책갈피, JSON 파일 백업·복원 |

한국 한자음은 뜻을 연결하는 단서입니다. 일본어 발음은 각 단어의 히라가나와 음성으로 익히세요. 한자 풀이가 없는 고급 글자도 단어 읽기·뜻·예문은 모두 제공됩니다.

## 앱 없이 보는 단어장

| [N5](docs/wordbooks/N5.md) | [N4](docs/wordbooks/N4.md) | [N3](docs/wordbooks/N3.md) | [N2](docs/wordbooks/N2.md) | [N1](docs/wordbooks/N1.md) |
| --- | --- | --- | --- | --- |
| 180단어 | 160단어 | 160단어 | 200단어 | 300단어 |

[커리큘럼 설명](docs/curriculum.md)에서 수록 범위와 학습 연결 방법을 확인할 수 있습니다. 앱과 Markdown 단어장은 같은 작성 원본에서 생성됩니다.

**공식 JLPT 출제 목록이나 N1 전 범위 완성본은 아닙니다.** 급수는 학습용 추정 분류입니다. JLPT는 공식 단어·한자·문법 출제 목록을 공개하지 않습니다. [JLPT 공식 FAQ](https://www.jlpt.jp/e/faq/index.html)

예문·한국어 설명·기억 힌트는 이 프로젝트를 위해 작성했습니다. 기억 힌트는 연상 도구이며 역사적 어원 설명이 아닙니다. 300자 풀이를 제공하며 모든 고급 글자를 해설하는 사전은 아닙니다.

## 기록과 백업

책갈피·마지막 읽던 단어·표시 설정만 기기에 저장합니다. 열람 횟수나 평가 이력을 수집하지 않습니다. 저장이 실패하면 안내하며, 잘못된 백업은 현재 기록을 바꾸지 않습니다. 손상된 원본은 유지하고, 다음 저장 전에 복구용 사본을 만듭니다.

백업 형식은 버전 2입니다. 초기 개발판의 버전 1 백업에서는 책갈피와 가장 최근 단어만 이어받고 표시 설정은 기본값을 사용합니다. `읽기 기록·설정 초기화`는 책갈피·읽던 위치·표시 설정을 모두 초기화합니다.

## 개발 및 검증

Flutter **3.47.7**, Dart **3.13.5**, Java **21** 기준입니다. 의존성은 `pubspec.lock`에 고정했습니다.

```sh
cd 261021JPstudy
flutter pub get --enforce-lockfile
python3 tool/build_curriculum.py --check
python3 tool/validate_curriculum.py
dart format --output=none --set-exit-if-changed lib test integration_test
flutter analyze
flutter test --concurrency=1
flutter run
```

Android 통합 테스트와 전용 키로 서명하는 릴리스 빌드는 [빌드 안내](docs/building.md), [테스트 기록](docs/testing.md)을 참고하세요. GitHub Actions도 콘텐츠·형식·정적 분석·테스트·Android APK 빌드를 확인합니다.

```text
lib/domain.dart          단어·한자 데이터 모델
lib/study_store.dart     책갈피·읽던 위치·설정·백업
lib/screens/             단어장·이어 읽기·설정
assets/data/             단어·한자 JSON
assets/fonts/            오프라인 한국어·일본어 글꼴과 OFL 고지
test/                    단위·위젯 회귀 테스트
integration_test/        Android 플러그인·읽기 흐름 통합 테스트
tool/                    콘텐츠 생성·검증 도구
docs/                    급수별 단어장, 빌드·검증 기록
```

## 라이선스

이 폴더에서 직접 작성한 코드·학습 데이터·문서는 **[The Unlicense](LICENSE)**입니다. Noto Sans JP/KR는 **SIL OFL 1.1**이며 외부 Flutter 패키지는 각각의 기존 라이선스를 따릅니다. [NOTICE](NOTICE)와 앱의 오픈소스 라이선스 화면을 확인하세요. 이 라이선스는 `myChangGo`의 다른 프로젝트에 적용되지 않습니다.
