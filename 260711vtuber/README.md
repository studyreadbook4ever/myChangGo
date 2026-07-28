# 치지직·YouTube 키리누키 스튜디오 Chrome Extension

치지직 생방송·다시보기 또는 YouTube VOD를 보며 사용할 구간을 표시하고, 같은 Extension의 전체화면 편집기에서 컷·투명 이미지 에셋·구간별 음성·다중 한국어 자막을 검수해 영상을 내보내는 로컬 우선 도구입니다.

사용자가 찍은 시작·끝은 `authority: USER`인 확정 범위입니다. AI는 재미있는 구간을 대신 고르거나 경계를 자동으로 늘리지 않고, 선택된 범위의 한국어 자막 초안만 만듭니다. 텍스트, cue 시작·끝·레인·색상, 영상 위 자막 위치, 구간별 음량과 컷 경계·내부 삭제 범위는 사람이 직접 고칠 수 있습니다.

현재 미디어 입력은 사용 권한이 있는 로컬 원본 파일입니다. Extension은 지원 영상 탭의 메타데이터·현재 시각·재생 위치 제어를 연결하지만 치지직이나 YouTube 영상을 다운로드하거나 접근 제한을 우회하지 않습니다. 원본 전체와 최종 렌더는 이 기기에 남습니다. 사용자가 자막 생성을 명시적으로 실행하면 활성화된 모든 선택 컷의 16kHz 오디오, 제한된 프로젝트 문맥(식별자·프로젝트명·스트리머명·각 컷 메모), 로컬 대표 프레임에서 계산한 숫자형 화면 방해도만 설정한 자막 에이전트로 차례로 전송됩니다. 대표 프레임 픽셀은 전송하지 않습니다.

## 설치

1. Node.js 20.9 이상에서 `npm ci --ignore-scripts && npm run build`를 실행합니다.
2. Chrome 또는 Chromium 120 이상에서 `chrome://extensions`를 엽니다.
3. 우측 상단의 **개발자 모드**를 켭니다.
4. **압축해제된 확장 프로그램을 로드합니다**를 누르고 이 저장소의 `extension` 폴더를 선택합니다.
5. 치지직 영상 또는 YouTube 영상 페이지를 열고 도구 모음의 확장 아이콘을 누르면 사이드패널이 열립니다.

기존에 열려 있던 지원 영상 탭에도 첫 통신 때 콘텐츠 브리지를 주입하므로 대개 새로고침 없이 동작합니다. 브라우저 정책으로 주입이 막힌 경우 해당 탭을 한 번 새로고침하세요.

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
9. 편집기의 **자막 에이전트 연결**에서 endpoint와 세션 토큰을 입력하고 **연결 확인**을 누른 뒤 **활성 컷 전체 Solar 자막**을 실행합니다. 브라우저는 활성화된 모든 선택 컷의 오디오를 각각 16kHz WAV로 만들고 제한된 프로젝트 문맥과 함께 설정한 자막 에이전트에 차례로 보냅니다. 대표 프레임은 로컬에서만 저해상도 분석하고 픽셀 대신 시간별 화면 방해도 점수를 보냅니다.
10. `영상 → 에셋 → 음성 → 자막` 타임라인에서 이미지·자막·음성을 검수합니다. 영상 중간을 덜어낼 때는 재생헤드에서 `시작 [I]`와 `끝 [O]`을 찍고 **구간 삭제**를 누릅니다. 삭제 뒤 영상과 연결된 에셋·음성·자막은 함께 당겨집니다. 웹 이미지 자체를 복사한 뒤 편집기에서 `Ctrl/Cmd+V`를 누르면 현재 위치에 에셋으로 들어가며 PNG·WebP의 투명 영역도 보존됩니다. 자막 레인은 기본 2개이며 `+`로 늘릴 수 있습니다.
11. 큰 편집 전에는 **지금 임시저장**을 누를 수 있습니다. 편집기는 5분마다 자동 임시저장하며, **저장 목록**에서 이 기기의 최근 5개 중 하나를 고르면 현재 상태를 먼저 임시저장한 뒤 불러옵니다.
12. **영상 내보내기**에서 폴더를 한 번 고르면 선택 컷·이미지 에셋·자막이 들어간 MP4 또는 WebM, 프로젝트 JSON, 자막이 있을 때의 SRT가 같은 폴더에 저장됩니다.

