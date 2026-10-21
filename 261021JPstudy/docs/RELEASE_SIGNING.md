# Android 릴리스 서명

릴리스 APK는 전용 키로 서명합니다. 개인 키와 비밀번호는 Git 저장소에 넣지 않습니다. 디버그 빌드는 Android 기본 디버그 키를 사용하며, 릴리스 빌드는 서명 설정이 없으면 실패합니다.

저장소 밖에 다음 내용의 `release.properties` 파일을 만들고 파일 권한을 제한하세요. 아래 값은 예시입니다.

```properties
storeFile=/absolute/private/path/jpstudy-release.jks
storePassword=YOUR_PRIVATE_PASSWORD
keyAlias=jpstudy
keyPassword=YOUR_PRIVATE_PASSWORD
```

빌드할 때 설정 파일 경로만 환경 변수로 넘깁니다.

```bash
export JPSTUDY_SIGNING_PROPERTIES=/absolute/private/path/release.properties
flutter build apk --release
python3 tool/verify_release_jni.py
```

최초 배포에 사용한 키는 이 작업 환경의 `~/.local/share/jpstudy/signing/`에 보관했습니다. 이 폴더를 비공개 위치에 백업하세요. 같은 앱 ID의 업데이트를 설치하려면 기존 릴리스와 동일한 키가 필요합니다. 이 키는 공개 APK나 저장소에서 복구할 수 없습니다.

공개 CI는 분석·테스트와 코드 축소가 적용된 릴리스 APK 빌드를 수행합니다. 매 실행 임시 키를 생성하므로 CI 아티팩트의 서명은 정식 배포 APK와 다릅니다. 정식 설치 파일은 README의 GitHub Release 링크에서 받습니다. 자동 정식 배포를 추가할 때는 암호화된 CI 비밀 저장소에서 기존 릴리스 키를 복원하고 빌드가 끝난 뒤 임시 파일을 지우세요.

`verify_release_jni.py`는 실제 R8 매핑과 APK의 DEX 정의를 함께 읽어 로컬 저장 플러그인의 Kotlin/JNI 클래스·멤버·비동기 메서드 서명이 유지되는지 검사합니다. [Pigeon 공식 가이드](https://flutter.googlesource.com/mirrors/packages/+/refs/heads/main/packages/pigeon/native_interop_guide.md)에 따라 `android/app/proguard-rules.pro`에서 필요한 런타임 코드를 보존합니다. 디버그 테스트만으로는 이 문제를 잡을 수 없습니다.

정식 배포 전에는 해당 APK를 Android에 직접 설치해 비행기 모드에서 단어장 로딩, 책갈피와 읽던 위치의 재시작 후 유지, 파일 백업·복원을 확인합니다. 서명·APK 정렬·SHA-256 검사 후 업로드하고, 공개 다운로드 파일의 해시까지 비교합니다.

## 버전을 올린 뒤 정식 APK 배포

`pubspec.yaml` 수정이나 CI 성공만으로 GitHub Release의 APK가 바뀌지는 않습니다. CI 아티팩트는 임시 키로 서명한 검증용 파일입니다. 정식 배포는 다음 순서로 마무리합니다.

1. `pubspec.yaml`의 버전·빌드 번호와 앱 라이선스 화면의 버전 표시를 함께 올립니다. 위젯 테스트가 두 버전의 일치를 검사합니다.
2. 분석·테스트를 통과한 소스를 기존 비공개 서명 키로 빌드하고 위의 JNI 검사를 실행합니다.
3. APK 안의 `versionName`·`versionCode`와 서명 인증서를 확인합니다. 기존 정식 APK 위에 `adb install -r`로 설치해 기록 보존을 확인합니다.
4. 새 `jpstudy-v<버전>` 릴리스에 `kanji-itda-v<버전>.apk`와 `SHA256SUMS`를 올립니다. 태그는 실제 빌드한 소스 커밋을 가리켜야 합니다. 이전 릴리스 파일은 그대로 둡니다.
5. **저장소 루트와 이 프로젝트의 README 첫 줄을 모두** 새 APK 링크로 바꾸고 검증 기록을 커밋·머지합니다.
6. 공개 링크에서 인증 없이 APK를 다시 받아 SHA-256을 비교합니다. 여러 프로젝트가 공유하는 저장소이므로 `/releases/latest` 대신 앱별 버전 태그를 사용합니다.

릴리스 키를 분실하면 기존 정식 설치본에 업데이트할 수 없습니다. 서명 연속성을 유지하려면 최초 배포 키의 비공개 백업을 보관하세요.
