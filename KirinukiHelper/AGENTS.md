# KirinukiHelper 운영·개발 계약

이 파일은 사용자와 자동화 에이전트가 KirinukiHelper를 안전하고 재현 가능하게 운용·수정하기 위한 지속 지침이다. 현재 제품의 자막 초벌 방식은 정확히 둘이다.

1. `whisper-tiny`: 이 기기의 whisper.cpp companion이 한국어 글과 실제 STT 타임스탬프를 만든다.
2. `audseg-local`: 브라우저 안의 AudSeg DSP가 오디오 활동 구간과 **비어 있는 편집용 cue**만 만든다.

둘 다 로컬 전용이다. 자막 API 키, 인터넷 자막 제공자, 원격 companion, 자동 네트워크 폴백을 제품에 추가하지 않는다.

## 가장 짧은 사용 절차

Whisper를 처음 쓸 때:

```bash
npm ci --ignore-scripts
npm run build
npm run caption-stack:doctor
npm run caption-stack:setup
npm run caption-stack:start
```

그 뒤 Chromium에서 `extension` 폴더를 불러오고:

1. 치지직 또는 YouTube 탭에서 사용 구간을 저장한다.
2. 통합 편집기를 연다.
3. 권한이 있는 로컬 원본을 연결한다.
4. **로컬 Whisper** 또는 **AudSeg**를 고른다.
5. **활성 컷 전체 초벌 만들기**를 누른다.
6. 모든 cue를 원음과 대조한다.
7. 임시저장 후 영상·프로젝트 JSON·SRT를 내보낸다.

AudSeg만 쓸 때는 caption stack 설치·실행이 필요 없다.

## 절대 불변조건

- 사용자가 저장한 컷 시작·끝과 순서는 `authority: USER`다.
- 자동 로직은 컷을 새로 고르거나 경계를 조용히 확장·축소·병합·삭제하지 않는다.
- 영상 중간 삭제는 명시적인 사용자 동작으로만 실행한다.
- 내부 삭제 뒤 영상에 결속된 자막·에셋·음성은 같은 시간축 변환을 적용한다.
- 원본 전체와 최종 렌더는 이 기기 밖으로 보내지 않는다.
- Whisper 오디오는 loopback companion에만 전달한다.
- AudSeg는 브라우저 안에서만 실행하며 네트워크를 호출하지 않는다.
- AudSeg는 STT가 아니다. 텍스트·화자·언어 판정을 만들어 내지 않는다.
- AudSeg 결과 cue의 텍스트는 실제로 비어 있고 모두 `reviewRequired`다.
- Whisper 결과도 초안이며 사람 검수 없이 게시 준비 완료로 표시하지 않는다.
- 사람이 직접 만든 cue와 사람이 고친 AI cue를 재실행으로 덮어쓰지 않는다.
- 자동 본문 위치는 아래 중앙 `x=0.5`, `y=0.84`다.
- 자막 한 cue는 최대 4초다.
- 문장 끝의 불필요한 `.`은 제거하고 `?`, `!`, `…`, `~`는 보존한다.
- 프로젝트 변경은 현재본에 원자적으로 저장하고 오래된 복구본을 자동 우선하지 않는다.
- 민감한 토큰을 프로젝트, IndexedDB, Chrome 저장소, CLI 인자, service unit, 로그에 기록하지 않는다.
- 게시·업로드·수익화·정책 승인을 자동으로 실행하지 않는다.
- 승인되지 않은 라이선스, 버전, 글꼴·원문 사본이 들어오면 `license:check`가 배포 전에 실패해야 한다.

## 자막 방식의 의미

### `whisper-tiny`

Whisper 흐름:

```text
활성 컷
→ 16kHz mono PCM/WAV
→ loopback caption companion
→ whisper.cpp multilingual timed transcript
→ segment 본문 + word 경계 anchor 정규화
→ 로컬 cue 초벌
→ kr-vtuber-clean-v1 품질 하네스
→ 편집기 검수 cue
```

계약:

- companion 주소는 `http://127.0.0.1` 또는 `http://localhost`만 허용한다.
- 기본 모델은 고정된 다국어 `tiny-q5_1` 프로필이다.
- 실제 word timestamp를 cue 경계와 긴 cue 분할의 우선 anchor로 사용한다.
- LLM식 글자 수 비례 시간 추정을 넣지 않는다.
- segment↔word coverage가 낮으면 시간을 꾸며 내지 않고 검수 사유를 남긴다.
- companion capability의 provider와 transcription mode는 모두 `local-whispercpp`여야 한다.
- 로컬 실패를 인터넷 서비스로 자동 전환하지 않는다.

### `audseg-local`

AudSeg 흐름:

```text
활성 컷
→ 16kHz mono Float32 PCM
→ 브라우저 AudSeg DSP
→ 오디오 활동 구간
→ 최대 4초 timing cue
→ 빈 텍스트 + reviewRequired
→ 편집기에서 사람 전사
```

AudSeg는 저장소 루트의 독립 Python 패키지 `AudSeg/` 0.1.0 철학과 알고리즘을 브라우저 JavaScript로 충실히 옮긴 것이다.

- 기준 구현: `AudSeg/src/audseg/`
- 브라우저 구현: `src/editor/audseg.js`
- 라이선스: MIT
- 런타임: 브라우저 JavaScript, Python·companion 불필요
- 입력: 16kHz mono PCM
- 분석: 20ms RMS frame, 10ms hop
- threshold: adaptive noise floor
- 상태 전환: Schmitt hysteresis
- 후처리: debounce, padding, merge
- 긴 구간: quiet valley 우선 분할, hard limit 폴백
- KirinukiHelper cue 상한: 4,000ms

음악, 효과음, 박수, 키보드 소리도 활동으로 감지될 수 있다. 이것은 오작동이 아니라 활동 검출기의 한계다. 에이전트나 UI는 AudSeg 결과를 전사, 발화 확정, 화자 분리, 언어 판정으로 표현하면 안 된다.

Python 기준 구현의 기본 placeholder 정책과 별개로 편집기 모델은 빈 텍스트를 보존할 수 있으므로 실제 cue 본문을 비워 둔다. 타임라인은 빈 cue임을 시각적으로 표시하되 그 표시 문구를 프로젝트 자막 텍스트로 저장하거나 SRT로 내보내지 않는다.

## 설치와 프로필

요구 환경:

- Node.js 20.9 이상
- Chrome/Chromium 120 이상
- Linux에서 Whisper를 쓸 경우 C/C++ build toolchain
- 실제 브라우저 통합 검증에는 Chromium과 ChromeDriver
- 미디어 통합 검증에는 FFmpeg와 ffprobe

Whisper 설치:

```bash
npm run caption-stack:doctor
npm run caption-stack:setup
npm run caption-stack:start
npm run caption-stack:status
```

`setup`은 고정 revision, 크기와 SHA-256을 검증한 whisper.cpp, 선택 모델, VAD를 XDG 사용자 데이터 경로에 설치한다. 저장소와 Extension package 안에 binary나 모델을 넣지 않는다.

`extension` 폴더의 절대 경로가 바뀌면 압축해제 확장의 ID와 companion이 허용하는 exact Origin도 바뀐다. 경로를 옮긴 뒤에는 새 폴더를 Chromium에 다시 불러오고, 기존 설치 프로필과 backend를 유지한 채 `caption-stack:setup`을 다시 실행한다. 경로가 다른 임시 ZIP smoke에서 기존 Origin용 companion이 `/v1/session`을 403으로 거절하는 것은 보안 계약상 정상이며, 일반 실행의 다른 브라우저 오류를 허용하는 근거로 쓰지 않는다.

프로필:

- `draft`: 기본 `tiny-q5_1`, 저사양·빠른 초벌
- `light`: `base-q5_1`
- `quality`: 더 무거운 모델

기본 동작과 문서는 `draft`를 기준으로 한다. 사용자가 명시적으로 설치한 더 무거운 프로필을 `start`가 조용히 바꾸지 않는다.

종료:

```bash
npm run caption-stack:stop
```

AudSeg에는 위 명령이 필요 없다. 모델 설치 안내나 companion 오류를 AudSeg 모드에 표시하면 회귀다.

## 매 작업 운영 절차

### 1. 소스에서 컷 저장

- 시작과 끝을 사람이 직접 찍는다.
- 메모는 선택 사항이다.
- 페이지 시각과 로컬 파일 시각이 다르면 오프셋을 기록한다.
- 여러 방송 회차를 한 프로젝트에 섞지 않는다.

