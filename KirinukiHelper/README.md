# 치지직·YouTube 키리누키 스튜디오 Chrome Extension

치지직 생방송·다시보기 또는 YouTube VOD를 보며 사용할 구간을 표시하고, 같은 Extension의 전체화면 편집기에서 컷·투명 이미지 에셋·구간별 음성·다중 한국어 자막을 검수해 영상을 내보내는 로컬 우선 도구입니다.

사용자가 찍은 시작·끝은 `authority: USER`인 확정 범위입니다. AI는 재미있는 구간을 대신 고르거나 경계를 자동으로 늘리지 않고, 선택된 범위의 한국어 자막 초안만 만듭니다. 텍스트, cue 시작·끝·레인·색상, 영상 위 자막 위치, 구간별 음량과 컷 경계·내부 삭제 범위는 사람이 직접 고칠 수 있습니다.

현재 미디어 입력은 사용 권한이 있는 로컬 원본 파일입니다. Extension은 지원 영상 탭의 메타데이터·현재 시각·재생 위치 제어를 연결하지만 치지직이나 YouTube 영상을 다운로드하거나 접근 제한을 우회하지 않습니다. 원본 전체와 최종 렌더는 이 기기에 남습니다. 자막 초벌은 **로컬 Whisper**와 **AudSeg** 중 하나를 고릅니다. Whisper는 이 기기의 loopback companion에서 한국어 글과 타이밍을 만들고, AudSeg는 브라우저 안에서 모델 없이 소리 활동을 찾아 사람이 채울 빈 타이밍만 만듭니다. 두 방식 모두 인터넷 자막 서비스나 API 키를 사용하지 않습니다.

## 설치

1. Node.js 20.9 이상에서 `npm ci --ignore-scripts && npm run build`를 실행합니다.
2. Chrome 또는 Chromium 120 이상에서 `chrome://extensions`를 엽니다.
3. 우측 상단의 **개발자 모드**를 켭니다.
4. **압축해제된 확장 프로그램을 로드합니다**를 누르고 이 저장소의 `extension` 폴더를 선택합니다.
5. 치지직 영상 또는 YouTube 영상 페이지를 열고 도구 모음의 확장 아이콘을 누르면 사이드패널이 열립니다.

기존에 열려 있던 지원 영상 탭에도 첫 통신 때 콘텐츠 브리지를 주입하므로 대개 새로고침 없이 동작합니다. 브라우저 정책으로 주입이 막힌 경우 해당 탭을 한 번 새로고침하세요.

Linux에서 로컬 자막 초벌까지 쓰려면 최초 한 번 다음을 이어서 실행합니다.

```bash
npm run caption-stack:doctor
npm run caption-stack:setup
npm run caption-stack:start
```

`setup`은 고정 revision과 SHA-256의 whisper.cpp·다국어 모델·Silero VAD를 사용자 데이터 폴더에 설치하고 제3자 고지문도 함께 둡니다. 옵션 없이 실행하면 기본 `draft` 프로필의 다국어 `tiny-q5_1` 모델을 준비합니다. API 키는 받거나 저장하지 않습니다. 실행 중 setup을 다시 하면 검증 성공 뒤 서비스에 새 profile·Origin을 자동 적용합니다. 다음 작업부터는 `npm run caption-stack:start`만 실행하면 됩니다. `auto`, `light(base-q5_1)`, `quality(medium-q5_0)`는 Tiny보다 더 무거운 모델을 명시적으로 선택할 때 사용합니다. 상세 운영법과 개발 불변조건은 [AGENTS.md](AGENTS.md)에 있습니다.

`extension` 폴더의 절대 경로를 옮기면 압축해제 확장의 ID가 달라집니다. 새 폴더를 `chrome://extensions`에서 다시 불러온 뒤 Whisper를 계속 쓰려면, 기존에 쓰던 profile과 backend를 명시해 `caption-stack:setup`을 한 번 다시 실행하세요. AudSeg는 경로 변경과 관계없이 companion 설치가 필요 없습니다.

### 전용 Chromium 프로필로 실행하기 (선택)

기존 브라우저 프로필과 분리하고 싶다면 저장소 최상위에서 다음처럼 실행할 수 있습니다.

```bash
chromium \
  --user-data-dir="$HOME/.config/chromium-kirinuki" \
  --load-extension="$(pwd)/extension" \
  --no-first-run \
  --no-default-browser-check
```

Extension 소스를 수정한 뒤에는 `chrome://extensions`에서 다시 로드하면 됩니다. 평상시 실행에는 원격 디버깅 포트를 열 필요가 없습니다.

## 통합 편집 흐름

