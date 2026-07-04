# Password Storage App

가라 배포용 Android 디버그 APK와 소스 코드입니다. 네트워크 통신 없이 동작하는 오프라인 비밀번호 저장 앱입니다.

## 바로 설치

APK 파일:

- `password-storage-debug.apk`

폰에서 GitHub의 `260704pw` 폴더를 연 뒤 `password-storage-debug.apk`를 누르고 다운로드하면 됩니다. Android가 "출처를 알 수 없는 앱" 설치 허용을 요구하면, 사용하는 브라우저 또는 파일 앱에 대해 이번 설치만 허용해 주세요.

직접 다운로드 링크:

https://github.com/studyreadbook4ever/myChangGo/raw/main/260704pw/password-storage-debug.apk

## 사용법

1. APK를 설치하고 `Password Storage` 앱을 실행합니다.
2. 화면에는 `40 x 6` 표가 보입니다.
3. 1행은 `Slot 01`부터 `Slot 40`까지의 고정 칸입니다.
4. 2행은 비밀번호 칸입니다. 기본 상태에서는 마스킹되어 있습니다.
5. 비어 있는 비밀번호 칸을 누르면 새 비밀번호를 평문으로 입력한 뒤 생체인증을 거쳐 저장합니다.
6. 이미 저장된 비밀번호 칸을 누르면 생체인증 창이 뜹니다. 지문 인증에 성공하면 비밀번호가 잠깐 평문으로 보이고, 약 15초 뒤 자동으로 다시 가려집니다.
7. 3행, 4행, 5행은 자유롭게 수정 가능한 메모 칸입니다.
8. 6행의 초기화 아이콘을 누르면 해당 열의 비밀번호를 새로 저장하거나 완전히 삭제할 수 있습니다.

## 보안 동작

- `INTERNET` 권한이 없습니다.
- Android Keystore의 AES/GCM 키로 비밀번호를 암호화합니다.
- 비밀번호 보기와 저장은 생체인증을 통과한 `CryptoObject`로만 수행됩니다.
- 스크린샷과 최근 앱 미리보기를 차단합니다.
- 복사/붙여넣기 메뉴를 제한하고 앱이 백그라운드로 가면 클립보드를 비웁니다.
- 앱 데이터 백업/기기 이전 백업을 제외하도록 설정되어 있습니다.

## 주의

이 APK는 빠른 테스트용 디버그 빌드입니다. Play Store 배포용 서명 APK가 아니므로 실사용 배포 전에는 release signing, 버전 관리, 추가 테스트를 따로 진행해야 합니다.

## 소스에서 빌드

```bash
gradle --offline assembleDebug
```

빌드 결과:

```text
app/build/outputs/apk/debug/app-debug.apk
```
