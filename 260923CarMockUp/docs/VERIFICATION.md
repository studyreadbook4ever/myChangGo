# 검증 기록

검증일: 2026-09-23.

## 웹

- `npm run build`: TypeScript strict 검사 및 Vite 정적 빌드 통과.
- `npm test`: 7개 계산 테스트 통과. 출발 추천, 개인화 중앙값, 정체/우회 시간, 현재시각의 연속성, 정비 일정 충돌, 손상된 저장값 복구, 자정 경계.
- `npm run test:e2e`: Chromium 9개 테스트 통과. 일정 CRUD·새로고침, 시간/목적지/여유 변경에 따른 추천, 빈 시간 추천, 모바일 모달·뒤로 가기, 전체 시연과 일시정지, 도착 후 거리·기록, 저장값 복구, 일정이 없는 상태.
- 지도: 우회 지점 진행률 0.3에서 차량 위치 연속성, 목적지 도착, 저장 주차 위치 표시, 확대/복원 확인.
- 390px 모바일과 데스크톱 화면을 스크린샷으로 확인. 모바일 가로 넘침 없음.
- `npm audit --omit=dev --audit-level=high`: 취약점 0건.

자동 테스트는 가상 데이터와 시연 상태의 연결을 확인합니다. 실제 도로 안내의 정확성을 검증하는 테스트는 아닙니다.

## Android

Android SDK 35 / Java 21 / Gradle 8.10.2 환경에서 웹 에셋을 번들에 포함하고 `assembleDebug`, `lintDebug`를 통과했습니다.

API 35 에뮬레이터와 Android System WebView 124에서 확인한 항목:

- APK 설치와 앱 실행.
- 비행기 모드, Wi-Fi·모바일 데이터가 꺼진 상태에서 로컬 지도·화면·폰트 로드.
- 요청 주소가 번들 HTTPS 에셋 origin으로 제한됨.
- 자체 캘린더 일정 추가와 localStorage 저장.
- 안드로이드 뒤로 가기: 일정 편집 닫기 → 드라이브 화면 이동.
- 도착 후 주행거리·주차 위치·주행 기록 갱신.
- 강제 종료 후 재실행해도 저장된 데이터 유지.
- 세로 412×915 / 가로 915×412 화면 전환과 상태 유지, 가로 넘침 없음.
- JavaScript 런타임 오류 없음.

실물 휴대폰은 이 작업 환경에 연결되어 있지 않아 에뮬레이터에서 검증했습니다. Android 8 이상이라도 WebView는 업데이트된 버전을 사용해야 합니다. APK는 시연용 debug 서명이며 실제 지도·GPS·차량 센서·LLM API는 연결하지 않습니다.

## 배포 산출물

- `DriveMate-demo.apk`: 오프라인 실행 가능한 시연용 설치 파일.
- `DriveMate-demo.apk.sha256`: 배포 APK의 SHA-256 체크섬.
- `DriveMate-demo.mp4`: 약 1분, 1920×1080 H.264 무음 시연 영상.
- `docs/*.png`: 웹·캘린더·휴대폰·Android 화면 캡처.

바이너리는 [GitHub 릴리스](https://github.com/studyreadbook4ever/myChangGo/releases/tag/drivemate-v1.0.0)에서 받습니다. 빌드·녹화 스크립트는 저장소에 포함되어 있습니다.