긴 원본을 통째로 메모리에 복사하지 않습니다. 미리보기·자막용 오디오 추출·렌더링은 사용자가 선택한 구간을 기준으로 디스크에서 필요한 부분만 읽습니다.

자막 에이전트는 선택 컷 오디오를 외부 STT로 전사한 다음, 타임코드가 있는 전사문을 Upstage Solar에 보내 의미 단위 cue로 정리합니다. `solar-pro3`는 품질 우선으로 `reasoning_effort: high`와 최소 16,384 completion token 예산을 사용하고, `solar-mini`는 빠른 초벌용으로 reasoning 필드를 보내지 않습니다. 둘 다 음성을 직접 전사하는 모델이 아니므로 시간 정보가 있는 STT가 반드시 필요합니다. 편집기는 각 컷의 대표 프레임 7장을 이 기기에서만 축소 분석해 top·center·bottom의 방해도 점수를 만들고, Solar는 cue 시각에 가까운 점수를 바탕으로 위치를 고릅니다. 결과는 인식된 발화를 빠뜨리지 않고 cue당 최대 4초로 나누며, 문장 끝 마침표는 제거하되 물음표 등 의미 있는 문장부호는 유지하는 검수용 초안입니다.

한 번의 실행은 활성 컷 최대 500개, 새 AI cue 최대 10,000개로 제한합니다. 모델의 context보다 긴 단일 컷 전사문은 Solar 요청이 실패할 수 있으므로 긴 장면은 먼저 여러 컷으로 나눠 실행하세요. 더 큰 작업은 활성 컷을 나눠 실행해 브라우저 메모리와 외부 API 비용을 통제하세요.

### 자막 에이전트와 API 키 연결

