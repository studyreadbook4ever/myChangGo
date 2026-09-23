# DriveMate Android demo shell

React/Vite 프론트엔드의 빌드 결과를 APK 내부에 넣는 작은 Java WebView 앱입니다. Android 8.0(API 26) 이상과 업데이트된 Android System WebView가 필요합니다. 실제 기기에 설치하는 시연용 debug APK이며 Play Store 배포용 서명은 포함하지 않습니다.

## 빌드

필요한 도구: Node.js 22.12 이상, JDK 17 또는 21, Android SDK Platform 35, Android SDK Build Tools 34.0.0. Gradle 8.10.2는 포함된 wrapper가 내려받습니다. 최초 빌드에는 npm/Maven/Gradle 의존성을 받을 인터넷 연결이 필요합니다.

```bash
# 260923CarMockUp 디렉터리에서
export ANDROID_HOME=/path/to/Android/Sdk
npm ci
npm run build:apk
```

출력은 `downloads/DriveMate-demo.apk`와 `downloads/DriveMate-demo.apk.sha256`입니다. 빌드 스크립트가 웹 빌드, 로컬 에셋 복사, `assembleDebug`, `lintDebug`를 순서대로 수행합니다. `android/app/src/main/assets/`는 자동 생성되며 Git에 포함하지 않습니다.

Android Studio에서 직접 빌드하려면 먼저 위 스크립트로 웹 에셋을 생성하고 이 `android` 폴더를 엽니다. 개발 환경에서 생성한 debug 서명키는 Git에 저장하지 않습니다. 다른 컴퓨터의 debug 키로 다시 빌드한 APK는 기존 설치본을 삭제해야 설치될 수 있으며, 삭제하면 저장한 목업 데이터도 초기화됩니다.

```bash
adb install -r downloads/DriveMate-demo.apk
adb shell am start -n dev.drivemate.demo/.MainActivity
```

## 동작

- 인터넷, GPS, 외부 캘린더 권한을 요청하지 않습니다. 앱 실행에는 네트워크가 필요하지 않습니다.
- [Android 공식 WebViewAssetLoader](https://developer.android.com/develop/ui/views/layout/webapps/load-local-content)를 사용해 번들 파일을 `https://appassets.androidplatform.net/index.html`에서 읽습니다. 외부 주소 요청은 차단합니다.
- localStorage는 같은 로컬 HTTPS origin에 저장되어 앱 재실행 후에도 유지됩니다.
- 상태바·내비게이션 바·키보드 영역을 피하고 가로/세로 화면 전환을 지원합니다.
- 앱이 화면에 열려 있는 동안 화면 꺼짐을 막아 자동 시연과 영상 촬영을 돕습니다.
- 안드로이드 뒤로 가기는 `window.driveMateBack()`이 `true`를 반환하면 웹 UI에 위임합니다. 그 외에는 웹 히스토리를 이동하거나 앱을 백그라운드로 보냅니다.
- debug APK에서는 Chrome DevTools로 WebView를 검사할 수 있습니다.

이 APK는 화면과 상호작용을 보여주는 발표용 목업입니다. 실제 차량 제어, 위치 수집, AI API, 길 안내 서비스를 연결하지 않습니다.