### 2. 편집기 CURRENT 열기

닫은 세션을 이어 갈 때 사이드패널의 **이 기기의 최근 편집 → 계속 편집**을 사용한다. 이 경로는 정확한 `projectId`의 현재본을 연다.

- 같은 프로젝트 편집기 탭이 이미 열려 있으면 그 탭을 앞으로 가져온다.
- 새 소스 탭 좌표를 기존 프로젝트에 자동 합치지 않는다.
- 복구본을 불러오기 전 현재본을 `복원 직전`으로 저장한다.
- 오류가 났다는 이유로 가장 오래된 백업을 강제 복원하지 않는다.

### 3. 로컬 원본 연결

- 권한 있는 같은 원본을 선택한다.
- 파일 identity는 이름, 크기, 수정 시각, 길이, 시작 시각, 해상도, 코덱을 포함한다.
- identity가 바뀌면 낡은 자막 체크포인트를 폐기한다.
- 파일 권한만 만료됐으면 프로젝트를 초기화하지 않고 같은 파일을 다시 고른다.

### 4. 초벌 방식 선택

글 초안이 필요하면 Whisper, 타이밍 틀만 필요하면 AudSeg를 고른다.

실행 전:

- 활성 컷 수가 1~16개인지 확인한다.
- 총 길이와 선택 방식을 표시한다.
- Whisper라면 companion capability와 실제 모델 지문을 확인한다.
- AudSeg라면 companion probe, 권한 요청, session 발급을 수행하지 않는다.
- 사용자가 취소하면 오디오 추출을 시작하지 않는다.

### 5. 사람 검수

Whisper:

- 고유명사
- 빠른 말과 짧은 감탄사
- 겹친 화자
- 잡음과 음악
- STT coverage 경고
- cue 시작·끝
- 화자 색

AudSeg:

- 모든 빈 cue의 실제 발화 여부
- 음악·효과음 오검출
- 누락된 조용한 발화
- cue 시작·끝
- 직접 입력한 전체 텍스트
- 화자와 색

공통:

- 같은 시각에 여러 자막이 필요하면 별도 레인을 사용한다.
- 타임라인 자막 블록의 양끝 손잡이와 숫자 입력을 모두 지원한다.
- 자막 레인은 기본 2개이고 사용자가 늘릴 수 있다.
- 색상 레지스터는 고정 흰색과 최근 비흰색 5개다.
- 자막↔에셋 자석과 정확히 맞춤은 사용자의 명시 동작이다.
- 사람이 고친 cue는 `humanEdited` 보호를 유지한다.

### 6. 저장과 내보내기

- 큰 변경 전 **지금 임시저장**
- 5분마다 자동 임시저장
- 프로젝트별 최근 5개
- 복구 직전 현재본 자동 저장
- 영상과 함께 프로젝트 JSON·SRT 보관

빈 AudSeg cue는 타임라인과 프로젝트에는 보존할 수 있지만 SRT에 가짜 문구로 출력하면 안 된다. 내보내기 전에 모든 빈 cue가 의도적인지 검수한다.

## 체크포인트와 재개

체크포인트 키에는 최소한 다음이 들어간다.

- clip ID
- 원본 시작·끝 밀리초
- 자막 방식 (`whisper-tiny` 또는 `audseg-local`)
- pipeline fingerprint
- 품질 프로필과 하네스 fingerprint
- 필요한 경우 편집 문맥 fingerprint
- 완료 request ID와 시각

Whisper pipeline fingerprint에는 companion이 보고한 실제 모델과 실행 방식이 포함된다.

AudSeg pipeline fingerprint에는 다음이 포함된다.

- `local-audseg`
- `audseg-0.1.0-dsp`
- `browser-audio-activity`
- 알고리즘 또는 기본 config가 바뀌면 달라지는 안정적 지문

동일 범위·방식·지문의 완료 컷만 재개 시 건너뛴다. 새 전체 실행, 다른 원본, 범위 변경, 방식 변경, 구현 지문 변경은 낡은 체크포인트를 재사용하지 않는다.

## 자막 스타일과 품질 계약

자동 본문 기본값:

- Pretendard ExtraBold
- 배경 없음
- 한 줄
- 아래 중앙 `x=0.5`, `y=0.84`
- 한국어 폭 20 단위 hard limit
- 최대 4,000ms
- 가능한 최소 650ms
- 목표 읽기 속도 초당 16폭 단위
- 끝 `.` 제거
- `?`, `!`, `…`, `~` 유지
- 기본 화자 흰색
- 다른 speaker ID는 결정적인 고유 색

구조 위반 결과는 일반 완료본으로 저장하지 않는다. 내용 불확실성은 cue별 `qualityCodes`와 `reviewRequired`로 보존한다.

AudSeg cue에는 읽기 속도 검사를 적용할 텍스트가 없다. 빈 본문을 품질 하네스가 삭제하거나 임의 문구로 대체하지 않게 별도 경로를 유지한다. 대신 시간 범위, 4초 상한, 정렬, 겹침, clip 경계만 검사한다.

## 데이터·보안 경계

```text
Whisper
Chrome editor
  └─ 활성 컷 16kHz mono WAV
       └─ http://127.0.0.1:4319/v1/captions
            ├─ exact chrome-extension Origin
            ├─ process-memory bearer session
            └─ private loopback whisper-server route

AudSeg
Chrome editor
  └─ 활성 컷 16kHz mono PCM
       └─ 같은 브라우저 탭의 DSP
```

보안 규칙:

- manifest에 범용 `https://*/*` 선택 권한을 두지 않는다.
- caption endpoint 정규화는 loopback HTTP만 허용한다.
- URL 사용자정보, 쿼리, fragment를 거부한다.
- session token은 현재 탭과 companion 메모리에만 둔다.
- `POST /v1/session`은 exact Extension Origin과 프로토콜 헤더를 요구한다.
- companion 재시작 시 session을 폐기한다.
- health probe가 session을 발급하거나 rate limit을 소비하지 않게 한다.
- 모델 다운로드는 `.part-*`로 받은 뒤 크기와 SHA-256을 확인하고 원자적으로 바꾼다.
- runtime child에 환경의 secret·credential 변수를 전달하지 않는다.
- loopback 통신은 proxy를 우회한다.

## 라이선스

AudSeg 기준 구현은 MIT 라이선스다.

- 루트 원문: `AudSeg/LICENSE`
- Extension 배포 사본: `extension/licenses/AUDSEG-MIT.txt`
- 고지: `extension/THIRD_PARTY_NOTICES.md`
- 배포용 고지 사본: `legal/THIRD_PARTY_NOTICES.md`

알고리즘을 포팅하거나 수정해도 저작권 고지와 MIT 전문을 제거하지 않는다.

그 밖의 주요 고지:

- Mediabunny: MPL-2.0
- Pretendard: SIL OFL 1.1
- Paperlogy: SIL OFL 1.1
- whisper.cpp와 변환 모델·VAD: 각 고지문 참조

## 파일 지도

- `src/editor/audseg.js`: 브라우저 AudSeg DSP와 timing cue 변환
- `src/editor/caption-agent.js`: 두 방식 설정, Whisper session/client, 체크포인트
- `src/editor/main.js`: 방식별 실행 분기, 컷별 저장·재개
- `src/caption-agent/protocol.js`: Whisper companion 요청·응답 계약
- `src/caption-agent/caption-quality-harness.js`: Whisper 초벌 품질 계약
- `src/caption-agent/editorial-context.js`: bounded 편집 문맥과 지문
- `scripts/local-caption-stack.mjs`: setup/start/status/stop
- `scripts/local-caption-stack-core.mjs`: artifact·프로필·service 생성
- `extension/editor.html`: 두 방식 선택과 정직한 설명
- `extension/lib/editor-core.js`: 프로젝트·cue 모델
- `extension/lib/session-recovery.js`: CURRENT와 최근 복구본
- `extension/THIRD_PARTY_NOTICES.md`: Extension 고지
- `tests/audseg.test.js`: DSP 결정성·경계·4초 상한
- `tests/caption-agent-client.test.js`: loopback client·session·재개
- `tests/local-caption-stack.test.js`: 설치·runtime·보안

파일명이 바뀌면 이 지도를 같은 변경에서 갱신한다.

## 수정 에이전트 작업 순서