2026-07-29 현재 Upstage의 [공식 모델 목록](https://console.upstage.ai/docs/models), [API 키 화면](https://console.upstage.ai/api-keys), [API 가격표](https://www.upstage.ai/pricing/api)에는 공개 STT가 없습니다. 따라서 가상의 “Upstage STT” endpoint를 만들지 않고, **호환 외부 STT가 타임스탬프 전사 → Upstage Solar가 자막 cue 정리** 순서로 처리합니다.

편집기에는 다음 값을 입력합니다.

- **자막 에이전트 Endpoint**: 기본값 `http://127.0.0.1:4319/v1/captions`
- **세션 토큰**: companion의 `KIRINUKI_AGENT_TOKEN`과 같은 값
- **Solar 모델**: 품질 우선 `solar-pro3`(기본값) 또는 빠른 초벌 `solar-mini`
- **STT API 주소·모델명·API 키**: 사용 중인 호환 STT 제공자의 값
- **Upstage API 키**: Solar Chat API를 호출할 키

자막 에이전트 endpoint·Solar 모델·STT 주소·STT 모델명 같은 비밀이 아닌 설정만 `chrome.storage.local`에 저장됩니다. 세션 토큰과 두 API 키는 프로젝트·임시저장·IndexedDB·Chrome 저장소에 넣지 않고 현재 편집기 탭의 메모리에만 둡니다. **입력한 API 키 지우기**로 즉시 비울 수 있습니다. 제공자 API 키는 비어 있지 않은 Bearer 세션 토큰과 함께 `127.0.0.1` 또는 `localhost` companion에만 요청 헤더로 전달하며, 토큰이 없으면 요청 전에 중단하고 원격 HTTPS 자막 에이전트에는 전달하지 않습니다.

Extension ID를 `chrome://extensions`에서 확인하고, reference gateway는 최소한 다음처럼 실행합니다.

```bash
export KIRINUKI_ALLOWED_ORIGIN='chrome-extension://<확장프로그램-ID>'
export KIRINUKI_AGENT_TOKEN='<충분히 긴 임의 토큰>'
npm run caption-gateway
```

gateway는 `127.0.0.1`에만 바인딩됩니다. `KIRINUKI_ALLOWED_ORIGIN`에는 와일드카드가 아니라 현재 Extension의 정확한 origin 하나를 지정하고, 편집기에 같은 세션 토큰과 STT·Upstage 값을 넣은 뒤 **연결 확인**을 누르세요. 로컬 companion 프로세스나 해당 포트를 신뢰할 수 없는 환경에서는 API 키를 편집기에 넣지 말고 아래 환경 변수 방식으로 companion에 직접 보관하세요.

Solar Chat의 공식 입력은 텍스트이므로 **Upstage API 키 하나만 입력한 raw audio 요청은 준비 완료로 표시하지 않습니다.** gateway core에는 검증된 로컬 STT를 연결할 수 있는 `transcribeAudio` 경계가 있지만 이 저장소는 로컬 음성인식 모델을 번들하지 않습니다. 기본 reference gateway는 외부 timed STT 주소·키가 빠지면 `TIMED_STT_REQUIRED`로 중단하며, WAV를 Solar Chat 요청에 넣는 가상의 폴백은 사용하지 않습니다.

API 키를 편집기에 매번 넣고 싶지 않다면 companion 환경 변수에 두는 기존 방식도 지원합니다.

```bash
export KIRINUKI_STT_ENDPOINT='https://<STT-제공자>/v1/audio/transcriptions'
export KIRINUKI_STT_API_KEY='<STT-API-키>'
export KIRINUKI_STT_MODEL='<STT-모델-이름>'
export UPSTAGE_API_KEY='<Upstage-API-키>'
export KIRINUKI_SOLAR_MODEL='solar-pro3'
export KIRINUKI_AGENT_PORT='4319'
# 선택: 전체 파이프라인 제한시간(ms), 최대 20분
export KIRINUKI_PIPELINE_TIMEOUT_MS='900000'
```

호환 STT endpoint에는 Bearer 인증과 함께 multipart `file`, `model`, `language=ko`, `response_format=verbose_json`, `timestamp_granularities[]=segment`, `timestamp_granularities[]=word`를 보냅니다. 응답은 시간 정보가 있는 `segments`, `chunks` 또는 `words` JSON이어야 합니다. 편집기에서 입력한 endpoint는 비밀이 아닌 설정으로 저장되므로 사용자 정보·API 키·쿼리 문자열을 URL에 넣지 못하며 키는 전용 API 키 필드에만 입력합니다. 제공자별 API 계약·보존 정책·비용을 확인하세요. Solar 호출 규격은 Upstage의 [Chat API Reference](https://console.upstage.ai/api/chat)와 [Structured outputs](https://console.upstage.ai/docs/capabilities/generate/structured-outputs)를 따릅니다.

### YouTube 타임스탬프 지원

- `youtube.com/watch?v=...`, `youtu.be/...`, `youtube.com/shorts/...`, 최상위 탭으로 연 `youtube.com/embed/...`를 지원합니다.
- 같은 영상 ID의 watch·짧은 주소·Shorts·embed는 한 프로젝트 소스로 취급하고 안정적인 watch URL로 정규화합니다.
- 보이는 주 영상의 `currentTime`을 밀리초 단위로 읽으며, 광고 재생 중에는 광고 시각이 섞이지 않도록 캡처·시각 제어를 막습니다.
- 진행 중인 YouTube 라이브와 다른 사이트 안의 YouTube iframe은 지원하지 않습니다. 종료되어 유한한 길이로 재생되는 영상은 VOD로 사용할 수 있습니다.
- Extension은 YouTube 미디어를 내려받지 않습니다. 편집·렌더에는 본인이 소유하거나 사용 허가를 받은 로컬 원본을 별도로 연결해야 합니다.

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
├── policy-cache/         # 선택 캐시; 원문 접근 실패 시에만 참고
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

[정책 인덱스](extension/knowledge/creator-policy-index.json)가 치지직에서 읽은 방송인 이름을 아티스트 목록과 **정확 일치**로 연결합니다. 예를 들어 `아리사`는 `카론유니버스W`와 `https://cafe.naver.com/vkpopstar/1174`에 매칭됩니다. 생성 프롬프트에는 이 관계와 공식 URL만 넣고, Codex는 작업 시점에 원문을 다시 확인합니다. 부분 문자열이나 동명이인 추정은 사용하지 않습니다.

확인 당시 본문은 [선택 정책 캐시](extension/knowledge/creator-policies/charon-universe-w.md)로 보존할 수 있지만 프롬프트에 통째로 삽입하지 않습니다. 작업폴더에서는 `policy-cache/`에 별도 저장되며, 원문 접근 실패 시의 참고자료일 뿐입니다. 캐시와 최신 원문이 다르면 최신 원문이 우선하고 공개 상태는 계속 사람 검수로 남습니다.

방송인·소속사의 최신 공식 정책이 기본 규정보다 우선하지만, 다음은 예외 없이 적용합니다.

- 수익·상업 이용은 사람이 다시 확인하고 `HUMAN_REVENUE_REVIEW`를 승인해야 합니다.
- 음원·가창·게임 음악은 사람이 다시 확인하고 `HUMAN_MUSIC_REVIEW`를 승인해야 합니다.
- 제3자가 화면·음성·통화·채팅 등에 등장하면 그 제3자와 소속 그룹의 정책을 교차확인합니다.
- 접근할 수 없는 링크는 허용으로 추정하지 않고 `SOURCE_UNREADABLE`로 기록합니다.
- 사람 검수 전 자동 게시·업로드·수익화는 금지합니다.

2026-07-11 일반 텍스트 검사에서는 다섯 URL 모두 해당 네이버 카페와 article ID 연결까지 확인됐지만 게시글 본문 대신 JavaScript 앱 셸만 반환됐습니다. 2026-07-12 실제 Chromium 렌더링으로 카론유니버스W 본문 1,781자를 확인해 선택 캐시와 해시를 등록했습니다. 나머지 네 그룹은 여전히 `LINK_ONLY / SOURCE_UNREADABLE / UNVERIFIED`이며, 작업 시점에 원문을 읽지 못하면 조항을 추정하지 않습니다.

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
- 원본 전체, 대표 프레임 픽셀, 이미지 에셋과 최종 렌더는 자막 에이전트에 보내지 않습니다. 사용자가 **활성 컷 전체 Solar 자막**을 누르면 활성화된 모든 선택 컷의 16kHz 오디오와 프로젝트 식별자·이름, 스트리머명, 각 컷 메모, 로컬에서 계산한 시간별 top·center·bottom 방해도 점수가 설정한 endpoint로 차례로 전송됩니다. reference gateway는 각 음성을 외부 STT에 보내고, timed transcript와 이름·메모 문맥·숫자형 위치 요약을 Upstage에 보냅니다.
- 세션 토큰과 Upstage·외부 STT API 키는 저장하지 않습니다. API 키는 현재 편집기 탭 메모리 또는 companion 환경 변수에만 두고, endpoint와 모델 선택만 `chrome.storage.local`에 보관합니다.
- 다른 영상 탭으로 이동했을 때 기존 구간과 원본이 섞이지 않도록 플랫폼과 회차·영상 ID 충돌을 감지해 새 기록을 막습니다.
- 같은 채널의 서로 다른 생방송은 `channelId + broadcastStartedAt`으로 구분합니다.
- 같은 YouTube 영상 ID의 watch·Shorts·embed·짧은 URL은 같은 회차로, 서로 다른 ID는 다른 회차로 구분합니다.
- 여러 Chrome 창의 사이드패널은 revision을 확인해 최신 상태를 동기화하며, 입력 중인 텍스트는 다른 창의 변경 위에 보존·재저장합니다.
- Codex 작업 규칙은 원본을 덮어쓰지 않으며, 자막 생성 UI에서 명시적으로 허용한 선택 컷 오디오 외에는 외부 서비스에 미디어를 업로드하지 않도록 요구합니다.
- 새 프로젝트의 기본 자막은 이전 5.2% 기준보다 약 30% 큰 화면 높이 6.75%의 배경 없는 흰색 `Pretendard ExtraBold`로 표시합니다. 기존 저장 프로젝트에서 이미 정한 크기는 그대로 유지합니다. 저장소에는 공식 Pretendard 1.3.9 WOFF2 원본과 SIL Open Font License 1.1 고지를 함께 포함합니다.

저장된 원본 권한이 만료되면 **원본 연결**을 다시 눌러 같은 파일을 선택하세요. 사이드패널의 **모든 로컬 작업 초기화**는 저장된 모든 구간·편집 프로젝트·임시저장·파일 핸들을 지우지만 디스크의 원본 영상과 이미 내보낸 파일은 삭제하지 않습니다. Extension을 제거하면 브라우저에 저장된 프로젝트와 연결 설정이 사라질 수 있습니다.

### 권한과 네트워크

- `activeTab`, `scripting`, `tabs`: 이미 열린 지원 영상 탭과 통신하고 원본 탭을 다시 포커스합니다.
- `clipboardRead`: 사용자가 에셋 패널의 붙여넣기 버튼을 누른 순간 클립보드의 이미지 형식만 읽습니다. 일반 텍스트와 클립보드 기록은 저장하지 않습니다.
- `storage`, `unlimitedStorage`: 선택 구간·편집 프로젝트·자막·에셋·임시저장과 endpoint·모델 설정을 로컬에 보존합니다.
- 치지직 host 권한: LIVE/VOD 메타데이터와 플레이어 시각을 읽습니다.
- YouTube host 권한: watch·Shorts·embed·짧은 URL의 영상 ID와 주 플레이어 시각을 읽습니다.
- loopback host 권한: 기본 reference gateway인 `127.0.0.1` 또는 `localhost`에 연결합니다.
- 선택적 HTTPS host 권한: 사용자가 다른 자막 에이전트 endpoint를 설정하고 연결을 실행할 때 그 정확한 origin에 대한 권한을 Chrome에서 요청합니다. 일반 `http` endpoint는 loopback만 허용합니다.

편집기에 직접 입력한 세션 토큰과 API 키는 탭을 닫으면 사라지고, 저장된 프로젝트·임시저장·Chrome 저장소에는 들어가지 않습니다. 제공자 키를 직접 입력하는 경로는 인증된 loopback companion에만 허용됩니다.

## 알려진 제한

- 치지직·YouTube 영상을 다운로드하거나 DRM·접근 제한을 우회하지 않습니다. 본인이 소유하거나 사용 허가를 받은 로컬 원본이 필요합니다.
- YouTube는 VOD만 지원합니다. 진행 중인 라이브, 광고 재생 시각, 임의 사이트 내부 iframe은 타임스탬프 대상으로 사용하지 않습니다.
- 입력 컨테이너를 읽을 수 있어도 Chrome이 영상·오디오 코덱을 디코딩하지 못하면 미리보기·자막용 오디오 추출·렌더가 실패할 수 있습니다.
- Upstage에는 이 흐름에 사용할 공개 STT가 없고 Solar Pro 3는 텍스트 모델이라 음성을 직접 전사할 수 없습니다. 자막 생성에는 호환되는 별도 외부 STT와 네트워크 연결이 필요합니다.
- 자막 생성 시 선택 컷 오디오가 설정한 STT 제공자와 timed transcript가 Upstage로 전송됩니다. 각 제공자의 보존 정책·지역·요금·rate limit을 확인하고, 민감한 방송은 보내기 전에 동의를 검토하세요.
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

기본 테스트의 자막 에이전트·gateway 검증은 mock 네트워크를 사용하므로 실제 STT나 Upstage API 키가 필요하지 않습니다. 실제 서비스 연결은 별도 자격증명과 비용·개인정보 정책을 확인한 환경에서 편집기의 **연결 확인**으로 검증하세요.

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

순수 프로젝트 모델에서는 방송 회차 분리, 사용자 확정 컷 변환, 시간축 매핑, v1/v2→v3 마이그레이션, 투명 이미지 에셋, 다중 자막 레인·cue별 색상, 구간별 음성 자동화, AI 재실행 시 사람 수정 보존, 컷 재정렬과 SRT 출력을 단위 테스트합니다. 자막 에이전트 테스트는 `chzzk-kirinuki-caption-*/v1` 요청·응답, 최대 4초 cue와 잘못된 응답 거부를 확인하고, reference gateway 테스트는 origin·세션 토큰 검증과 외부 STT·Solar 응답 처리를 mock으로 확인합니다. 브라우저 E2E는 이미지 붙여넣기·겹침 하위 줄·고아 Blob 정리와 재로딩, 자막·에셋 양끝의 실제 포인터 드래그, 0.12초 음소거의 정밀 미리보기 시계, 파일 연결과 IndexedDB 복구를 확인합니다. 합성 영상 E2E는 불투명·반투명·완전 투명 픽셀의 실제 WebCodecs 렌더 결과와 JSON/SRT·최종 ZIP 로드를 확인합니다.

마지막 로컬 검증 환경은 Arch Linux, Node.js 26.4.0, npm 11.18.0, Chromium/ChromeDriver 150.0.7871.46, FFmpeg/ffprobe 8.1.2입니다. 선언한 Node 20.9·Chrome 120 하한은 빌드 target과 API 기준이며 동일 버전 CI 매트릭스에서 직접 실행한 결과는 아닙니다.

제3자 코드와 라이선스·소스 위치는 [Third-party notices](legal/THIRD_PARTY_NOTICES.md)에 기록합니다. 합성 미디어, 실제 음성 샘플, 자격증명과 실제 서비스 응답은 저장소에 포함하지 않습니다.
