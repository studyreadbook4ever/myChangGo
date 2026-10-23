# 담다 · 주문 서버와 직원 운영 화면

[고객 키오스크](../261023NSL-client/)의 주문·음성 요청을 처리하는 TypeScript/Cloudflare Workers 서버입니다. D1에 메뉴·세션·주문·전송 상태를 저장하고, 한국어 중심의 직원 화면에서 업무 큐·조리 보드·테이블·문제·고객 지원을 확인합니다.

## 기능

- 음식 주문: CLOVA Speech → Papago 한국어 번역 → CLOVA Studio 메뉴 해석 → 고객 언어 번역. 현재 메뉴 ID와 수량을 검증한 뒤 장바구니에 반영합니다.
- 직원 호출: Speech 원문을 그대로 저장하고 한국어 번역을 함께 표시합니다. Studio로 요청 내용을 다시 쓰지 않습니다.
- 음식은 고객의 확인 토큰·버전·명시적 승인 후에만 주문으로 생성되고 주방·로봇으로 전송됩니다.
- 직원 요청은 직원/주방에 먼저 전달되고 로봇은 `awaiting_staff` 상태로 대기합니다. 직원의 **이 요청 로봇에 전달하기** 동작이 있어야 전송됩니다.
- HMAC 서명 JSON, 수신 ACK, 중복 방지, 전송 재시도, 번역 재시도, 직원 메모와 상태 충돌 검사를 제공합니다.
- 직원 API는 비공개 호스팅 인증 또는 별도 운영 토큰으로 보호합니다. 공개 고객 게이트웨이에 직원 권한을 부여하지 않습니다.

## 실행

Node.js 22.13 이상이 필요합니다. `node:sqlite`를 사용하는 테스트까지 실행할 때는 Node.js 24 이상을 권장합니다.

```sh
npm run install:ci
cp .env.example .dev.vars
npm run build
```

`.dev.vars`에 본인의 값을 설정하고 D1 바인딩 이름을 `DB`로 유지합니다. 빌드가 생성한 `dist/server/wrangler.json`을 사용해 새 로컬 데이터베이스에 다음 마이그레이션을 순서대로 한 번씩 적용합니다.

```sh
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_yellow_living_mummy.sql
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0001_productive_killraven.sql
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0002_lyrical_vargas.sql
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0003_steep_cloak.sql
npm run dev -- --port 5174
```

실행 로그의 로컬 주소를 엽니다. 기본 portable 개발 프로필은 `/signin-with-chatgpt?return_to=/`에서 개발용 로그인만 제공합니다. 실제 배포의 직원 인증은 비공개 Sites 접근 정책에 의존합니다. 빌드 결과를 미리 보려면 `npm start -- --port 5174`를 사용하세요. 도구·프로필·배포의 상세 설명은 [SETUP-SITES.md](SETUP-SITES.md)에 있습니다. 매니페스트는 D1 `DB`만 선언하며 운영 프로젝트 ID는 포함하지 않습니다.

## 설정

[.env.example](.env.example)은 실제 키·주소·소유자 정보가 없는 빈 템플릿입니다. 로컬 값은 Git에서 제외된 `.dev.vars`에, 배포 값은 호스팅 비밀 설정에 넣습니다. `DB`는 문자열 환경변수가 아닌 D1 바인딩입니다.

| 이름 | 용도 |
| --- | --- |
| `DAMDA_GATEWAY_SECRET` | 고객 프로젝트와 같은 최소 32자 공유 비밀 |
| `WEBHOOK_SECRET` | 송신·수신 양쪽에 설정하는 최소 32자 HMAC 비밀 |
| `OPERATOR_TOKEN` | 서버 자동화용 최소 24자 운영 토큰. 인증된 직원 브라우저와는 별도 |
| `STAFF_OWNER_EMAIL` | 플랫폼이 이메일만 제공하는 경우의 선택적 소유자 고정값 |
| `CLOVA_SPEECH_INVOKE_URL`, `CLOVA_SPEECH_SECRET` | Speech 도메인의 Invoke URL과 비밀 키 |
| `CLOVA_SPEECH_MENU_BOOSTING` | 선택적 메뉴 힌트. `true`일 때 한국어·영어의 음식 주문에만 적용, 기본 꺼짐 |
| `PAPAGO_CLIENT_ID`, `PAPAGO_CLIENT_SECRET` | Papago Translation API 자격 증명 |
| `CLOVA_STUDIO_API_KEY`, `CLOVA_STUDIO_MODEL` | Studio 자격 증명과 모델. 모델 생략 시 `HCX-007` |
| `KITCHEN_WEBHOOK_URL`, `ROBOT_WEBHOOK_URL` | 각각의 HTTPS JSON 수신 엔드포인트 |
| `KITCHEN_WEBHOOK_SITES_TOKEN`, `ROBOT_WEBHOOK_SITES_TOKEN` | 수신지가 비공개 Sites인 경우 각각에 보내는 서비스 자격 증명 |
| `KIOSK_CLIENT_DAILY_LIMIT`, `KIOSK_GLOBAL_DAILY_LIMIT` | 선택적 고객별·전체 일일 AI 작업 제한 |

내장 수신 엔드포인트는 `/api/webhooks/orders`입니다. 별도 수신기를 쓸 때도 동일한 이벤트·서명·ACK 계약을 구현해야 합니다. 요청 호스트가 전달한 신원 헤더를 신뢰하는 구조이므로, 플랫폼 인증을 우회할 수 있는 일반 공개 서버에 그대로 노출하지 마세요.

## 테스트

```sh
node --experimental-strip-types --test tests/*.test.mjs
npx tsc --noEmit
```

SQLite 메모리 데이터베이스와 모의 공급자·수신기, 로컬 Worker 런타임으로 승인·중복·서명·권한·수동 로봇 전송·API 계약을 검사합니다. 이 테스트는 실제 NCP 호출이나 실제 주문 전송을 하지 않습니다.

## 범위와 한계

한국어·영어·일본어·중국어를 지원하지만 실제 소음 환경의 인식 정확도를 보장하지 않습니다. 공급자 API와 HTTPS 수신기 설정이 필요하며, 현재 TTS는 항상 비활성화되어 Voice/Dubbing 키를 사용하지 않습니다. 메뉴 힌트는 선택적 실험 기능으로 실제 인식 개선이 보장되지 않습니다. 결제·물리 로봇·주방 장비 제어는 포함하지 않고 JSON 전달과 수신 화면까지만 구현합니다. 재시도 작업은 관련 API 조회·직원 조작에 의해 실행되며 독립적인 상시 스케줄러는 포함하지 않습니다.

자체 코드는 [Unlicense](LICENSE), 제3자 구성요소는 [별도 고지](THIRD_PARTY_NOTICES.md)를 따릅니다.