1. 치지직 라이브·VOD 또는 YouTube VOD를 재생합니다.
2. 사용할 사건이 시작될 때 **시작 스탬프 → 지금**을 누릅니다.
3. 사건의 반응이나 결론이 끝날 때 **끝 스탬프 → 지금**을 누릅니다.
4. 메모는 선택 사항입니다. **구간 저장**을 누르고 필요한 만큼 반복합니다.
5. **통합 편집기에서 열기**를 누릅니다. 편집기를 연 뒤에도 원래 소스 탭 연결은 `projectId + tabId`로 유지됩니다.
6. **원본 연결**에서 해당 소스의 사용 권한이 있는 로컬 영상 파일을 선택합니다.
7. 로컬 파일의 시작점이 페이지 영상 시각과 다르면 **페이지 시각 ↔ 로컬 원본 정렬** 오프셋을 먼저 맞춥니다.
8. 필요하면 컷 트랙 양끝 손잡이를 끌어 경계를 직접 조정합니다.
9. **로컬 Whisper · 글과 타이밍 만들기** 또는 **AudSeg · 모델 없이 빈 타이밍 만들기**를 고른 뒤 **활성 컷 전체 초벌 만들기**를 실행합니다. Whisper는 `draft tiny-q5_1` 전사와 실제 STT 타임스탬프를 사용합니다. AudSeg는 음성 인식 없이 소리가 있는 구간에 비어 있는 검수 cue만 만듭니다.
10. `영상 → 에셋 → 음성 → 자막` 타임라인에서 이미지·자막·음성을 검수합니다. 영상 중간을 덜어낼 때는 재생헤드에서 `시작 [I]`와 `끝 [O]`을 찍고 **구간 삭제**를 누릅니다. 삭제 뒤 영상과 연결된 에셋·음성·자막은 함께 당겨집니다. 웹 이미지 자체를 복사한 뒤 편집기에서 `Ctrl/Cmd+V`를 누르면 현재 위치에 에셋으로 들어가며 PNG·WebP의 투명 영역도 보존됩니다. 자막 레인은 기본 2개이며 `+`로 늘릴 수 있습니다. **선택 자막 색상** 오른쪽 레지스터는 고정 흰색 `#FFFFFF`와 최근 비흰색 5개를 기억합니다. 타임라인 **자석**으로 자막↔에셋 경계를 가까이 끌어 붙이고, 같은 컷의 둘을 선택한 뒤 **선택 에셋 구간에 정확히 맞춤** 또는 **선택 자막 구간에 정확히 맞춤**으로 양끝을 한 번에 일치시킬 수 있습니다. 구버전 AI 초벌의 화면 위치가 섞여 있으면 **AI 자막 전체를 기본 위치로 정렬**을 한 번 누릅니다.
11. 큰 편집 전에는 **지금 임시저장**을 누를 수 있습니다. 편집기는 5분마다 자동 임시저장하며, **저장 목록**에서 이 기기의 최근 5개 중 하나를 고르면 현재 상태를 먼저 임시저장한 뒤 불러옵니다.
12. **영상 내보내기**에서 폴더를 한 번 고르면 선택 컷·이미지 에셋·자막이 들어간 MP4 또는 WebM, 프로젝트 JSON, 자막이 있을 때의 SRT가 같은 폴더에 저장됩니다.

### 닫은 편집 이어서 열기

다시 작업할 때는 원래 치지직·YouTube 탭을 먼저 찾을 필요가 없습니다.

1. 같은 Chrome/Chromium 프로필에서 Extension 사이드패널을 엽니다.
2. 맨 위 **이 기기의 최근 편집**에서 제목, 최근 시각과 `컷 · 자막 · 에셋 · 음성` 수를 확인합니다.
3. 마지막으로 저장된 현재본을 열려면 **계속 편집**을 누릅니다.
4. 최근 5개의 수동·자동·복원 직전 저장 중 하나를 고르려면 **복구본 선택**을 누릅니다. 편집기가 열리면서 저장 목록이 바로 표시됩니다.
5. 복구본을 실제로 불러오기 전 현재본은 자동으로 `복원 직전` 임시저장되므로 잘못 골라도 다시 돌아갈 수 있습니다.

이 경로는 저장된 `projectId`를 직접 열며 현재 보고 있는 영상 탭이나 사이드패널의 새 좌표를 기존 프로젝트에 합치지 않습니다. 같은 프로젝트 편집기 탭이 이미 열려 있으면 새 탭을 중복 생성하지 않고 그 탭을 앞으로 가져옵니다. 원본 파일 권한이 만료된 경우에만 편집기의 **원본 연결**에서 같은 파일을 다시 고르세요. 두 초벌 방식 모두 API 키가 필요 없습니다. Whisper companion session은 탭을 닫으면 사라지고 다음 연결 때 자동으로 다시 발급됩니다.

긴 원본을 통째로 메모리에 복사하지 않습니다. 미리보기·자막용 오디오 추출·렌더링은 사용자가 선택한 구간을 기준으로 디스크에서 필요한 부분만 읽습니다.

자막 에이전트의 기본 파이프라인은 로컬에서 결정적으로 실행됩니다.

