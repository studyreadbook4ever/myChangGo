# Kirinuki Studio 운영·개발 계약

이 문서는 두 사람이 함께 읽는 문서입니다.

- 일반 사용자는 아래의 **처음 한 번**, **매번 작업할 때**, **문제가 생겼을 때**만 따르면 됩니다.
- 이 저장소를 수정하는 사람이나 에이전트는 **불변조건**, **보안**, **비용**, **검증 계약**까지 따라야 합니다.

상태 표시는 다음 뜻입니다.

- `CURRENT`: 이 저장소에서 지금 구현되어 있고 테스트하는 동작
- `ADVANCED`: 기본 사용자는 건드리지 않아도 되는 호환 경로
- `TARGET`: 후속 버전의 방향이며 현재 동작처럼 안내하면 안 되는 항목

## 가장 짧은 결론

`CURRENT` Linux 기본 경로에서는 최초 한 번 로컬 자막 스택을 설치한 뒤, 평소에는 다음만 하면 됩니다.

```bash
npm run caption-stack:start
```

그다음 편집기의 기본값인 **Whisper Tiny 로컬 초벌**을 그대로 두고 **활성 컷 전체 자막 초안 만들기**를 누릅니다. Upstage API 키, 로컬 Whisper 주소, STT 키와 세션 토큰을 입력하지 않습니다. `caption-stack:setup`의 기본 `draft` 프로필이 설치한 다국어 `tiny-q5_1` 모델을 사용하며, 이 기본 실행의 Upstage 키·전송·호출·비용은 모두 0입니다.

```text
활성 컷의 16kHz WAV
  → 이 기기의 whisper.cpp Tiny(draft tiny-q5_1)
  → segment 본문 + word timestamp 경계 anchor의 canonical timed units
  → STT 타임스탬프 경계를 우선하는 로컬 cue 초벌
  → 외부 호출 0회의 로컬 kr-vtuber-clean-v1 품질 하네스
  → 한 줄·아래 중앙 고정 편집기 자막 cue
```

`ADVANCED` Solar Mini/Pro 3는 사용자가 **자막 초벌 방식**에서 직접 고르는 고급 옵션입니다. 이때만 현재 탭의 Upstage 키와 네트워크가 필요하고, bounded timed text 문맥만 Upstage에 보내며 컷당 최대 1회의 유료 호출을 합니다. Solar 결과도 로컬 STT 타임스탬프 경계와 로컬 하네스가 최종 시각·구조를 결정합니다.

## 절대 불변조건

코드·문서·자동화는 다음 규칙을 깨면 안 됩니다.

