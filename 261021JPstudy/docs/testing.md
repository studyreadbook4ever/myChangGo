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

2026-10-21~22 자율 열람 버전:

- 생성물 일치 검사 및 콘텐츠 검증 통과: 1,000단어·300한자.
- `flutter test --concurrency=1`: **51개 모두 통과**, 종료 코드 0. 최종 실행 8초, 경고 없음.
- 320px 화면에서 시스템 글씨 1.5배 × 앱 글씨 1.4배로 실제 긴 주제명을 선택해 여러 줄 전체가 표시되는지 검증했습니다. 화면 아래로 밀린 버튼을 테스트에서 누르기 전 스크롤·렌더링 완료를 기다립니다.

- `dart format --output=none --set-exit-if-changed lib test integration_test`: 16개 파일 변경 없음.
- `flutter analyze`: **No issues found**, 종료 코드 0.

- 최종 코드 `b746606`의 [GitHub Actions 39622641649](https://github.com/studyreadbook4ever/myChangGo/actions/runs/39622641649)에서 데이터·포맷·정적 분석·51개 테스트·축소 릴리스 APK 빌드 및 Kotlin/JNI 검사 **모두 성공**했습니다.

- API 35 Android 에뮬레이터(비행기 모드)에서 개발 빌드(`97e57eb`) 통합 테스트 **3개 통과**, 종료 코드 0. 실제 저장 플러그인 재로드, 일본어 TTS 사용 가능 여부 조회, 단어 읽기·다음·책갈피·이어 보기, 표시 설정 재로드, 백업→초기화→복원 일치를 확인했습니다.
- 통합 테스트의 스크롤 후 클릭은 다음 화면 렌더링을 기다리도록 보정한 뒤 재실행했습니다. 테스트 실행 시간은 6초, 마지막 증분 빌드는 82초였습니다.

## 배포에서 발견해 수정한 문제

디버그 통합 테스트를 통과한 뒤 서명 릴리스 APK를 직접 설치하자 단어장 시작 실패를 발견했습니다. R8 코드 축소가 Dart JNI에서 이름으로 찾는 Kotlin 클래스를 변경한 것이 원인이었습니다. [Pigeon 공식 가이드](https://flutter.googlesource.com/mirrors/packages/+/refs/heads/main/packages/pigeon/native_interop_guide.md)에 따라 필요한 클래스와 메서드를 보존하고, 수정 APK의 오프라인 시작을 확인했습니다. 문제가 있던 APK는 공개하지 않았습니다.

`python3 tool/verify_release_jni.py`는 실제 R8 매핑과 APK DEX 정의를 함께 검사합니다. 수정된 APK는 통과하고, 기존의 잘못된 APK는 수정된 매핑과 조합해도 실패하는 것을 확인했습니다. CI도 임시 서명 키로 축소 릴리스 APK를 빌드해 같은 검사를 수행합니다.

## 배포 APK

- 전용 RSA 4096 릴리스 키로 서명한 `kanji-itda-v1.0.0.apk` 빌드 완료: **64,539,135바이트**.
- `apksigner verify --verbose --print-certs`: 검증 성공, v2 서명.
- 앱 ID `kr.changgo.jpstudy`, 버전 `1.0.0+1`, 최소 API 24(Android 7.0), 대상 API 36.
- `armeabi-v7a`, `arm64-v8a`, `x86_64` 포함.
- `zipalign` 16 KiB 정렬 검사 및 모든 64비트 ELF LOAD 정렬 검사 통과.
- 릴리스 매니페스트에 `INTERNET` 권한 없음.
- APK SHA-256: `9940b8364b82c394c1218e7cb39f22884057b96df5d7c21b7d0a6eaafb731483`.
- 서명 인증서 SHA-256: `b97278de11468d8b39836e5ec5f6174af1ea02fe65eeb7c2a4e1abdd349c8039`.
- GitHub에 업로드된 자산의 SHA-256과 로컬 APK 해시 일치 확인.

수정 릴리스에서 Android 문서 선택기의 저장 취소·JSON 저장·초기화·파일 복원·재내보내기를 확인했습니다. 전후 백업은 190바이트로 완전히 같았으며 `学校`의 책갈피·읽던 위치, N5 필터, 글자 크기 1.2가 보존됐습니다. 두 백업의 SHA-256은 `510f9baaa68cfb2e32bd2409bbf9d256a009bd299b3a9547eab3338cba051998`입니다.

최종 `b746606` 서명 APK를 업데이트 설치한 뒤 앱 프로세스를 종료하고 비행기 모드에서 다시 시작했습니다. 단어장 로딩, `学校` 이어 읽기(N5 32/180), 책갈피 및 글자 크기 1.2·N5 필터 유지가 정상입니다. 이 APK에서 Android 파일 선택기로 다시 내보낸 백업도 위의 190바이트 원본과 완전히 같았습니다. 실제 설치 화면을 `docs/screenshots/`에 기록합니다.

[공개 APK 다운로드 링크](https://github.com/studyreadbook4ever/myChangGo/releases/download/jpstudy-v1.0.0/kanji-itda-v1.0.0.apk)에서 인증 없이 APK와 `SHA256SUMS`를 다시 내려받았습니다. 내려받은 파일·공개 체크섬·검증한 로컬 APK의 SHA-256이 모두 일치했습니다. 릴리스는 공개 상태이며 태그 `jpstudy-v1.0.0`의 소스는 `b746606`입니다. 저장소와 프로젝트 README 첫 줄의 APK 링크, Unlicense 파일도 GitHub에서 확인했습니다.

일본어 TTS 엔진의 연결·사용 가능 여부와 오류 처리는 검사했으며, 에뮬레이터에서 실제 발음의 음질을 청취 평가하지는 않았습니다.

별도 담당자가 전체 1,000개 어휘의 읽기·예문·한국어 뜻 및 300자 한자 풀이를 독립 검토하고 수정했습니다. 전문 사전·언어 교사의 검증을 대체하지는 않습니다.

이 환경에서 `flutter test --coverage`는 테스트 종료 후 Linux 테스트 프로세스 오류로 수집이 멈추어 사용하지 않습니다. 커버리지 비율은 보고하지 않으며 CI와 로컬 모두 `flutter test --concurrency=1`로 실제 종료 코드까지 확인합니다.
