# Password Storage App

제가 쓰려고 만든 Android keystore 기반 비번 저장소입니다. 유튭깡계 굴리느라 잘 활용하고 있네요


이 앱에 외부와의 통신은 아예 안 들어가있고, 'Android Keystore'기반 per use biometric 알고리즘이 적용되어 비밀번호가 숨겨집니다. 지문으로 인증해도 5초만 보여주고 화면캡쳐 안 되는 구조임.

사실 나름 진지하게 2시간 이상 써서 만들었지만, '남이 만든 이런류 앱 쓰는거 자체가 거대한 social engineering 취약점'이기에 거대한 slop이라 할 수 있는 존재입니다. 로직부분 코드 한 줄 한 줄 검수했고요 이거그대로 사용하셔도 좋아용

## 바로 설치

APK 파일:

- `password-storage-debug.apk`

폰에서 GitHub의 `260704pw` 폴더를 연 뒤 `password-storage-debug.apk`를 누르고 다운로드하면 됩니다. Android가 "출처를 알 수 없는 앱" 설치 허용을 요구하면, 사용하는 브라우저 또는 파일 앱에 대해 이번 설치만 허용해 주세요.

직접 다운로드 링크:

https://github.com/studyreadbook4ever/myChangGo/raw/main/260704pw/password-storage-debug.apk

## 사용법

1. APK를 설치하고 `Password Storage` 앱을 실행합니다.
2. 최초 화면에서 `추가` 버튼을 눌러 엔터프라이즈 금고 이름을 만듭니다.
3. 이후 최초 화면에서 원하는 엔터프라이즈를 선택하면 지문 인증 창이 뜨고, 인증에 성공해야 해당 금고의 표로 들어갑니다.
4. 표는 `7 x 40` 구조입니다. 40개의 행마다 `Slot`, `ID`, `Password`, `Name`, `COMMENT`, `Last Checked Time`, `RESET` 7칸이 있습니다.
5. `Slot`은 고정 칸입니다.
6. `ID`는 처음 한 번 입력할 수 있고, 입력 후 포커스를 벗어나거나 완료 액션을 누르면 잠겨서 이후 수정할 수 없습니다.
7. `Password` 칸은 직접 수정할 수 없고, 비어 있을 때 누르면 새 비밀번호를 평문으로 입력한 뒤 생체인증을 거쳐 저장합니다.
8. 이미 저장된 `Password` 칸을 누르면 생체인증 창이 뜹니다. 지문 인증에 성공하면 비밀번호가 잠깐 평문으로 보이고, 약 15초 뒤 자동으로 다시 가려집니다.
9. `Name`, `COMMENT` 칸은 자연스럽게 수정할 수 있습니다.
10. `Last Checked Time`에는 해당 행의 비밀번호 생체인증이 성공한 시간이 기록됩니다.
11. `RESET` 아이콘을 누르면 해당 행의 ID 잠금, 비밀번호, Name, COMMENT, Last Checked Time을 초기화할 수 있습니다.
12. 왼쪽 상단의 뒤로가기 아이콘을 누르면 엔터프라이즈 선택 화면으로 돌아갑니다.

## 보안 동작

- `INTERNET` 권한이 없습니다.
- 엔터프라이즈 금고에 들어갈 때 생체인증을 요구합니다.
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
