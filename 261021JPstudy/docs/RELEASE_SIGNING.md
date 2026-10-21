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