1. 이 파일을 끝까지 읽는다.
2. `git status --short`로 사용자 변경과 다른 에이전트 변경을 확인한다.
3. 관련 소스·테스트·문서를 함께 찾는다.
4. 사용자 세션의 현재 프로젝트를 덮어쓰지 않는다.
5. 비밀 값을 읽거나 출력하지 않는다.
6. Extension ID를 바꾸는 manifest key를 임의로 추가하지 않는다.
7. 모델 다운로드를 `npm install`, `build`, 기본 CI에 넣지 않는다.
8. Whisper private route를 고정 공개 path로 바꾸지 않는다.
9. AudSeg를 전사기로 표현하거나 텍스트를 꾸며 내지 않는다.
10. 루트 Python 구현과 브라우저 포트의 핵심 config·golden fixture parity를 유지한다.
11. 사람이 수정한 cue와 시간축 불변조건을 지킨다.
12. 문서와 UI copy를 실제 코드 상태와 맞춘다.
13. 변경 범위에 맞는 테스트 뒤 전체 검증을 실행한다.

기본:

```bash
npm run check
git diff --check
```

`npm run check`에는 fail-closed third-party 라이선스 인벤토리 검사가 포함된다. 현재 허용 목록은 runtime `mediabunny@1.51.0`(MPL-2.0), build-only `esbuild@0.25.6`(MIT)와 그 고정 transitive type/platform 패키지, AudSeg(MIT), 두 OFL-1.1 글꼴이다. 새 패키지·버전·라이선스·바이너리 에셋을 추가하려면 원문과 배포 의무를 먼저 검토하고 고지·allowlist·검사를 같은 변경에서 명시적으로 갱신한다.

Chromium·ChromeDriver·FFmpeg가 있으면:

```bash
npm run check:full
```

caption stack 변경 시:

```bash
node --test tests/local-caption-stack.test.js
npm run caption-stack:doctor -- --json
npm run caption-stack:setup -- --dry-run
```

AudSeg 변경 시:

```bash
node --test tests/audseg.test.js
uv run --project ../AudSeg --extra dev pytest -q ../AudSeg/tests
uv run --project ../AudSeg --extra dev ruff check ../AudSeg
uv run --project ../AudSeg --extra dev ruff format --check ../AudSeg
```

실제 setup 통합은 native build와 모델 다운로드가 필요하므로 기본 CI에 넣지 않는다. 실행했다면 profile, backend, whisper revision, model SHA와 fixture 결과를 기록한다.

## 릴리스 합격 기준

- [ ] UI 선택지가 `whisper-tiny`, `audseg-local` 두 개뿐임
- [ ] 저장된 과거 설정의 지원하지 않는 모델·주소·자격증명을 폐기함
- [ ] manifest에 범용 원격 호스트 권한이 없음
- [ ] 자막 API 키 입력 UI와 요청 헤더가 없음
- [ ] Whisper endpoint가 loopback HTTP만 허용됨
- [ ] Whisper가 exact Origin·process-memory session을 검증함
- [ ] AudSeg가 companion, Python, 모델, 네트워크 없이 브라우저에서 실행됨
- [ ] AudSeg 결과가 실제 빈 텍스트이고 모두 검수 대상임
- [ ] AudSeg cue가 clip 범위 안이고 최대 4초임
- [ ] 음악·효과음 감지 가능성이 UI와 문서에 명시됨
- [ ] Python 기준 구현과 JavaScript 포트의 핵심 fixture가 일치함
- [ ] 자동 자막 기본 위치와 문장부호 계약이 결정적임
- [ ] 사람 cue와 human-edited cue가 재실행 후 보존됨
- [ ] 활성 컷 0/16/17 경계가 오디오 추출 전에 동작함
- [ ] 컷별 저장과 동일 지문 재개가 동작함
- [ ] 다른 원본·방식·pipeline은 낡은 체크포인트를 재사용하지 않음
- [ ] 빈 cue가 가짜 SRT 문구로 출력되지 않음
- [ ] 모델·binary·partial download·secret이 Extension package에 없음
- [ ] AudSeg MIT 전문과 third-party 고지가 배포물에 포함됨
- [ ] `npm run license:check`가 승인된 정확한 버전·라이선스·고지·대응 소스만 확인함
- [ ] `npm run check`와 `git diff --check`가 통과함