```text
활성 컷 오디오
→ 이 기기의 whisper.cpp Tiny(draft tiny-q5_1) timed STT
→ segment 문장 + 중복 본문 없는 word 경계 anchor의 canonical timed units
→ STT 타임스탬프 경계를 우선한 로컬 cue 초벌
→ 로컬 kr-vtuber-clean-v1 품질 하네스
→ 실제 word 경계 분할·화자 alias 정규화·cue별 품질 gate
→ 편집기의 검수용 자막 초안
```

기본 로컬 초벌은 LLM이 문장 길이로 싱크를 다시 추정하지 않습니다. sentence-like segment의 본문을 보존하고 실제 word timestamp를 cue 시작·끝과 분할 경계의 우선 anchor로 사용합니다. coverage가 낮으면 시간을 꾸며 내지 않고 검수 표시를 남기며, 로컬 `kr-vtuber-clean-v1` 하네스가 최종 시각·구조를 결정합니다.

AudSeg 경로는 별도의 모델·서버·키 없이 같은 16kHz PCM을 브라우저에서 분석합니다. 20ms RMS 프레임과 적응형 소음 바닥, 히스테리시스, debounce·padding·merge를 사용해 소리 활동 구간을 찾고 최대 4초 단위로 나눕니다. 결과는 실제 텍스트가 비어 있는 검수용 cue이며 음악·효과음도 활동으로 잡힐 수 있습니다. 따라서 AudSeg는 STT의 대체 전사기가 아니라 **수동 자막을 빠르게 시작하기 위한 타이밍 도구**입니다.

`kr-vtuber-clean-v1`의 자동 본문 자막은 **배경 없는 한 줄·아래 중앙 고정**(`x=0.5`, `y=0.84`, `placement=bottom`)입니다. 동시 화자가 별도 타임라인 레인을 사용해도 화면 위치를 위로 자동으로 쌓지 않습니다. 한글·한자·이모지는 1, 공백은 0.35, 라틴 문자는 0.55처럼 계산한 한국어 폭 단위를 기준으로 한 줄 20을 상한으로 사용합니다. 표시 시간은 650ms 이상을 목표로 하며 최대 4초, 읽기 속도는 초당 16폭 단위 이하를 목표로 합니다. 문장 끝의 `.`은 제거하지만 `?`, `!`, `…`, `~`는 유지합니다. 기본 화자는 흰색, 구분 가능한 다른 화자는 안정적인 고유 색을 사용합니다. 사람이 만든 자막, 사람이 고친 AI 자막과 강조용 추가 레인은 덮어쓰지 않습니다. 사용자가 **AI 자막 전체를 기본 위치로 정렬**을 명시적으로 누른 경우에만 적용 직전 임시저장 뒤 기존 AI origin 자막의 위치 전체를 초기화하며, 글·시각·색과 직접 만든 자막은 유지합니다.

한 번의 실행은 활성 컷 최대 16개, 새 AI cue 최대 10,000개로 제한합니다. 실행 전 활성 컷 수·총 길이와 선택 방식이 표시됩니다. 취소하면 오디오 추출을 시작하지 않습니다. 컷 하나가 끝날 때마다 결과와 체크포인트를 저장하므로 중간 실패·취소·탭 종료 뒤 같은 범위·선택 방식·실행 지문·품질 하네스 지문으로 다시 누르면 완료 컷을 건너뛰고 실패 지점부터 재개합니다. 필요한 지문이 없거나 달라진 예전 체크포인트, 새 전체 실행과 다른 원본 연결의 체크포인트는 재사용하지 않습니다.

로컬 하네스가 공백·종결 마침표, 길이·표시 시간과 하단 위치를 안전하게 고친 경우에는 **자동 정리 경고**로 알려 줍니다. Whisper의 STT 대비 발화 누락·추가 가능성, segment↔word anchor coverage 저하, 해결되지 않은 읽기 속도·너비·짧은 표시 시간은 cue 자체의 **품질 검수 필요** 사유로 저장되어 노란 검수 상태로 보입니다. 구조 계약을 로컬 복구 뒤에도 위반하면 원래 STT 경계를 조용히 움직이거나 일반 완료본으로 저장하지 않고 격리합니다. AudSeg cue는 텍스트를 만들지 않으므로 항상 사람 검수 대상입니다.

### 로컬 Whisper와 AudSeg

글 초안이 필요하면 **로컬 Whisper**를 사용합니다. `caption-stack:setup`이 설치한 `draft tiny-q5_1`과 자동 loopback session을 쓰므로 API 키나 토큰을 입력하지 않습니다. **활성 컷 전체 초벌 만들기**를 누르면 로컬 timed transcript → STT 경계 우선 cue → 로컬 하네스 순서로 끝납니다.

