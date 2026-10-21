# 개발·APK 빌드

검증에 사용한 버전은 Flutter 3.47.7 / Dart 3.13.5 / Java 21입니다.
Android SDK는 `flutter doctor -v`로 확인하세요. Android 플랫폼 폴더와 Gradle Wrapper는 저장소에 포함합니다.

```sh
flutter pub get --enforce-lockfile
flutter analyze
flutter test --concurrency=1
flutter build apk --debug
```

디버그 APK: `build/app/outputs/flutter-apk/app-debug.apk`.

실제 배포 APK는 [릴리스 서명 안내](RELEASE_SIGNING.md)의 전용 키 설정 후 빌드합니다.
개인 키·비밀번호·`local.properties`는 저장소에 올리지 않습니다.
기존 APK를 업데이트하려면 같은 서명 키와 더 높은 `pubspec.yaml`의 빌드 번호가 필요합니다.

```sh
flutter devices
flutter test integration_test/android_smoke_test.dart -d <ANDROID_DEVICE_ID>
```

통합 테스트는 **테스트 전용 앱 데이터**를 초기화하므로 개인 학습 기록이 없는 에뮬레이터 또는 테스트 기기를 사용하세요.
브라우저로 UI를 확인하려면 `flutter run -d chrome`을 사용합니다. 브라우저 기록은 해당 브라우저·출처의 로컬 저장소에 따로 저장됩니다.

## 데이터 수정

`tool/build_curriculum.py`가 작성 원본입니다. 단어의 ID는 표기·읽기를 바탕으로 안정적으로 생성합니다. 의미·예문 수정으로 기존 진도가 사라지지 않게 ID를 유지하세요. ID를 바꾸거나 단어를 제거하면 기존 백업 호환성을 별도로 고려해야 합니다.

```sh
python3 tool/build_curriculum.py
python3 tool/validate_curriculum.py
flutter test test/curriculum_test.dart
```

데이터에 대해 단순한 구조 검사가 언어적 정확성을 보장하지는 않습니다. 읽기·어의·자연스러운 예문·한국어 번역은 함께 검토하세요.
