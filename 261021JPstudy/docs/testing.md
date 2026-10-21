# 검증 기록

최종 자율 열람 버전의 검사를 기록합니다.

## 재현 명령

```sh
python3 tool/build_curriculum.py --check
python3 tool/validate_curriculum.py
dart format --output=none --set-exit-if-changed lib test integration_test
flutter analyze
flutter test --concurrency=1
flutter test integration_test/android_smoke_test.dart -d <ANDROID_DEVICE_ID>
```

## 검사 범위

- 저장: 책갈피·마지막 위치·표시 설정, 재시작, 연속 요청 순서, 쓰기 실패 시 상태 보존.
- 백업: 왕복 복원, 잘못된 형식·ID·설정 거부, 버전 1 이전, 손상 원본 보존, 초기화.
- 콘텐츠: 1,000단어·300한자, 급수별 수록량, ID·표기/읽기 중복, 가나·한글·필수 필드·예문, 생성물 일치.
- 화면: 검색·급수·주제·책갈피, 이어 읽기, 이전/다음, 숨김/펼침, 저장 지연·실패 중에도 이동 가능, 마지막 위치 저장 순서, 설정.
- 접근성: 320/390/1024px 화면, 확대 글자, 검색 키보드, 스크롤.
- 음성: 일본어 음성 없음, 지연/시간 초과, 이동·종료 시 취소.
- Android: 실제 저장 플러그인과 TTS 연결, 자율 열람, 서명 APK 설치·오프라인 실행·파일 백업.

## 결과

2026-10-21 자율 열람 버전:

- 생성물 일치 검사 및 콘텐츠 검증 통과: 1,000단어·300한자.
- `flutter test --concurrency=1`: **50개 모두 통과**, 종료 코드 0.

- `dart format --output=none --set-exit-if-changed lib test integration_test`: 16개 파일 변경 없음.
- `flutter analyze`: **No issues found**, 종료 코드 0.

Android·최종 배포 검증은 완료 후 기록합니다.

별도 담당자가 전체 1,000개 어휘의 읽기·예문·한국어 뜻 및 300자 한자 풀이를 독립 검토하고 수정했습니다. 전문 사전·언어 교사의 검증을 대체하지는 않습니다.

이 환경에서 `flutter test --coverage`는 테스트 종료 후 Linux 테스트 프로세스 오류로 수집이 멈추어 사용하지 않습니다. 커버리지 비율은 보고하지 않으며 CI와 로컬 모두 `flutter test --concurrency=1`로 실제 종료 코드까지 확인합니다.