이전 버전에서 `auto`, `light`, `quality` 프로필을 설치했다면 `start`는 사용자가 고른 기존 모델을 조용히 바꾸지 않습니다. 편집기 상태에는 companion이 보고한 실제 STT 모델명이 표시됩니다. 기본 Tiny로 전환하려면 `npm run caption-stack:setup -- --profile draft`를 한 번 실행하세요.

Whisper 설치 없이 타이밍 틀부터 만들거나 저사양 환경에서 시작하려면 **AudSeg**를 고릅니다. AudSeg는 현재 브라우저 탭에서만 실행되고 companion 연결을 요구하지 않습니다. 생성된 빈 cue마다 원음을 듣고 글·화자·색을 직접 채우세요.

```bash
npm run caption-stack:doctor
npm run caption-stack:start
npm run caption-stack:status
npm run caption-stack:stop
```

companion 주소는 `127.0.0.1` 또는 `localhost`의 HTTP만 허용합니다. 예전 버전에 저장된 원격 주소·모델·자격증명 필드는 불러올 때 버리고 실행에 사용하지 않습니다. Whisper가 실패해도 다른 네트워크 서비스로 자동 전환하지 않습니다. 전체 설치·프로필·복구·보안·트러블슈팅은 [AGENTS.md](AGENTS.md), 화면별 사용법은 [HELP.md](HELP.md)를 참고하세요.

### YouTube 타임스탬프 지원

- `youtube.com/watch?v=...`, `youtu.be/...`, `youtube.com/shorts/...`, 최상위 탭으로 연 `youtube.com/embed/...`를 지원합니다.
- 같은 영상 ID의 watch·짧은 주소·Shorts·embed는 한 프로젝트 소스로 취급하고 안정적인 watch URL로 정규화합니다.
- 보이는 주 영상의 `currentTime`을 밀리초 단위로 읽으며, 광고 재생 중에는 광고 시각이 섞이지 않도록 캡처·시각 제어를 막습니다.
- 진행 중인 YouTube 라이브와 다른 사이트 안의 YouTube iframe은 지원하지 않습니다. 종료되어 유한한 길이로 재생되는 영상은 VOD로 사용할 수 있습니다.
- Extension은 YouTube 미디어를 내려받지 않습니다. 편집·렌더에는 본인이 소유하거나 사용 허가를 받은 로컬 원본을 별도로 연결해야 합니다.

### 선택적 YouTube 로컬 원본 획득

