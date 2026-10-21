# 검증 기록

최종 배포 전 검사 결과를 이 파일에 기록합니다.

## 실행 가능한 검사

```sh
python3 tool/validate_curriculum.py
dart format --output=none --set-exit-if-changed lib test integration_test
flutter analyze
flutter test --concurrency=1
flutter test integration_test/android_smoke_test.dart -d <ANDROID_DEVICE_ID>
```

- 스케줄러: 첫 카드 네 가지 평가, 복습 간격 증가, 난이도 범위, 읽기/뜻 분리, 역행한 기기 시계.
- 저장: 재시작 복원, UTC 기한과 현지 날짜, 새 단어 한도, 복습 우선순위, 중복 응답, 실패한 쓰기의 롤백, 손상 기록 보존.
- 백업: 왕복 복원, 잘못된 형식·ID·날짜·카운트 거부, 실패 시 기존 기록 유지.
- 콘텐츠: 모든 급수 존재, ID·표기/읽기 중복, 필수 필드, 한글 뜻·가나 읽기·예문, 수록량.
- 화면: 정답 숨김, 평가 후 이동, 세션 재노출 횟수 제한, 단어 검색·저장·상세, 설정, 퀴즈 완료, 좁은 화면과 확대 글자.
- Android: 실제 SharedPreferences 플러그인 저장/복원, 앱 화면에서 카드 학습, 일본어 TTS 플러그인 연결, APK 설치·실행.

## 실제 결과

2026-10-21 로컬 검증:

- 콘텐츠 생성물 일치 검사 `python3 tool/build_curriculum.py --check`: 통과.
- 콘텐츠 검증 `python3 tool/validate_curriculum.py`: 1,000단어·300한자, 중복/가나/필수 필드/미치환 조사 검사 통과.
- `flutter test --concurrency=1`: **56개 모두 통과**, 종료 코드 0.
- 별도 담당자에 의한 전체 어휘 읽기·예문·한국어 뜻 검토 후 수정 반영. 전문 사전·언어 교사의 검증을 대체하지 않음.

`flutter test --coverage`에서는 테스트의 assertion들이 통과한 뒤 일부 Linux Flutter 테스트 프로세스가 segmentation fault로 종료하고 수집이 멈췄습니다. 해당 실행은 통과로 집계하지 않았고, 커버리지 없이 전체 56개를 다시 실행하여 정상 통과를 확인했습니다. 따라서 커버리지 비율은 보고하지 않습니다. CI도 재현 가능한 `flutter test --concurrency=1`을 사용합니다.

Android 및 최종 빌드 결과는 실행 완료 후 추가합니다.