1. 사용자가 찍은 컷 시작·끝은 사용자 권한 범위입니다. AI가 재미 판단으로 범위를 늘리거나 줄이지 않습니다.
2. 로컬 STT에는 활성 컷의 오디오만 전달합니다. 원본 전체와 비활성 구간을 몰래 전사하지 않습니다.
3. 사용자가 Solar 고급 옵션을 명시적으로 선택해도 Upstage에는 오디오, WAV base64, 영상, 프레임 픽셀, 이미지 에셋을 보내지 않습니다. 기본 Whisper Tiny 실행은 Upstage에 아무것도 보내지 않습니다.
4. Solar 고급 옵션의 Upstage 입력은 timed transcript, 프로젝트명, 스트리머명, 컷 메모, 숫자형 화면 위치 요약과 최대 24KiB의 bounded 편집 문맥으로 제한합니다. 편집 문맥은 최대 48개 용어, 16명 화자·별칭, 사람이 검수한 예문 8개와 고정 스타일 계약만 포함하며 원본 자막 전체를 넣지 않습니다.
5. 기본 Whisper Tiny 로컬 초벌은 STT·Upstage API 키와 외부 네트워크를 요구하지 않으며 Upstage 호출과 비용이 0입니다.
6. 로컬 STT 실패를 외부 유료 STT로 자동 폴백하지 않습니다.
7. gateway와 whisper-server는 `127.0.0.1`에만 바인딩합니다. `0.0.0.0`은 금지합니다. whisper-server의 무인증 `/inference`·`/load`를 고정 경로에 노출하지 않고 매 기동 새 192-bit 비공개 `--request-path` 아래에 둡니다.
8. Upstage 키와 process session token은 프로젝트, 임시저장, IndexedDB, `chrome.storage`, 설정 파일, systemd unit, argv, 로그에 저장하지 않습니다. 저장되는 endpoint에는 쿼리 문자열·인증정보를 허용하지 않습니다.
9. 사람이 만든 자막과 사람이 수정한 AI 자막은 AI 재실행으로 덮어쓰지 않습니다.
10. `kr-vtuber-clean-v1` 자동 본문 cue는 한 줄·아래 중앙 고정(`x=0.5`, `y=0.84`, `placement=bottom`), 최대 4초이고 650ms 이상을 목표로 합니다. Solar·외부 에이전트가 다른 위치를 반환하거나 여러 AI cue가 동시에 표시돼도 자동 본문 위치를 위로 쌓지 않습니다. 한국어 폭은 한 줄 20 단위를 상한으로 사용하며 읽기 속도는 초당 16 단위 이하를 목표로 합니다. 문장 끝 `.`은 제거하고 `?`, `!`, `…`, `~`는 유지합니다.
11. 사용자가 Solar Mini/Pro 3를 명시적으로 선택했을 때만 유료 호출하며 상한은 컷당 정확히 1회입니다. 응답 형식·빈 결과를 고치기 위한 자동 유료 폴백이나 재호출을 추가하지 않습니다. 기본 Whisper Tiny와 그 뒤 정규화·분할·시간 보정·품질 평가는 외부 호출이 없는 로컬 하네스에서 합니다.
12. 컷 하나가 끝날 때마다 결과와 체크포인트를 저장합니다. 실패 재개 시 같은 범위·같은 선택 자막 방식(`whisper-tiny` 또는 Solar 모델)·같은 실제 STT 모델 및 실행 방식·같은 하네스 지문·같은 신뢰 편집 문맥 지문의 완료 컷만 건너뜁니다. 지문이 없거나 달라진 체크포인트는 재사용하지 않습니다.
13. 기본 화자는 흰색, 다른 화자는 speaker ID에 따라 결정적인 고유 색을 사용합니다. `main`과 스트리머명의 한글·결정적 로마자 별칭은 프로젝트 화자 registry에서 하나로 합칩니다. 사람이 만든 자막, 사람이 수정한 AI 자막과 수동 강조 레인은 AI 재실행으로 덮어쓰지 않습니다.
14. 로컬 모델과 실행 파일은 Extension 패키지와 Git에 넣지 않습니다.
15. 실제 가격 숫자를 코드에 고정하지 않습니다. 기본 Whisper Tiny 실행은 Upstage 요청 0회·비용 0으로 표시합니다. Solar 고급 옵션을 선택했을 때만 실행 전 최대 요청 수를 보여 주고 최신 가격은 [Upstage 공식 가격표](https://www.upstage.ai/pricing/api)를 확인하게 합니다.

## 지원 범위

`CURRENT`

- Chrome/Chromium 120 이상
- Node.js 20.9 이상
- 치지직 LIVE·VOD와 YouTube VOD 타임스탬프
- 권한이 있는 로컬 원본 파일 편집
- Linux의 자동 로컬 Whisper 설치·실행과 기본 `Whisper Tiny` 로컬 초벌
- CPU 기본, NVIDIA + CUDA compiler가 모두 준비된 Linux에서 CUDA build
- 사용자가 명시적으로 선택하는 `ADVANCED` Solar Mini와 Solar Pro 3
- Solar를 명시 선택했을 때만 쓰는 외부 timed STT 고급 호환 경로

`TARGET`

- 서명된 사전 빌드 companion
- macOS·Windows 자동 설치
- GPU health 실패 시 같은 실행 안에서 CPU binary로 자동 재빌드·폴백

TARGET을 CURRENT처럼 README나 UI에 쓰지 않습니다.

## 처음 한 번

저장소의 `260711vtuber` 폴더에서 실행합니다.

```bash
npm ci --ignore-scripts
npm run build
npm run caption-stack:doctor
npm run caption-stack:setup
npm run caption-stack:start
```

각 명령의 의미:

- `npm ci --ignore-scripts`: 고정된 JavaScript 의존성만 설치합니다. Whisper 모델은 여기서 받지 않습니다.
- `npm run build`: Extension 번들을 만듭니다.
- `npm run caption-stack:doctor`: Node, RAM, CPU, NVIDIA/CUDA, 빌드 도구, 포트, 기존 설치를 읽기 전용 점검합니다. `setup 후보`와 `실제 설치` 프로필·모델을 분리해 표시하며 유료 API를 호출하지 않습니다.
- `npm run caption-stack:setup`: 고정 commit의 whisper.cpp와 고정 revision의 다국어 모델·VAD를 내려받아 크기와 SHA-256을 검증하고 사용자 데이터 폴더에서 빌드합니다.
- `npm run caption-stack:start`: systemd-user가 있으면 백그라운드 서비스로, 없으면 foreground로 두 로컬 프로세스를 시작합니다.

설치 전에 정확한 계획만 보고 싶다면 파일을 바꾸지 않는 dry run을 사용합니다.

```bash
npm run caption-stack:setup -- --dry-run
```

Chrome에서는 다음을 한 번 합니다.

1. `chrome://extensions`를 엽니다.
2. 개발자 모드를 켭니다.
3. **압축해제된 확장 프로그램을 로드합니다**를 누릅니다.
4. 이 저장소의 `extension` 폴더를 고릅니다.

로컬 스택은 이 절대 경로에서 결정되는 Extension ID를 exact Origin으로 고정합니다. Extension 폴더를 다른 경로로 옮겼다면 `caption-stack:setup`을 다시 실행해야 합니다.

이미 로컬 스택이 실행 중일 때 setup을 다시 실행하면, 검증과 빌드가 모두 성공한 뒤에만 systemd 서비스를 자동 재시작해 새 모델·backend·Origin을 원자적으로 적용합니다.

## 저사양·품질 프로필

프로필 이름은 하드웨어 용어보다 작업 의도를 나타냅니다.

| 프로필 | 모델 | 사용 시점 |
|---|---|---|
| `draft` | `tiny-q5_1` | **기본값**. 가장 빠른 로컬 자막 초벌 |
| `auto` | 보통 `small-q5_1`; RAM 6GiB 미만은 자동 `light` | 더 무거운 모델을 하드웨어에 맞춰 자동 선택할 때 |
| `light` | `base-q5_1` | Tiny보다 정확도를 조금 더 우선하는 CPU 작업 |
| `quality` | `medium-q5_0` | 로컬 STT 정확도를 더 우선할 때 |

```bash
npm run caption-stack:setup -- --profile draft
npm run caption-stack:setup -- --profile light
npm run caption-stack:setup -- --profile quality
```

옵션 없이 setup하면 `draft`의 다국어 `tiny-q5_1`을 설치합니다. 한국어 작업이므로 `.en` 모델을 사용하지 않습니다. 기본은 CPU이며, Linux에서 `nvidia-smi`와 `nvcc`를 모두 확인한 경우에만 `auto` backend가 CUDA를 선택합니다.

backend를 명시적으로 고정할 수도 있습니다.

```bash
npm run caption-stack:setup -- --backend cpu
npm run caption-stack:setup -- --backend cuda
```

`--backend cuda`는 NVIDIA GPU 또는 CUDA compiler가 없으면 조용히 CPU로 바꾸지 않고 설치 전에 중단합니다. 문제를 확인한 뒤 `--backend cpu`로 다시 실행합니다.

## 자막 스타일·글꼴 고정

`CURRENT` 새 프로젝트 기본값은 `kr-vtuber-clean-v1`입니다. 사용자의 사람 검수 완성본 2개에서 190개 표본 프레임을 측정한 값을 그대로 사용합니다.

- `Pretendard ExtraBold` 800
- 화면 높이 기준 `fontScale: 0.0675`
- 배경 없음, 흰색 본문, `#111111` 검정 외곽선
- 중앙 정렬, `x=0.5`, 하단 `y=0.84`
- 자동 본문은 한 줄

`kr-vtuber-paperlogy-v1`은 사용자가 명시적으로 고르는 OFL 대안입니다. `Paperlogy ExtraBold` 800, 화면 높이 기준 `fontScale: 0.061`, 한 줄·하단 고정을 사용하며 측정된 기본 Pretendard를 조용히 대체하지 않습니다.

두 글꼴은 SIL Open Font License 1.1 원문과 함께 배포합니다.

- Pretendard: 공식 tag `v1.3.9`, WOFF2 SHA-256 `dd7c1e156f508eb962acc7a33a7a1896d1e0b71e11156fad96e731689ceb6dc3`, license SHA-256 `d31ddd9f2bed32fd7e302a205cf2380ba0de6529152d239ef99cfb6f261bfc04`
- Paperlogy: 공식 commit `8ef35f53b318c7ca914c52b1b382b9a8bad07a61`, WOFF2 SHA-256 `5047db061c39ec5ed5c9d0b71c7aaad4b9547ed15ce48d1cd74090169f132bc0`, upstream license SHA-256 `603b2e7ef9effb9037b0b67f0530cacdc05e71a4e569032d7e4d98c2e6763135`, bundled license SHA-256 `a5a9b6832b5d91b5389e258b82f788791493fb786979eb80b5e142b5664ba22a`

source URL, copyright와 전체 준수 문구는 [Third-party notices](legal/THIRD_PARTY_NOTICES.md)가 기준입니다. 글꼴 파일·라이선스·고지 중 하나만 빼서 패키징하지 않고, 다른 버전으로 갱신할 때 파일과 라이선스의 pinned source·SHA·패키지 allowlist를 함께 갱신합니다.

## 매번 작업할 때

### 1. 로컬 자막 스택 시작

```bash
npm run caption-stack:start
npm run caption-stack:status
```

정상 상태:

```text
설정: 있음
서비스: active
127.0.0.1 포트: STT=ready · gateway=ready
API 키 파일 저장: 없음
```

systemd-user가 없는 환경:

```bash
npm run caption-stack:start -- --foreground
```

이 경우 터미널을 열어 두고 작업이 끝나면 `Ctrl+C`로 닫습니다.

### 2. 소스에서 컷 찍기

1. 치지직 또는 YouTube 영상 페이지를 엽니다.
2. Extension 사이드패널을 엽니다.
3. 사건 시작에서 **시작 스탬프 → 지금**을 누릅니다.
4. 반응·결론이 끝난 곳에서 **끝 스탬프 → 지금**을 누릅니다.
5. 필요한 메모를 쓰고 **구간 저장**을 누릅니다.
6. 필요한 만큼 반복하고 **통합 편집기에서 열기**를 누릅니다.

### 닫은 편집 세션 이어서 열기 (`CURRENT`)

원본 영상 탭을 닫았거나 다른 페이지를 보고 있어도 저장된 편집은 다시 열 수 있습니다.

1. 같은 Chrome/Chromium 프로필에서 Extension 사이드패널을 엽니다.
2. 상단 **이 기기의 최근 편집**에서 프로젝트 제목, 최근 저장 시각과 `컷 · 자막 · 에셋 · 음성` 수를 확인합니다.
3. IndexedDB의 마지막 현재본은 **계속 편집**으로 엽니다.
4. 프로젝트별 최근 5개 임시저장을 고르려면 **복구본 선택**을 누릅니다. 편집기가 정확한 `projectId`의 저장 목록을 자동으로 엽니다.
5. 저장본을 실제로 불러올 때는 기존 계약대로 불러오기 직전 현재본을 먼저 `pre-restore` 임시저장합니다.

저장 세션 재개 URL은 `session=resume`으로 신규 source seed 전달과 분리합니다. 현재 사이드패널의 capture state나 활성 탭 source identity를 저장 프로젝트에 병합하지 않습니다. 같은 `projectId`의 편집기 탭이 이미 있으면 새 탭을 만들지 않고 기존 탭을 포커스하며, **복구본 선택**은 그 탭의 저장 목록만 엽니다.

목록 응답은 제목·시각·개수·임시저장 사유만 허용하는 projection입니다. 프로젝트 본문, 자막 텍스트, 파일 핸들, 이미지 Blob, Upstage API 키, companion session token을 사이드패널 목록으로 전달하지 않습니다. API 키와 session token은 닫힌 탭에서 복구되지 않습니다.

### 3. 로컬 원본 연결

1. **원본 연결**에서 본인이 소유하거나 편집 권한이 있는 파일을 선택합니다.
2. 첫 컷의 화면·음성이 페이지 시각과 맞는지 봅니다.
3. 다르면 **페이지 시각 ↔ 로컬 원본 정렬** 오프셋부터 맞춥니다.
4. 컷 경계와 순서를 확인합니다.

원본 다운로드는 Extension의 책임이 아닙니다. 접근 제한이나 DRM을 우회하지 않습니다.

### 4. 자막 초벌

기본 로컬 초벌:

1. **자막 초벌 방식**이 기본값 **Whisper Tiny 로컬 초벌**인지 확인합니다.
2. 상태가 `로컬 Whisper <실제 모델명> 준비됨`인지 확인합니다. API 키는 입력하지 않습니다.
3. **활성 컷 전체 자막 초안 만들기**를 누릅니다.
4. 실행 전 창에서 활성 컷 수·총 길이와 `Upstage 요청 0회 · API 비용 0`을 확인합니다.
5. 계속할 때만 확인하고 결과를 원음과 대조해 검수합니다.

`ADVANCED` Solar 고급 보정이 꼭 필요할 때만:

1. **자막 초벌 방식**에서 `Solar Mini` 또는 `Solar Pro 3`를 명시적으로 고릅니다.
   - `Solar Mini`: 빠른 고급 보정
   - `Solar Pro 3`: 문맥·표현 품질 우선
2. Upstage API 키를 **Solar API 키 · 현재 탭에서만**에 붙여 넣습니다.
3. **활성 컷 전체 자막 초안 만들기**를 누릅니다.
4. 실행 전 창에서 활성 컷 수·총 길이와 활성 컷 수와 같은 최대 Solar 요청 수·유료 가능성을 확인합니다.
5. 계속할 때만 확인합니다. Solar를 고르지 않은 실행에 키 입력·Upstage 전송·비용을 요구하면 회귀입니다.

한 번에 활성 컷은 최대 16개입니다. 17개 이상이면 WAV 추출이나 네트워크 호출 전에 전체 실행을 막습니다. 큰 프로젝트는 16개 이하의 작업 단위로 나눕니다.

단일 컷 프로토콜 상한은 30분입니다. 저사양 로컬 전사를 고려해 managed pipeline 기본 deadline은 45분, 설정 가능한 상한은 60분이며 브라우저 요청 deadline은 그보다 5분 깁니다. STT 자체 timeout은 같은 pipeline deadline에서 파생되고 `STT_TIMEOUT` 또는 `PIPELINE_TIMEOUT`으로 안전하게 표시됩니다.

각 컷은 로컬 STT 뒤 sentence-like segment를 본문으로 보존하고 word timestamp를 중복 본문이 아닌 경계 anchor로 결합한 canonical timed units 하나로 정규화합니다. 기본 Whisper Tiny 초벌은 이 로컬 STT의 시작·끝과 실제 word anchor를 시각 권위로 삼아 cue를 만들고, LLM이 문장 길이만 보고 싱크를 다시 추정하게 하지 않습니다. 긴 cue도 가능한 실제 word anchor에서 나눕니다. segment와 word의 텍스트 coverage가 낮으면 임의 보정하지 않고 해당 cue를 검수 대상으로 표시합니다.

Solar 고급 옵션은 canonical timed units와 최대 24KiB의 프로젝트 공통 용어·화자 registry·사람 검수 문체 예문만 받습니다. 호출은 컷당 정확히 1회이며, 응답 형식이 맞지 않거나 빈 결과이면 다른 형식으로 유료 재호출하지 않고 안전한 오류로 멈춥니다. Solar가 제안한 cue도 `kr-vtuber-clean-v1` 로컬 하네스가 시간 범위·구조·STT 대응 품질을 추가 비용 없이 검사하고 정리합니다. 구조 계약을 끝까지 만족하지 못한 결과는 `CAPTION_QUALITY_GATE_FAILED`로 격리해 저장하지 않습니다. STT coverage·precision처럼 사람이 판단해야 할 내용 문제는 cue별 `qualityCodes`와 `reviewRequired`로 저장해 타임라인에서 바로 구분합니다.

하네스의 자동 본문 규칙:

- 배경 없는 한 줄, 하단 고정
- 자동 cue는 외부 응답 위치를 채택하지 않고 `x=0.5`, `y=0.84`, `bottom`으로 고정
- 한국어 폭 20 단위 hard limit
- 표시 시간 650ms 이상 목표, 최대 4초
- 읽기 속도 초당 16폭 단위 이하 목표
- 문장 끝 `.` 제거, `?`, `!`, `…`, `~` 유지
- 기본 화자는 흰색, 다른 speaker ID는 결정적인 고유 색
- 수동 자막, 사람이 고친 AI 자막과 강조 레인 보존

이전 초벌의 AI 자막 위치가 이미 섞여 있다면 **AI 자막 전체를 기본 위치로 정렬**을 누릅니다. 이 명시적 사용자 동작은 적용 직전 수동 임시저장을 만든 뒤 AI origin 자막의 위치만 아래 중앙으로 맞추고 텍스트·시각·레인·화자색과 직접 만든 자막은 유지합니다. 평소 프로젝트 로딩과 AI 재실행은 사람이 수정한 AI 자막 위치를 자동으로 덮어쓰지 않습니다.

### 5. 사람 검수

AI 자막은 초안입니다.

- 고유명사와 빠른 발화
- 겹친 목소리와 화자 색상
- 짧은 감탄사
- 노래, 게임 음성, 잡음
- `[불명확]`와 노란 검수 표시
- STT 대비 발화 누락·추가 가능성
- 해결되지 않은 읽기 속도·한 줄 폭·짧은 표시 시간·겹침
- 자막 시작·끝과 화면 위치

을 원음을 들으며 확인합니다.

자막은 같은 시각에 여러 레인을 사용할 수 있습니다. 타임라인 자막 블록의 양끝을 끌어 시작·끝을 바꾸고, 우클릭으로 추가·삭제합니다. 사람이 수정한 AI cue는 `humanEdited`로 보호됩니다.

**선택 자막 색상**의 색상 선택기 오른쪽에는 6칸 레지스터가 있습니다. 첫 칸 `#FFFFFF`는 항상 고정되고, 나머지 5칸은 최근 확정한 비흰색 자막 색을 최신순으로 기억합니다. 색상 칸을 누르면 선택 자막에 즉시 적용되며, 자막마다 서로 다른 색을 유지할 수 있습니다.

타임라인의 **자석**은 기본으로 켜져 있습니다. 자막이나 에셋 블록을 이동하거나 양끝 손잡이를 끌면 같은 컷의 반대 종류 시작·끝 경계를 우선해 붙고 정렬 가이드가 나타납니다. 드래그 중 `Alt`를 누르면 이번 드래그에서만 자석을 잠시 끕니다. 완전히 같은 시작·끝이 필요하면 같은 컷의 자막과 에셋을 차례로 선택한 뒤 자막 패널의 **선택 에셋 구간에 정확히 맞춤** 또는 에셋 패널의 **선택 자막 구간에 정확히 맞춤**을 누릅니다. 자석은 근접 정렬, **정확히 맞춤**은 양끝을 한 번에 복사하는 동작입니다.

공백·종결 마침표 정리, 4초·한 줄 기준 분할, 표시 시간 확장, 하단 위치 안정화, 같은 화자 겹침의 안전한 보정은 **자동 정리 경고**입니다. STT coverage/precision 저하, 해결되지 않은 읽기 속도·너비·짧은 표시 시간·겹침은 **품질 검수 필요 경고**이며 원음을 확인하기 전 정상으로 간주하지 않습니다.

### 6. 임시저장과 내보내기

- 큰 변경 전 **지금 임시저장**
- 5분마다 자동 임시저장
- 최근 5개 중 불러오기 직전 현재 상태 자동 임시저장
- `CURRENT` 편집 변경은 해당 사용자 이벤트가 끝나는 microtask에서 불변 스냅샷의 IndexedDB 쓰기를 시작하며, 탭 종료 시점의 비동기 `unload` 저장만 믿지 않음
- 최종 확인 뒤 **영상 내보내기**

프로젝트 JSON과 SRT를 영상과 함께 보관하면 후속 수정이 쉽습니다.

### 7. 작업 종료

```bash
npm run caption-stack:stop
```

foreground 실행이었다면 해당 터미널에서 `Ctrl+C`를 누릅니다.

## 실패와 자동 재개

`CURRENT` 자막 실행은 컷별 체크포인트를 사용합니다.

체크포인트 기준:

- 프로젝트 안의 clip ID
- 원본 시작·끝 밀리초
- 선택한 자막 초벌 방식(`whisper-tiny`, `solar-mini`, `solar-pro3`)
- companion이 보고한 실제 STT 모델·provider·실행 방식과 외부 STT endpoint의 결정적 pipeline 지문
- 품질 프로필 `kr-vtuber-clean-v1`과 구현 하네스 지문
- 사람이 검수한 용어·문체·화자 registry의 bounded 편집 문맥 지문
- 완료 request ID와 완료 시각

중간 실패, 취소, 또는 탭의 비정상 종료 뒤 같은 버튼을 다시 누르면:

1. 같은 범위·같은 자막 초벌 방식·같은 실제 STT pipeline 지문·같은 품질 하네스 지문·같은 신뢰 편집 문맥 지문으로 완료 저장된 컷을 찾습니다.
2. 완료 컷은 건너뜁니다.
3. 실패한 컷부터 이어서 처리합니다.
4. 이전 경고와 사람 수정 자막을 보존합니다.

컷 범위나 자막 초벌 방식을 바꾸거나 실제 STT 모델·실행 방식·외부 endpoint, 품질 하네스 지문·신뢰 편집 문맥 지문이 바뀌면 해당 체크포인트는 일치하지 않으므로 그 컷은 새 요청으로 처리합니다. 지문이 없던 구버전 체크포인트도 재사용하지 않습니다. 실행 도중 새로 생긴 미검수 AI 화자 표식은 다음 컷의 화자 일관성에는 쓰지만 체크포인트 문맥 지문에는 넣지 않아 재개 지문이 실행 중 흔들리지 않게 합니다. 정상 완료 상태에서 사용자가 새 실행을 시작한 경우에는 전체 활성 컷을 새 초벌로 간주합니다.

새 전체 실행은 대상 컷의 이전 체크포인트를 API 호출 전에 폐기합니다. 로컬 원본을 다시 연결할 때 이름·크기·수정 시각·길이·코덱 등 identity가 달라져도 체크포인트를 폐기하므로, 다른 영상의 같은 좌표를 완료 컷으로 오인하지 않습니다.

재개 전에 편집기는 프로젝트를 이미 컷별로 저장합니다. 오류가 났다고 프로젝트 초기화, 오래된 백업 강제 복원, 원본 재다운로드부터 하지 않습니다.

## 데이터 흐름

```text
Chrome editor
  ├─ 활성 컷에서 16kHz mono PCM/WAV 생성
  ├─ ADVANCED Solar일 때만 대표 프레임을 로컬에서 축소 분석
  └─ http://127.0.0.1:4319/v1/captions
       ├─ exact chrome-extension Origin 검사
       ├─ process-memory bearer session 검사
       ├─ http://127.0.0.1:4318/kirinuki-<매 기동 192-bit nonce>/inference
       │    └─ 기본 draft tiny-q5_1의 한국어 timed transcript
       ├─ segment 본문 + word 경계 anchor의 canonical timed units로 단일 정규화
       ├─ 기본 whisper-tiny
       │    └─ Upstage 0회, STT 경계 우선 로컬 cue 초벌
       ├─ ADVANCED Solar를 명시 선택한 경우에만
       │    └─ https://api.upstage.ai/v1/chat/completions
       │         └─ 컷당 최대 1회, timed units와 bounded 용어·화자·문체 문맥만 전달
       └─ 로컬 kr-vtuber-clean-v1 품질 하네스
            └─ 외부 추가 호출 없이 STT/word 경계 우선 분할·화자 정규화·평가·cue별 검수 gate
```

로컬 stack은 두 프로세스를 감독합니다.

- `whisper-server`: 기본 draft `tiny-q5_1` 등 선택한 고정 모델을 이용한 로컬 전사
- `solar-caption-gateway.mjs`: 호환 파일명. 인증·요청 상한과 기본 STT→로컬 하네스, 선택적 STT→Solar→로컬 하네스 변환

Extension은 OS 프로세스를 직접 설치하거나 시작할 수 없으므로 최초 setup과 매일 start는 CLI가 담당합니다.

## 보안·비밀정보

### 자동 페어링

managed gateway는 시작할 때 256-bit bearer token을 메모리에서 생성합니다.

- `POST /v1/session`
- exact `chrome-extension://<ID>` Origin 필수
- 지원 프로토콜 헤더 필수
- 분당 요청 제한
- `Cache-Control: no-store`
- gateway 재시작 시 token 폐기
- 무과금 `/v1/health`는 exact Origin·프로토콜만 받고 token을 발급하거나 pairing rate limit을 소비하지 않음

편집기는 token을 현재 탭 메모리에만 둡니다.

### 선택적 Solar 고급 옵션의 Upstage API 키

- 기본 Whisper Tiny 실행에는 필요하지 않음
- 사용자가 Solar Mini/Pro 3를 명시 선택했을 때만 사용하는 password 입력값
- 현재 편집기 탭 메모리에만 존재
- 인증된 loopback companion 요청 헤더로만 전달
- 프로젝트 JSON, 임시저장, Chrome 저장소, CLI 설정, child env, systemd unit에 쓰지 않음
- 탭을 닫거나 **지우기**를 누르면 사라짐

API 키 값을 terminal 인자에 넣지 않습니다. CLI는 이름에 `api-key`, `token`, `secret`이 들어간 옵션을 거부합니다.

### 로컬 파일

whisper.cpp 소스, binary, 모델, VAD는 XDG 사용자 데이터 경로 아래에 설치합니다. 다운로드는 `.part-*` 임시 파일에 받고, 스트리밍 중 고정 크기를 넘는 즉시 중단하며, 최종 크기와 SHA-256을 모두 확인한 뒤 원자적으로 이름을 바꿉니다. 설정 파일 권한은 `0600`입니다. 설치 시 제3자 고지문도 데이터 경로에 함께 복사합니다.

진단·빌드·runtime child 환경에서는 이름이 API key, token, secret, password, credential, private/access key인 변수를 제거합니다. gateway가 로컬 Whisper로 보낼 때 proxy를 타지 않도록 `NO_PROXY`와 `no_proxy`에 `127.0.0.1,localhost`를 강제하고, Upstage HTTPS에 대한 사용자의 일반 proxy 설정은 유지합니다.

## 고급 외부 STT

`ADVANCED` 기존 외부 timed STT 호환도 유지합니다. 사용자가 Solar Mini/Pro 3를 명시적으로 선택했을 때만 편집기의 고급 설정에서 endpoint, model, key를 입력할 수 있습니다. 기본 `whisper-tiny` 선택에서는 agent endpoint가 loopback인지, capability의 provider와 transcription mode가 모두 `local-whispercpp`인지 fail-closed로 확인합니다. v1 또는 현재 설정에 원격 agent·외부 STT 값이 남아 있어도 기본 로컬 실행에 사용하거나 WAV를 전송하지 않습니다.

외부 endpoint 요구:

- 원격은 HTTPS
- 로컬은 `127.0.0.1` 또는 `localhost` HTTP
- URL 안 사용자 정보·쿼리·fragment 금지
- multipart WAV
- 한국어
- segment 또는 word timestamp가 있는 JSON

외부 STT를 선택하면 그 제공자의 비용·데이터 보존 정책이 별도로 적용됩니다. 로컬 STT 실패 시 자동으로 이 경로를 선택하지 않습니다.

## 문제 해결

| 증상 | 확인과 복구 |
|---|---|
| `설정: 없음` | `npm run caption-stack:setup` |
| `STT=down · gateway=down` | `npm run caption-stack:start`, 이어서 `status` |
| 4318/4319가 `occupied/foreign` | 다른 프로세스 또는 구 수동 whisper/gateway를 정상 종료한 뒤 다시 시작 |
| 편집기 상태가 엔진 꺼짐 | `status`; Extension 폴더 이동 여부 확인; 필요 시 setup 재실행 |
| gateway 401 | managed stack을 다시 시작하고 편집기의 **연결 확인** |
| gateway 403 또는 Extension 경로 변경 | `doctor`/`status`의 Origin mismatch를 확인하고 setup 재실행; 실행 중이면 성공 뒤 자동 재시작 |
| `TIMED_STT_REQUIRED` | 구 reference gateway 모드인지 확인; managed `local-whispercpp`로 시작 |
| 한국어가 영어처럼 나옴 | `.en` 모델을 쓰지 않았는지 확인; setup으로 고정 다국어 모델 복구 |
| 매우 느림 | 기본 `--profile draft --backend cpu`인지 확인하고 활성 컷을 더 작은 묶음으로 실행 |
| 메모리 부족 | `draft`, 다른 무거운 앱 종료, 활성 컷을 더 작은 묶음으로 실행 |
| 짧은 감탄사 누락 | 원음을 듣고 직접 cue 추가; 필요하면 `quality`로 해당 작업 재시도 |
| Solar 고급 옵션의 401/429 | Solar를 명시 선택했는지와 현재 탭의 키·계정 상태·rate limit 확인; 전체 버튼을 연속 클릭하지 않기 |
| Solar 고급 옵션의 `SOLAR_RESPONSE_FORMAT_UNSUPPORTED` 또는 빈 결과 | 자동 유료 형식 폴백은 하지 않음; 모델·설정을 확인한 뒤 사용자가 재실행 여부 결정 |
| 중간 실패 | 같은 자막 초벌 방식·실제 STT pipeline·컷 범위·하네스 지문으로 버튼을 다시 눌러 체크포인트 재개 |
| 0.1초 미만 cue | gateway가 클립 경계 안에서 0.1초로 늘리고 경고로 남김 |
| 깨진 다운로드 | setup 재실행; 검증 실패 파일은 최종 이름으로 채택되지 않음 |

읽기 전용 진단:

```bash
npm run caption-stack:doctor -- --json
npm run caption-stack:status -- --json
```

## 파일 지도

- `scripts/local-caption-stack.mjs`: setup/start/status/stop, child 감독, systemd-user
- `scripts/local-caption-stack-core.mjs`: 고정 artifact, 하드웨어·프로필, 안전 인자, unit 생성
- `scripts/solar-caption-gateway.mjs`: loopback HTTP, exact Origin, 자동 session, CORS, 요청 실행
- `src/caption-agent/solar-gateway-core.js`: canonical timed units, 컷당 Solar 1회, 로컬 하네스 연결
- `src/caption-agent/caption-quality-harness.js`: `kr-vtuber-clean-v1` 정규화·복구·품질 평가
- `src/caption-agent/editorial-context.js`: bounded 용어·화자 alias·검수 문체 문맥과 결정적 지문
- `src/caption-agent/protocol.js`: 요청·응답 스키마와 안전한 cue 경계
- `src/editor/caption-agent.js`: 브라우저 자동 페어링, 비용 예상, 하네스 지문 체크포인트
- `extension/lib/caption-style.js`: 측정 기반 기본 스타일, OFL 대안과 화자 색상
- `src/editor/main.js`: 사용자 확인, 컷별 실행·저장·재개
- `extension/lib/session-recovery.js`: 최근 편집의 비밀정보 없는 요약, resume URL, 동일 프로젝트 탭 판정
- `extension/service-worker.js`: source 연결 신규 열기와 source 비의존 저장 세션 재개 중계
- `extension/editor.html`: 일반 사용자용 키·모델·상태와 고급 설정
- `tests/local-caption-stack.test.js`: 설치·프로필·보안 계약
- `tests/solar-caption-gateway.test.js`: gateway·STT·Solar 통합 계약
- `tests/caption-agent-client.test.js`: 브라우저 session·비밀·재개 계약
- `legal/THIRD_PARTY_NOTICES.md`: runtime 다운로드까지 포함한 고정 revision·라이선스 고지

## 수정하는 에이전트의 작업 순서

1. 이 파일을 끝까지 읽습니다.
2. 작업 전 `git status --short`로 사용자 변경을 확인합니다.
3. 비밀 값을 읽거나 출력하지 않습니다. 테스트는 명시적인 가짜 키만 사용합니다.
4. Extension ID를 바꾸는 manifest key를 임의로 추가하지 않습니다.
5. 로컬 모델 다운로드를 `npm install`, `build`, 기본 CI에 넣지 않습니다.
6. whisper-server의 random private request path를 고정 `/inference`로 되돌리거나 브라우저에 노출하지 않습니다.
7. 외부 네트워크 테스트는 opt-in으로 둡니다. 기본 테스트는 로컬 `whisper-tiny`의 Upstage 0회 경로와 fake STT/Solar 고급 경로만 사용합니다.
8. 편집 불변조건과 기존 사람이 수정한 cue 보호를 유지합니다.
9. 문서의 CURRENT와 TARGET을 실제 코드 상태에 맞춥니다.
10. 아래 검증을 통과합니다.

```bash
npm run check
git diff --check
```

릴리스 환경에 Chromium, ChromeDriver, FFmpeg/ffprobe가 있으면:

```bash
npm run check:full
```

로컬 stack 변경 시 추가 확인:

```bash
node --test tests/local-caption-stack.test.js
npm run caption-stack:doctor -- --json
npm run caption-stack:setup -- --dry-run
```

실제 setup 통합 검증은 모델 다운로드와 native build가 필요하므로 CI 기본 경로에서 실행하지 않습니다. 실행했다면 사용한 profile, backend, whisper commit, model SHA, 실제 fixture WAV의 timed transcript 여부를 PR에 기록합니다.

## 릴리스 합격 기준

- 활성 컷 0/16/17 경계가 네트워크 전에 동작
- 기본 `whisper-tiny`가 Upstage 키·전송·호출·비용 0으로 준비·완료
- Solar 고급 옵션에서도 16kHz WAV가 Upstage 요청에 포함되지 않음
- 로컬 mode가 STT key 없이 준비 완료
- Solar 고급 옵션의 외부 remote endpoint는 HTTPS와 명시적 STT key 요구
- 기본 `whisper-tiny`는 loopback agent와 `local-whispercpp` provider·transcription mode만 허용
- exact Origin이 아닌 pairing 거절
- health probe는 token 발급·pairing limit 소비 없이 관리형 프로세스만 식별
- whisper 직접 endpoint는 매 기동 192-bit private path이고 `/load`도 그 아래에만 존재
- session token과 Upstage key 저장·로그 없음
- 진단·빌드·runtime child에 환경의 API secret을 전달하지 않고 loopback STT는 proxy를 우회
- Solar를 명시 선택한 경우에만 유료 호출하고 컷당 1회를 넘지 않으며 자동 유료 형식 폴백이 없음
- Solar 고급 옵션에는 canonical timed units만 한 번 전달되고 중복 transcript 본문이 없음
- segment 본문을 word 하나 때문에 폐기하지 않고 word는 실제 분할 경계 anchor로만 전달
- bounded 편집 문맥이 허용 항목·크기 상한을 지키며 `main`·한글·로마자 스트리머 alias를 하나로 정규화
- 로컬 하네스와 편집기 수신 경계가 한 줄·아래 중앙 `x=0.5/y=0.84/bottom`, 폭 20 상한, 650ms 목표, 4초 상한, 초당 16폭 단위와 문장부호 계약을 결정적으로 적용
- 동시 AI cue는 타임라인 레인을 분리하되 화면 위치를 위로 자동 스태킹하지 않음
- 구조 위반 결과는 저장 전 격리되고 내용 불확실성은 cue별 품질 사유와 review gate로 전달
- 일반 자동 정리 경고와 사람 검수가 필요한 품질 경고를 구분
- 취소 시 진행 중 STT와, 선택한 경우에만 Solar 신호 중단
- 컷별 저장 후 오류 상태에서 같은 범위·모델·실제 STT pipeline·하네스 지문·신뢰 편집 문맥 지문만 자동 건너뜀
- fresh run과 다른 원본 연결은 낡은 대상 체크포인트를 폐기
- 사람 cue와 human-edited AI cue 보존
- 모델·binary·`.part`·env secret이 Extension package에 없음
- `npm run check` 통과