본인이 소유하거나 다운로드·편집 권한을 받은 YouTube VOD는 별도 로컬 CLI에서 오픈소스 [yt-dlp](https://github.com/yt-dlp/yt-dlp)와 [FFmpeg](https://ffmpeg.org/)로 준비할 수 있습니다. 이 CLI는 Extension 안에서 실행되지 않으며 DRM·로그인·지역·접근 제한을 우회하거나 브라우저 쿠키를 자동으로 읽지 않습니다. `yt-dlp`와 `ffmpeg`를 먼저 설치한 뒤 저장소 최상위에서 실행하세요.

```bash
# 기본: YouTube가 제공하는 최고 영상·음성 스트림을 아카이브 우선으로 보존
npm run acquire:youtube -- \
  --output-dir "/로컬/원본/폴더" \
  "https://www.youtube.com/watch?v=<video-id>"

# 편집 안전형: 최고 H.264 MP4 영상 + AAC M4A 음성을 MP4로 병합
npm run acquire:youtube -- \
  --profile editor-safe \
  --output-dir "/로컬/원본/폴더" \
  "https://www.youtube.com/watch?v=<video-id>"
```

기본 `quality-first`는 `bv*+ba/b`를 선택하고 FFmpeg stream copy로 병합합니다. 원래 압축 스트림을 다시 인코딩하지 않으므로 추가 화질·음질 손실은 없지만, 조합에 따라 결과가 MKV가 되어 현재 Chromium 빌드에서 미리보기되지 않을 수 있습니다. `editor-safe`는 Chromium 호환성을 위해 H.264/AAC MP4만 고르므로 대개 안정적이지만, YouTube가 H.264로 제공하지 않는 1440p·4K가 있으면 그보다 낮은 해상도가 선택될 수 있습니다. YouTube 원본 자체가 이미 손실 압축이므로 여기서 “무재인코딩”은 받은 스트림을 그대로 보존한다는 뜻이지 손실 압축을 복원한다는 뜻은 아닙니다.

두 프로필 모두 재생목록을 받지 않고, 기존 파일을 덮어쓰지 않으며, 중단된 전송은 `.part`로 이어받습니다. 병합은 `-c copy`이고 `--recode-video`·음성 추출 변환은 사용하지 않습니다. 완료되면 `after_move` 최종 파일 경로를 출력하므로 해당 파일을 편집기의 **원본 연결**에서 선택하세요. 실행 파일이 PATH 밖에 있으면 `YT_DLP_BINARY`와 `FFMPEG_BINARY`에 각각 경로를 지정할 수 있습니다.

### LIVE와 다시보기·로컬 파일 시간 맞추기

같은 채널의 LIVE와 공식 다시보기가 같은 방송 시작 시각을 가지면 편집기는 둘을 같은 회차로 연결합니다. 기준은 `channelId + broadcastStartedAt/liveOpenDate`입니다. 원본 파일의 0초가 치지직 방송의 0초와 같다면 오프셋은 `0`으로 둡니다.

치지직과 YouTube 모두 편집기 공식은 다음과 같습니다.

```text
로컬 원본 시각 = 페이지에서 선택한 시각 + 오프셋
```

예를 들어 페이지의 100초 장면이 로컬 파일 90초에 있다면 오프셋은 `-10`초입니다. 첫 컷의 화면·음성이 맞지 않거나 컷이 파일 길이 밖이라는 경고가 나오면 이 값을 먼저 확인하세요. 오프셋을 바꾸더라도 사용자가 찍은 원래 구간 자체를 조용히 변경하지 않습니다.

## 기존 Codex 작업폴더 흐름

사이드패널의 **Codex 작업폴더 만들기**와 **프롬프트만 미리보기**도 계속 제공합니다. 이 경로는 로컬 도구로 별도 전처리하거나 정책 프리플라이트 문서를 함께 만들 때 사용합니다.

작업 폴더는 다음 구조입니다.

```text
프로젝트명-생성시각/
├── AGENTS.md             # Codex가 따라야 할 지속 작업 규칙
├── START_HERE.md         # 사용자용 3단계 안내와 한 문장 시작 요청
├── edit-brief.md         # 사용자 확정 컷, 메모와 편집 프롬프트
├── creator-policy.md     # 현재 방송인의 공식 정책 링크와 사람 검수 게이트
├── creator-policy-index.json # 방송인·그룹↔공식 정책 URL 관계
├── job-manifest.json     # 기계 판독용 확정 컷·산출물 규격
└── full-video.mp4        # 사용자가 나중에 넣는 파일; 이름은 자유
```

폴더 저장 API를 지원하지 않는 브라우저에서는 기존 **프롬프트만 미리보기 → MD 다운로드** 흐름을 사용하면 됩니다.

## 사용자 확정 컷 원칙

- 저장한 시작·끝은 최종 컷 경계이며 AI가 자동 확장·축소하지 않습니다.
- 겹치는 선택도 자동 병합하거나 삭제하지 않습니다.
- 기본 연결 순서는 사용자가 저장하고 편집기에서 정한 순서입니다.
- 편집기에서 사용자가 지정한 내부 범위를 삭제하면 컷을 필요한 조각으로 나누고 뒤 영상·에셋·음성·자막을 한 번에 리플 이동합니다.
- 음성 인식이 경계 밖 문맥을 참고하더라도 결과 영상과 자막 cue는 선택 범위 안에만 생성됩니다.
- 더 나은 경계가 있어 보여도 제안으로만 표시하며, 사용자가 직접 핸들을 움직인 경우에만 반영됩니다.

세부 규칙은 [기본 편집 지침](extension/knowledge/base-editing-guidelines.md)과 작업 폴더에 복사되는 [Codex 작업 규칙](extension/knowledge/codex-job-agents.md)에 있습니다.

## 정책 안전 게이트

[방송인·아티스트 정책 기본 규정](extension/knowledge/default-creator-policy.md)에는 사용자가 제공한 다음 다섯 정책 출처 그룹이 등록되어 있습니다.

- 스텔라이브
- 카론유니버스W
- 프로젝트아이
- 오버더월
- 리스텔라

[정책 인덱스](extension/knowledge/creator-policy-index.json)가 치지직에서 읽은 방송인 이름을 아티스트 목록과 **정확 일치**로 연결합니다. 예를 들어 `아리사`는 `카론유니버스W`와 `https://cafe.naver.com/vkpopstar/1174`에 매칭됩니다. 생성 프롬프트와 작업폴더에는 이 관계와 공식 URL만 넣고, Codex는 작업 시점에 원문을 다시 확인합니다. 부분 문자열이나 동명이인 추정은 사용하지 않습니다.

재배포 허가를 별도로 확인하지 않은 정책 본문·스크린샷·과거 확인본은 Extension, 저장소, 작업폴더 어디에도 동봉하지 않습니다. 따라서 공식 링크 본문을 읽을 수 없는 경우 내용을 추정하거나 과거 사본으로 우회하지 않고 `SOURCE_UNREADABLE` 상태를 유지합니다.

방송인·소속사의 최신 공식 정책이 기본 규정보다 우선하지만, 다음은 예외 없이 적용합니다.

- 수익·상업 이용은 사람이 다시 확인하고 `HUMAN_REVENUE_REVIEW`를 승인해야 합니다.
- 음원·가창·게임 음악은 사람이 다시 확인하고 `HUMAN_MUSIC_REVIEW`를 승인해야 합니다.
- 제3자가 화면·음성·통화·채팅 등에 등장하면 그 제3자와 소속 그룹의 정책을 교차확인합니다.
- 접근할 수 없는 링크는 허용으로 추정하지 않고 `SOURCE_UNREADABLE`로 기록합니다.
- 사람 검수 전 자동 게시·업로드·수익화는 금지합니다.

다섯 그룹 모두 저장소에는 방송인·그룹과 공식 URL 관계만 `LINK_ONLY`로 보존합니다. 작업 시점에 원문을 읽지 못하면 조항을 추정하지 않습니다.

## 생성 규격

프롬프트는 `chzzk-kirinuki-edit-brief/v2`, 작업 폴더 manifest는 `chzzk-kirinuki-codex-job/v2`, 통합 편집기는 `chzzk-kirinuki-editor/v3` 규격을 사용합니다. Codex 작업폴더의 필수 결과 파일은 다음 다섯 개입니다.

- `policy-check.md`
- `edited-preview.mp4`
- `edit-plan.json`
- `subtitles.ko.srt`
- `review-notes.md`

Codex가 프로젝트 폴더의 `AGENTS.md`를 지속 지침으로 읽는 구조를 사용했으며, 시작 요청은 목표·맥락·제약·완료 조건이 한 폴더 안에 모이도록 구성했습니다. 관련 동작은 [Codex 앱 안내](https://learn.chatgpt.com/docs/app), [AGENTS.md 안내](https://learn.chatgpt.com/docs/agent-configuration/agents-md), [프롬프트 작성 안내](https://learn.chatgpt.com/docs/prompting)를 참고했습니다.

## 정확도와 데이터 보존

- 치지직·YouTube VOD에서는 보이는 주 HTML 영상 플레이어의 현재 재생 위치를 밀리초 정밀도로 읽습니다.
- 라이브에서는 치지직 방송 시작 시각, 실제 관측 시각, 플레이어의 라이브 엣지 지연을 합쳐 풀 VOD 기준 선택 시각을 계산하며 원본 미디어 시각도 별도로 보존합니다.
- 치지직 라이브 상태 메타데이터를 읽을 수 없을 때는 HTML 플레이어 시각으로 폴백하므로, 생성 프롬프트의 캡처 방법과 신뢰도를 검수해야 합니다.
- 사이드패널의 작은 캡처 상태는 `chrome.storage.local`, 편집 프로젝트·자막·파일 핸들·붙여넣은 이미지 Blob은 IndexedDB에 자동 저장됩니다.
- 편집기의 수동·5분 자동·복원 직전 임시저장은 프로젝트별 최근 5개만 같은 IndexedDB에 보관합니다. 서버로 전송하지 않으며 Extension 데이터 삭제나 제거 시 함께 사라질 수 있습니다.
- 사이드패널의 **이 기기의 최근 편집**은 IndexedDB에서 제목·최근 시각·항목 수만 읽어 표시합니다. 프로젝트 내용이나 session token을 목록 데이터로 복사하지 않으며 **계속 편집**은 정확한 `projectId`의 현재본만 엽니다.
- 원본 전체, 대표 프레임 픽셀, 이미지 에셋과 최종 렌더는 자막 처리기에 보내지 않습니다. Whisper 모드의 활성 컷 16kHz 오디오는 이 기기의 whisper.cpp와 로컬 하네스만 거칩니다. AudSeg 모드는 같은 PCM을 브라우저 안에서 분석합니다.
- 자동 session token은 현재 편집기 탭·companion 프로세스 메모리에만 두고 loopback endpoint와 자막 방식 선택만 `chrome.storage.local`에 보관합니다.
- 다른 영상 탭으로 이동했을 때 기존 구간과 원본이 섞이지 않도록 플랫폼과 회차·영상 ID 충돌을 감지해 새 기록을 막습니다.
- 같은 채널의 서로 다른 생방송은 `channelId + broadcastStartedAt`으로 구분합니다.
- 같은 YouTube 영상 ID의 watch·Shorts·embed·짧은 URL은 같은 회차로, 서로 다른 ID는 다른 회차로 구분합니다.
- 여러 Chrome 창의 사이드패널은 revision을 확인해 최신 상태를 동기화하며, 입력 중인 텍스트는 다른 창의 변경 위에 보존·재저장합니다.
- Codex 작업 규칙은 원본을 덮어쓰지 않고 미디어를 인터넷 서비스에 업로드하지 않도록 요구합니다.
- 새 프로젝트의 기본 `한국 버튜버 키리누키 · 클린` 스타일은 사용자의 완성본 2개에서 뽑은 190개 표본 프레임을 기준으로 측정한 화면 높이 6.75%의 배경 없는 흰색 `Pretendard ExtraBold` 800, 검정 외곽선, 하단 `y=0.84`입니다. `Paperlogy ExtraBold` 800을 쓰는 한 줄 OFL 대안도 스타일 선택에서 고를 수 있습니다. 사람이 이미 정한 기존 프로젝트 스타일은 유지됩니다.

두 글꼴은 SIL Open Font License 1.1 원문과 출처를 함께 배포합니다. Pretendard는 공식 `v1.3.9` WOFF2를 고정했으며 글꼴 SHA-256은 `dd7c1e156f508eb962acc7a33a7a1896d1e0b71e11156fad96e731689ceb6dc3`, 라이선스 SHA-256은 `d31ddd9f2bed32fd7e302a205cf2380ba0de6529152d239ef99cfb6f261bfc04`입니다. Paperlogy는 공식 commit `8ef35f53b318c7ca914c52b1b382b9a8bad07a61`의 `Paperlogy-8ExtraBold.woff2`를 고정했으며 글꼴 SHA-256은 `5047db061c39ec5ed5c9d0b71c7aaad4b9547ed15ce48d1cd74090169f132bc0`, upstream 라이선스 SHA-256은 `603b2e7ef9effb9037b0b67f0530cacdc05e71a4e569032d7e4d98c2e6763135`입니다. 정확한 소스 링크, bundled license 해시와 준수 문구는 [Third-party notices](legal/THIRD_PARTY_NOTICES.md)를 기준으로 합니다.

`npm run license:check`는 npm 패키지 이름·버전·라이선스, Mediabunny 대응 소스와 MPL 원문, AudSeg MIT 원문, 두 글꼴과 OFL 사본, runtime Whisper·Silero 모델 고지를 fail-closed로 대조합니다. 승인 목록 밖의 패키지나 라이선스가 추가되면 일반 빌드 검증이 실패합니다. 이 검사는 배포 구성의 오픈소스 의무를 자동 점검하는 장치이며, 사용자가 가져오는 영상·음원·이미지의 이용 허가를 대신하지는 않습니다.

저장된 원본 권한이 만료되면 **원본 연결**을 다시 눌러 같은 파일을 선택하세요. 사이드패널의 **모든 로컬 작업 초기화**는 저장된 모든 구간·편집 프로젝트·임시저장·파일 핸들을 지우지만 디스크의 원본 영상과 이미 내보낸 파일은 삭제하지 않습니다. Extension을 제거하면 브라우저에 저장된 프로젝트와 연결 설정이 사라질 수 있습니다.

### 권한과 네트워크

- `activeTab`, `scripting`, `tabs`: 이미 열린 지원 영상 탭과 통신하고 원본 탭을 다시 포커스합니다.
- `clipboardRead`: 사용자가 에셋 패널의 붙여넣기 버튼을 누른 순간 클립보드의 이미지 형식만 읽습니다. 일반 텍스트와 클립보드 기록은 저장하지 않습니다.
- `storage`, `unlimitedStorage`: 선택 구간·편집 프로젝트·자막·에셋·임시저장과 endpoint·모델 설정을 로컬에 보존합니다.
- 치지직 host 권한: LIVE/VOD 메타데이터와 플레이어 시각을 읽습니다.
- YouTube host 권한: watch·Shorts·embed·짧은 URL의 영상 ID와 주 플레이어 시각을 읽습니다.
- loopback host 권한: managed local companion인 `127.0.0.1` 또는 `localhost`에 연결합니다.

자막용 범용 HTTPS host 권한은 없습니다. Whisper companion endpoint는 loopback HTTP만 허용합니다. 자동 session token은 탭을 닫으면 사라지고 저장된 프로젝트·임시저장·Chrome 저장소에는 들어가지 않습니다. AudSeg는 companion과 session을 사용하지 않습니다.

## 알려진 제한

- Extension 자체는 치지직·YouTube 영상을 다운로드하거나 DRM·접근 제한을 우회하지 않습니다. YouTube의 선택적 로컬 획득 CLI도 본인이 소유하거나 다운로드·편집 권한을 받은 VOD에만 사용해야 합니다.
- YouTube는 VOD만 지원합니다. 진행 중인 라이브, 광고 재생 시각, 임의 사이트 내부 iframe은 타임스탬프 대상으로 사용하지 않습니다.
- 입력 컨테이너를 읽을 수 있어도 Chrome이 영상·오디오 코덱을 디코딩하지 못하면 미리보기·자막용 오디오 추출·렌더가 실패할 수 있습니다.
- Linux 기본 경로는 `draft tiny-q5_1`의 로컬 whisper.cpp가 전사하고 로컬 하네스가 STT 타임스탬프 경계를 우선해 초안을 만듭니다. AudSeg 경로는 모델 없이 활동 구간만 만들며 전사를 제공하지 않습니다.
- 선택 컷 오디오는 이 기기 밖으로 전송되지 않습니다. 제품에는 자막용 인터넷 API, API 키 입력, 원격 companion 폴백이 없습니다.
- 주 영상 트랙과 주 오디오 트랙만 사용합니다. 출력은 최대 1920×1080, 최대 60fps이며 VFR 입력은 컷 경계를 보존하는 CFR 출력으로 바뀝니다.
- 이미지 에셋은 PNG·JPEG·WebP·GIF를 지원하며 GIF는 정지 프레임 에셋으로 처리합니다. 같은 시각의 에셋은 선택 가능한 하위 줄로 펼쳐지고, 내보낼 때는 현재 필요한 이미지만 순차 디코드합니다. 동시에 표시되는 이미지의 실제 RGBA 메모리 상한은 256MiB입니다. SVG와 원격 URL만 붙여넣는 방식은 지원하지 않습니다.
- 음성은 고정 1개 레인에서 구간별 음량·뮤트·페이드만 조절합니다. 음원 분리, 다중 오디오 트랙과 플러그인 효과는 제공하지 않습니다.
- 출력은 가능한 경우 H.264/AAC MP4, 그렇지 않으면 VP9/Opus WebM입니다. 하드웨어 인코더가 없으면 Chrome이 제공하는 기본·소프트웨어 인코더로 내려갑니다.
- Chrome의 폴더 저장 API를 쓸 수 없는 환경에서는 영상과 sidecar가 개별 다운로드되고, 영상 출력 전체가 메모리에 머뭅니다. 긴 고해상도 작업은 Chrome 120+의 폴더 저장 경로를 권장합니다.
- 자막이 하나도 없으면 `.ko.srt`는 만들지 않습니다. 영상과 `.kirinuki.json`은 항상 생성합니다.

## 개발 검증

Node.js 20.9 이상에서 편집기 번들, Extension 정적 검증과 단위 테스트를 실행합니다.

```bash
npm run check
```

Chromium/ChromeDriver와 FFmpeg/ffprobe가 있는 릴리스 환경에서는 브라우저 런타임, 키보드·마우스 편집, 실제 A/V 렌더까지 모두 실행합니다.

```bash
npm run check:full
```

기본 테스트는 `whisper-tiny`가 loopback companion만 사용하고 `audseg-local`이 네트워크 없이 결정적인 타이밍 초안을 만드는 계약을 검증합니다. 실제 API 자격증명은 필요하지 않습니다.

릴리스 ZIP은 전체 검증 후 정확한 파일 allowlist만 묶고, SHA-256을 기록한 다음 ZIP을 다시 풀어 Chrome에 실제 로드합니다. 시스템 `zip`과 `unzip`이 필요합니다.

```bash
npm run package
```

등록된 네이버 카페 링크의 현재 HTTP·게시글 식별·본문 접근 상태는 네트워크가 가능한 환경에서 별도로 검사합니다.

```bash
npm run check:policy-links
```

두 번째 명령의 `MATCH`는 URL과 article ID가 연결된다는 뜻일 뿐, 정책 조항이 검증됐다는 뜻은 아닙니다.

## 검증 상태

순수 프로젝트 모델에서는 방송 회차 분리, 사용자 확정 컷 변환, 시간축 매핑, v1/v2→v3 마이그레이션, 투명 이미지 에셋, 다중 자막 레인·cue별 색상과 흰색+최근 5색 레지스터, 자막↔에셋 자석·정확히 맞춤, 구간별 음성 자동화, AI 재실행 시 사람 수정 보존, 컷 재정렬과 SRT 출력을 단위 테스트합니다. 자막 테스트는 `whisper-tiny`의 loopback-only 요청·응답, segment+word anchor canonicalization, 실제 STT word 경계 분할, cue별 품질 gate, pipeline·하네스 체크포인트 지문, AudSeg의 결정적 활동 구간과 4초 상한, `kr-vtuber-clean-v1`의 한 줄·하단·폭·시간·읽기 속도·문장부호 계약을 확인합니다. 브라우저 E2E는 이미지 붙여넣기·겹침 하위 줄·고아 Blob 정리와 재로딩, 자막·에셋 양끝의 실제 포인터 드래그, 0.12초 음소거의 정밀 미리보기 시계, 파일 연결과 IndexedDB 복구를 확인합니다. 합성 영상 E2E는 불투명·반투명·완전 투명 픽셀의 실제 WebCodecs 렌더 결과와 JSON/SRT·최종 ZIP 로드를 확인합니다.

마지막 로컬 검증 환경은 Arch Linux, Node.js 26.4.0, npm 11.18.0, Chromium/ChromeDriver 150.0.7871.46, FFmpeg/ffprobe 8.1.2입니다. 선언한 Node 20.9·Chrome 120 하한은 빌드 target과 API 기준이며 동일 버전 CI 매트릭스에서 직접 실행한 결과는 아닙니다.

제3자 코드와 라이선스·소스 위치는 [Third-party notices](legal/THIRD_PARTY_NOTICES.md)에 기록합니다. 합성 미디어, 실제 음성 샘플, 자격증명과 실제 서비스 응답은 저장소에 포함하지 않습니다.
