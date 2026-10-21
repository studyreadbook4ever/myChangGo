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
```

최초 배포에 사용한 키는 이 작업 환경의 `~/.local/share/jpstudy/signing/`에 보관했습니다. 이 폴더를 비공개 위치에 백업하세요. 같은 앱 ID의 업데이트를 설치하려면 기존 릴리스와 동일한 키가 필요합니다. 이 키는 공개 APK나 저장소에서 복구할 수 없습니다.

공개 CI는 분석·테스트·디버그 APK 빌드만 수행합니다. 별도로 릴리스 자동화를 추가할 때는 암호화된 CI 비밀 저장소에서 키를 복원하고 빌드가 끝난 뒤 임시 파일을 지우세요.
