# 260715LlmOrchestrator

> [!IMPORTANT]
> **이 코드는 한글 문서 생성용 코드입니다.** 개념명, 요약, 본문, 하위개념을 한국어로 생성하도록 프롬프트와 검증 규칙이 고정되어 있습니다.

저가형·로컬·소버린 LLM을 반복 호출해 하나의 개념을 교육적인 하위개념 트리로 완전 Eager 생성하고, 같은 콘텐츠에서 정적 HTML 사이트와 독립적인 Markdown 문서를 만드는 Linux CLI입니다. 웹 검색은 기본으로 켜져 있으며, 각 문서의 핵심 주장에 사용한 웹 근거를 함께 표시합니다.

이 프로젝트는 실행 중 질문에 답하는 RAG 서비스가 아닙니다. `ask` 명령, 채팅 UI, 벡터 검색은 제공하지 않습니다. 생성된 HTML·Markdown 문서는 나중에 별도의 RAG 코퍼스로 사용할 수 있습니다.

## 핵심 동작

```text
최초 한국어 개념
  → 웹 검색 및 공개 페이지 근거 수집
  → 요약·본문·최대 4개 하위개념 생성
  → 의미 중복 판정과 기존 노드 재사용
  → 같은 깊이의 노드를 병렬 생성
  → 지정 깊이까지 전부 Eager 확장
  → HTML + Markdown + sitemap.txt 원자적 게시
```

- 최초 개념은 필수 위치 인자입니다. 입력하지 않으면 실행되지 않습니다.
- 깊이 기본값은 `3`, 노드당 하위개념 기본 상한은 `4`입니다.
- 내부 노드는 교육적으로 상위 개념을 이해하는 데 중요한 **실제 하위개념**만 제안하도록 지시합니다.
- 한 부모의 자식들은 하나의 동일한 분해 기준과 비슷한 추상화 수준을 갖도록 지시합니다.
- 근거 있는 하위개념이 4개보다 적으면 억지로 채우지 않습니다.
- 최대 깊이의 leaf는 하위개념을 만들지 않으며, HTML에도 빈 링크 영역을 만들지 않습니다.
- LLM은 콘텐츠와 하위개념 후보를 구조화된 JSON으로 반환할 뿐 HTML을 작성하지 않습니다.
- 프로그램이 하나의 Markdown·LaTeX 원본을 HTML과 Markdown으로 결정적으로 렌더링합니다.

## Eager 깊이와 비용

루트를 깊이 `0`으로 봅니다. 분기 상한을 `b`, 깊이를 `d`라 하면 이론상 최대 노드 수는 다음과 같습니다.

```text
b = 1: d + 1
b > 1: (b^(d + 1) - 1) / (b - 1)
```

기본 분기 상한 `4`일 때:

| `--depth` | 계층 | 이론상 최대 노드 |
|---:|---|---:|
| 0 | 1 | 1 |
| 1 | 1 + 4 | 5 |
| 2 | 1 + 4 + 16 | 21 |
| 3 | 1 + 4 + 16 + 64 | 85 |
| 4 | 위 계층 + 256 | 341 |
| 5 | 위 계층 + 1,024 | 1,365 |
| 6 | 위 계층 + 4,096 | 5,461 |

실제 고유 문서 수는 자식 부족, 의미 중복 병합, 실패한 비루트 노드 때문에 더 적을 수 있습니다. 기본 `--review-mode strict`는 각 유효한 생성 초안에 별도 LLM 근거 검수를 한 번 더 요청하므로, 깊이 3은 생성·검수만 이론상 최대 약 170회이며 의미 중복 판정과 재시도 호출이 추가될 수 있습니다. 웹 검색과 페이지 가져오기도 노드별로 수행됩니다.

`--dry-run`으로 네트워크 호출 전에 규모를 확인하십시오. 기본 `--max-nodes 5000`을 넘는 실행은 중단되며, `--force`는 안전선만 해제할 뿐 비용이나 시간을 제한하지 않습니다.

```bash
llm-orchestrator "운영체제" --depth 3 --dry-run
```

## 요구 사항과 설치

- Linux 터미널 셸
- Python 3.11 이상
- 기본 웹 검색을 위한 인터넷 연결
- `/v1/chat/completions`를 제공하는 OpenAI-compatible LLM 서버 또는 API

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -e .
llm-orchestrator --help
```

개발·테스트 의존성까지 설치하려면 다음을 사용합니다.

```bash
python -m pip install -e '.[dev]'
```

## 빠른 시작

OpenAI-compatible 서버의 `/v1` 기준 URL과 모델명을 지정합니다. API 키가 필요한 원격 서버라면 환경 변수에 넣습니다.

```bash
export LLM_BASE_URL='https://llm.example.com/v1'
export LLM_MODEL='YOUR_MODEL_NAME'
export LLM_API_KEY='YOUR_SECRET_KEY'

llm-orchestrator "운영체제" \
  --depth 3 \
  --output generated-site \
  --site-url 'https://docs.example.com/os/'
```

완료 후 `generated-site/index.html`을 정적 파일 서버로 확인할 수 있습니다.

```bash
python -m http.server 8000 --directory generated-site
```

브라우저에서 `http://127.0.0.1:8000/`을 엽니다.

### 키 없이 파이프라인 확인

`mock` 공급자는 설치·재귀·렌더링·재개 흐름을 확인하기 위한 결정적 데모입니다. 내용과 출처는 사실 자료가 아니며, `--search-provider mock`과 함께 쓰면 실제 웹 요청도 하지 않습니다.

```bash
llm-orchestrator "운영체제" \
  --provider mock \
  --search-provider mock \
  --depth 1 \
  --output demo-site \
  --work-dir .demo-work
```

## 로컬·소버린 LLM 연결

프로그램은 특정 회사나 모델 SDK에 묶이지 않습니다. 다음 요청·응답 계약을 만족하는 서버라면 연결할 수 있습니다.

- `--base-url` 아래의 `chat/completions` 엔드포인트
- OpenAI Chat Completions 형식의 `model`, `messages`, `temperature`, `max_tokens` 요청
- `choices[0].message.content`에 JSON 객체를 담은 응답
- 한국어 지시 이해, Markdown·LaTeX 작성, JSON 형식 준수 능력

예를 들어 Ollama의 OpenAI-compatible 기본 URL은 `http://127.0.0.1:11434/v1`입니다. 설치한 실제 모델 태그를 `--model`에 넣습니다.

```bash
llm-orchestrator "운영체제" \
  --base-url 'http://127.0.0.1:11434/v1' \
  --model 'YOUR_OLLAMA_MODEL_TAG'
```

같은 방식으로 llama.cpp `llama-server`는 일반적으로 `http://127.0.0.1:8080/v1`, vLLM OpenAI-compatible server는 구성에 따라 `http://127.0.0.1:8000/v1` 같은 URL을 사용할 수 있습니다. 실제 포트와 모델명은 각 서버 설정을 따르십시오.

- [Ollama OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility)
- [llama.cpp HTTP server](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)
- [vLLM OpenAI-compatible server](https://docs.vllm.ai/en/latest/serving/online_serving/)

로컬 서버가 인증을 요구하지 않으면 `LLM_API_KEY`는 비워 둘 수 있습니다. `--api-key-env`에는 비밀값이 아니라 **비밀값을 담은 환경 변수의 이름**을 전달합니다.

저가형 모델에는 낮은 `--temperature`, 작은 `--max-sources`, 충분한 `--max-tokens`, 적절한 `--retries`가 유리합니다. 로컬 추론 서버가 동시 요청을 잘 처리하지 못하면 `--jobs 1`로 낮추십시오. 형식 오류가 반복되면 모델의 JSON 지시 준수 능력과 컨텍스트 길이를 먼저 확인하십시오.

## 웹 근거와 출처

웹 검색은 기본 활성화됩니다. `--search-provider auto`의 선택 우선순위는 다음과 같습니다.

1. `BRAVE_SEARCH_API_KEY` 또는 `--brave-api-key-env`로 지정한 환경 변수에 키가 있으면 Brave Search
2. `SEARXNG_URL` 또는 `--searxng-url`이 있으면 자체 SearXNG
3. 그 외에는 키가 필요 없는 DDGS

### DDGS 기본 사용

별도 검색 설정이 없으면 DDGS를 사용합니다.

```bash
llm-orchestrator "운영체제" \
  --base-url "$LLM_BASE_URL" \
  --model "$LLM_MODEL"
```

### SearXNG 사용

SearXNG 인스턴스는 JSON 검색 응답을 허용해야 합니다.

```bash
export SEARXNG_URL='https://search.example.com'

llm-orchestrator "운영체제" \
  --search-provider searxng \
  --base-url "$LLM_BASE_URL" \
  --model "$LLM_MODEL"
```

### Brave Search 사용

```bash
export BRAVE_SEARCH_API_KEY='YOUR_BRAVE_SEARCH_KEY'

llm-orchestrator "운영체제" \
  --search-provider brave \
  --base-url "$LLM_BASE_URL" \
  --model "$LLM_MODEL"
```

검색 결과에는 `S1`, `S2` 같은 ID가 붙습니다. LLM은 제공된 ID만 `[S1]` 형태로 인용하도록 지시받고, 프로그램은 알려지지 않은 ID를 거부합니다. 최종 HTML과 Markdown의 `참고 자료`에는 실제 본문에서 사용한 출처만 URL과 확인 날짜와 함께 표시됩니다. 기본 `strict` 모드에서는 같은 근거를 이용한 별도 LLM 검수도 수행합니다.

fenced code와 inline code 안의 `[S1]`은 인용으로 세지 않으며 HTML 링크로 바꾸지도 않습니다. 코드 예제가 근거 인용을 가장하는 일과 코드 원문 변형을 막기 위한 동작입니다.

웹을 끄려면 모델 자체 지식 사용을 명시적으로 허용해야 합니다.

```bash
llm-orchestrator "운영체제" \
  --no-web \
  --allow-ungrounded \
  --base-url "$LLM_BASE_URL" \
  --model "$LLM_MODEL"
```

`--allow-ungrounded`는 웹이 켜져 있어도 근거 필수 검증을 완화합니다. 근거가 중요한 작업에서는 사용하지 않는 편이 좋습니다. 현재 버전은 로컬 문서 입력, PDF 파싱, 스캔 OCR을 지원하지 않습니다. DNS가 전역 공개 IP로 확인된 HTTP(S)의 HTML·XHTML·일반 텍스트 페이지만 가져옵니다.

## 생성 콘텐츠 계약

노드 하나에 대해 모델은 다음 내용을 생성합니다.

- 표준화된 한국어 개념명
- 기본 100자 이하, 최대 3문장의 요약
- 보통 2,000자 안팎, 절대 5,000자 이하의 Markdown 본문
- 개요·핵심 원리·단계적 설명을 담는 2~5개 H2 절
- terminal이 아닐 때 동일 기준으로 분해된 최대 4개 하위개념과 짧은 정의
- 제공된 웹 출처 ID를 사용한 인용
- 코드가 있다면 언어명이 붙은 fenced code block
- 수식이 있다면 `$...$` 또는 `$$...$$` LaTeX

길이 상한, 한국어 포함 여부, 출처 ID, terminal의 빈 자식, 자식 수와 분해 기준을 프로그램이 검증합니다. 오류가 있으면 검증 피드백을 붙여 `--retries`만큼 다시 요청합니다. 루트 생성이 끝내 실패하면 전체 빌드가 실패하고, 비루트 노드가 실패하면 해당 링크를 제거한 뒤 완성된 노드만 게시합니다.

## HTML과 Markdown 출력

기본 `--format both` 출력 예시는 다음과 같습니다.

```text
generated-site/
├── index.html
├── pages/
│   └── <개념-slug>-<node-id>.html
├── assets/
│   └── site.css
├── markdown/
│   ├── index.md
│   └── <개념-slug>-<node-id>.md
└── sitemap.txt
```

- `--format html`: HTML, CSS, `sitemap.txt`만 생성
- `--format md`: `markdown/`의 Markdown만 생성하며 `sitemap.txt`는 만들지 않음
- `--format both`: 두 형식을 모두 생성

Markdown은 YAML front matter, raw HTML 태그, 내부 실행 JSON이 없는 독립 문서입니다. 제목, 요약, 생성기가 만든 하위개념 상대 링크, 본문, 참고 자료만 포함합니다. LLM이 별도 HTML 문서를 만들거나 HTML에서 Markdown을 역변환하지 않습니다.

LLM이 작성한 본문의 Markdown 링크와 이미지는 외부 추적, 위험한 URL, 깨진 내부 경로를 막기 위해 검증 단계에서 거부합니다. 출처 링크와 하위개념 링크는 검증된 구조화 데이터로 생성기가 별도 추가하며, 모델은 본문에서 링크 없는 `[S1]` 인용 토큰만 사용합니다.

본문의 fenced code 안에 든 HTML 예시는 코드 그대로 보존하지만, 일반 문단의 raw HTML은 여러 줄 태그를 포함해 검증 단계에서 거부합니다. 제목·요약·출처명처럼 생성기가 Markdown에 덧붙이는 외부 문자열도 escape합니다.

HTML 페이지도 제목, 요약, 실제 완성된 자식 링크, 본문, 사용한 참고 자료만 담습니다. breadcrumb, 이전·다음 버튼, 전체 트리 지도, 검색창, 채팅창은 기본 출력에 없습니다. 자식이 하나도 없는 노드에는 하위개념 `<nav>`와 링크 버튼을 생성하지 않습니다.

### 수식은 공유 원본을 사용합니다

LLM 호출을 HTML용과 Markdown용으로 나누지 않습니다. 한 번 생성한 LaTeX 원문을 Markdown에는 그대로 보존하고, HTML에는 `.math.inline` 또는 `.math.block` 의미 래퍼로 렌더링합니다. 따라서 HTML 수식을 다시 OCR해 Markdown으로 복원하는 병목이 없습니다.

현재 출력은 MathJax나 KaTeX JavaScript를 강제하지 않습니다. 배포자가 원하는 수식 렌더러를 템플릿 후처리나 정적 사이트 파이프라인에서 연결할 수 있습니다. 원본 LaTeX는 Markdown 작업물과 작업 폴더의 draft에 남습니다.

## CSS 교체와 semantic class

기본 데모 CSS가 `assets/site.css`로 복사됩니다. 이 CSS는 기능 확인을 위한 예시일 뿐이며, 원하는 CSS 파일을 `--css`로 지정하면 그 파일이 같은 경로에 복사됩니다.

```bash
llm-orchestrator "운영체제" \
  --css ./my-theme.css \
  --base-url "$LLM_BASE_URL" \
  --model "$LLM_MODEL"
```

inline style은 생성하지 않습니다. 사용자 CSS가 의존할 수 있는 클래스 계약은 다음과 같습니다.

| 선택자 | 의미 | 생성 조건 |
|---|---|---|
| `.concept-page` | 페이지 전체의 `<main>` 래퍼 | 항상 |
| `.concept-article` | 한 개념 문서의 `<article>` | 항상 |
| `.concept-title` | 개념 H1 제목 | 항상 |
| `.concept-summary` | 짧은 요약 | 항상 |
| `.concept-children` | 하위개념 링크 `<nav>` | 완성된 자식이 있을 때만 |
| `.concept-child-link` | 자식 문서로 가는 링크 버튼 | 자식마다 |
| `.concept-body` | Markdown에서 렌더링한 긴 본문 | 항상 |
| `.concept-references` | 사용한 출처 목록 | 인용한 출처가 있을 때만 |
| `.reference-date` | 출처 확인 날짜 | 출처마다 |
| `.math.inline` | 인라인 LaTeX 수식 | 수식이 있을 때 |
| `.math.block` | 블록 LaTeX 수식 | 수식이 있을 때 |

LLM이 반환한 제목·요약은 HTML escape하고, 본문 렌더러는 raw HTML을 비활성화합니다. 사용자 CSS는 신뢰된 로컬 파일로 간주하므로 배포 전에 직접 검토하십시오.

## 의미 중복과 DAG형 연결

같은 개념이 다른 가지에서 다시 나오면 새 문서를 무조건 만들지 않습니다.

1. 유니코드·대소문자·공백을 정규화한 이름이 같으면 기존 노드를 재사용합니다. 단, `+`, `#`, 식별자 내부의 `.`은 보존해 C/C++, F/F#, .NET/NET을 구분합니다.
2. 이름과 정의가 비슷한 기존 노드를 값싼 문자열·단어 유사도로 최대 5개 추립니다.
3. 최대 5개 후보를 한 번의 batch LLM 요청으로 보내 각각 `same`, `broader`, `narrower`, `related`, `distinct`, `uncertain` 중 하나로 판정합니다.
4. 오직 `same`이면서 `--duplicate-threshold` 이상일 때만 병합합니다.
5. 다른 표기는 canonical 노드의 alias로 기록하고, 새 부모도 같은 문서를 가리킵니다.

상하위·관련·동음이의 개념은 병합하지 않도록 프롬프트에 강하게 명시되어 있습니다. 병합된 한 노드가 여러 부모를 가질 수 있으므로 저장 관계와 링크는 단일 부모 트리보다 DAG형 지식 맵에 가깝고, `sitemap.txt`에는 canonical HTML 문서가 한 번만 들어갑니다.

다만 작은 모델의 의미 판정은 완전하지 않습니다. 특히 **정규화된 이름이 정확히 같으면 LLM 판정 전에 재사용**하므로 같은 표기의 동음이의 개념은 작업 상태와 결과 링크를 반드시 점검하십시오. 이 프로그램은 온톨로지의 무순환성이나 분류 타당성을 수학적으로 증명하지 않습니다. 생성·검수·중복 판정 원문은 작업 폴더에 남아 사후 감사를 할 수 있습니다.

## 중단, raw 보존, 재개, 원자적 게시

별도 SQLite 데이터베이스는 사용하지 않습니다. 작업 디렉터리가 append 가능한 기록과 재개 상태를 담당합니다.

```text
.llm-orchestrator-work/
└── <루트-slug>-<설정-hash>/
    ├── run.json
    ├── state.json
    ├── events.jsonl
    └── nodes/<node-id>/
        ├── prompts/
        ├── raw/
        ├── sources.json
        ├── draft.json
        └── dedupe/
```

- 프롬프트, LLM generation·review raw 응답, 검색 출처, 검증된 draft, 중복 판정 raw를 노드별로 보존합니다.
- 긴 본문과 출처는 노드별 `draft.json`·`sources.json`에만 두며 중앙 `state.json`에는 그래프·상태만 둡니다.
- 같은 깊이 전체를 생성한 뒤 한 번 체크포인트하므로 노드마다 거대한 중앙 JSON을 다시 쓰지 않습니다.
- 상태와 개별 파일은 임시 파일을 쓴 뒤 `os.replace`하는 방식으로 원자적으로 갱신합니다.
- `Ctrl-C`, 프로세스 오류, 전원 문제로 최종 사이트 생성이 끊겨도 이미 저장된 응답과 상태는 작업 폴더에 남습니다.
- `--resume`은 같은 핵심 설정 hash의 작업만 재개합니다. 중단 당시 `generating`이던 노드는 다시 대기 상태로 돌립니다.
- 같은 작업 폴더가 있는데 `--resume`이 없으면 덮어쓰지 않고 오류로 종료합니다.
- 최종 사이트는 모든 Eager 생성 이후 별도 staging 디렉터리에 렌더링하고 문서·사이트맵 검증 후 한 번에 게시합니다.
- 기존 출력이 있으면 기본적으로 보존합니다. 교체하려면 `--overwrite`가 필요하며, 게시 실패 시 기존 출력 복원을 시도합니다.

중단된 작업을 이어서 기존 출력까지 교체하는 예:

```bash
llm-orchestrator "운영체제" \
  --resume \
  --overwrite \
  --base-url "$LLM_BASE_URL" \
  --model "$LLM_MODEL"
```

`--resume`에는 최초 실행과 같은 개념, 깊이, 출력, 작업 경로, 모델·검색·생성 설정을 사용하십시오. raw 응답에는 생성 내용과 웹 자료 일부가 들어 있으므로 `.llm-orchestrator-work/`를 무심코 공개 저장소에 커밋하지 마십시오.

## sitemap.txt

HTML이 활성화되면 게시 마지막 단계에 UTF-8 `sitemap.txt`를 만듭니다.

- 실제 완성된 canonical HTML 문서만 한 줄에 하나씩 기록
- 루트부터 깊이순으로 정렬
- 의미 중복으로 재사용한 문서는 한 번만 기록
- 실패·제외된 노드와 Markdown 파일은 제외
- `--site-url`이 있으면 절대 URL, 없으면 `index.html`, `pages/...` 상대경로
- `--format md`에서는 생성하지 않음

검색엔진에 제출하려면 배포 기준 URL을 명시하십시오.

```bash
llm-orchestrator "운영체제" \
  --site-url 'https://docs.example.com/os/' \
  --base-url "$LLM_BASE_URL" \
  --model "$LLM_MODEL"
```

`--site-url`이 없으면 로컬 문서 목록으로는 쓸 수 있지만 배포용 절대 URL 사이트맵은 아니며 CLI가 경고합니다. 텍스트 사이트맵 형식은 [Google의 사이트맵 문서](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap)를 참고하십시오.

## CLI 전체 옵션

항상 설치된 버전의 `llm-orchestrator --help`를 최종 기준으로 삼으십시오.

```text
llm-orchestrator CONCEPT [OPTIONS]
```

### 필수 인자와 일반 출력

| 인자·옵션 | 기본값 | 설명 |
|---|---:|---|
| `CONCEPT` | 필수 | 사이트 루트가 될 최초 한국어 개념. 누락 또는 빈 문자열은 오류 |
| `--depth N` | `3` | 루트를 0으로 보는 깊이. 0 이상, 인위적 최대 깊이는 없음 |
| `--max-children N` | `4` | 내부 노드의 최대 하위개념 수. 1~16 |
| `--output PATH` | `generated-site` | 완성된 사이트 출력 디렉터리 |
| `--work-dir PATH`, `--workdir PATH` | `.llm-orchestrator-work` | raw 응답과 재개 상태 디렉터리 |
| `--format {both,html,md}` | `both` | 출력 형식 |
| `--css FILE` | 번들 데모 CSS | HTML에 `assets/site.css`로 복사할 사용자 CSS |
| `--site-url URL` | 없음 | `sitemap.txt` 절대 URL의 HTTP(S) 배포 기준 URL |
| `--target-chars N` | `2000` | 본문 목표 글자 수. 200 이상이며 `--max-chars` 이하 |
| `--max-chars N` | `5000` | 본문 절대 상한. 200~5000 |
| `--summary-max-chars N` | `100` | 요약 상한. 20~100, 별도로 최대 3문장 검증 |

`--output`과 `--work-dir`은 서로 같거나 한쪽이 다른 쪽 안에 들어갈 수 없습니다. `--site-url`은 query string과 fragment가 없는 HTTP(S) 기준 URL이어야 합니다.

### LLM 공급자

| 옵션 | 기본값 | 설명 |
|---|---:|---|
| `--provider {openai-compatible,mock}` | `openai-compatible` | 실제 OpenAI-compatible 또는 파이프라인용 mock |
| `--model NAME` | `$LLM_MODEL` 또는 빈 값 | 모델명. 실제 공급자에서는 필수 |
| `--base-url URL` | `$LLM_BASE_URL` 또는 빈 값 | `/v1` 기준 URL. 실제 공급자에서는 필수 |
| `--api-key-env NAME` | `LLM_API_KEY` | LLM 키를 읽을 환경 변수명 |
| `--temperature FLOAT` | `0.2` | 생성 temperature. 0~2 |
| `--max-tokens N` | `4096` | LLM 응답 최대 토큰 수. 1 이상 |
| `--review-mode {strict,basic,off}` | `strict` | `strict`는 별도 LLM 근거·분해축 검수. `basic`·`off`는 추가 의미 검수를 생략하지만 공통 형식·인용 검증은 유지 |

### 웹 근거

| 옵션 | 기본값 | 설명 |
|---|---:|---|
| `--search-provider {auto,ddgs,searxng,brave,mock}` | `auto` | 검색 공급자 선택 |
| `--searxng-url URL` | `$SEARXNG_URL` 또는 빈 값 | 자체 SearXNG 인스턴스 URL |
| `--brave-api-key-env NAME` | `BRAVE_SEARCH_API_KEY` | Brave Search 키를 읽을 환경 변수명 |
| `--max-sources N` | `4` | 노드마다 사용할 최대 웹 출처 수. 웹 사용 시 1 이상 |
| `--source-chars N` | `4000` | 출처 하나에서 LLM에 제공할 최대 글자 수. 500 이상 |
| `--no-web` | 꺼짐 | 기본 활성화된 웹 검색을 끔. 단독 사용 불가 |
| `--allow-ungrounded` | 꺼짐 | 웹 근거 없이 모델 지식 생성을 명시적으로 허용. `--no-web`과 함께 필요 |

### 실행과 안전장치

| 옵션 | 기본값 | 설명 |
|---|---:|---|
| `--jobs N` | `4` | 같은 깊이에서 병렬 생성할 노드 수. 1 이상 |
| `--timeout SECONDS` | `60.0` | LLM·검색 요청 제한 시간. 0보다 커야 함 |
| `--retries N` | `2` | 형식·근거 검증 실패 후 추가 재시도 횟수. 0 이상 |
| `--duplicate-threshold FLOAT` | `0.82` | LLM `same` 판정을 병합할 최소 신뢰도. 0.5~1.0 |
| `--max-nodes N` | `5000` | 이론상 최대 노드 안전선 |
| `--force` | 꺼짐 | `--max-nodes` 초과 실행 허용 |
| `--resume` | 꺼짐 | 동일 설정 작업 폴더에서 중단된 생성 재개 |
| `--overwrite` | 꺼짐 | 게시 시 기존 출력 사이트 교체 |
| `--dry-run` | 꺼짐 | 공급자·네트워크 호출 없이 예상 규모와 설정만 출력 |
| `--verbose` | 꺼짐 | 상세 오류와 traceback 출력 |
| `--version` | - | 버전 출력 후 종료 |
| `-h`, `--help` | - | 전체 도움말 출력 후 종료 |

## MINZKN 문서 구조 참고

긴 기술 문서를 읽기 쉽게 구성하는 참고 사례로 [리눅스 커널 정리 /with MINZKN](https://www.minzkn.com/linuxkernel/)의 문서 지도를 살펴보았습니다. 이 프로젝트는 다음과 같은 일반적인 정보 구조만 참고합니다.

- 짧은 진입 설명 뒤에 핵심 주제 링크를 배치
- 긴 본문을 개요, 핵심 원리, 단계적 설명으로 나눔
- 관련 문서와 참고 자료를 명확한 링크로 연결
- 표·코드·수식을 본문 흐름에 맞게 사용

MINZKN의 문구, CSS, SVG, HTML/JavaScript, 코드를 복제하지 않습니다. 해당 사이트의 문서 콘텐츠는 별도 표기가 없는 한 **CC BY-NC-SA 4.0**이며, Linux 커널 코드 발췌 등에는 별도 원본 라이선스가 적용될 수 있습니다. 실제 내용을 인용·변형·재배포한다면 [MINZKN 저작권 및 라이선스 안내](https://www.minzkn.com/linuxkernel/pages/license.html)와 해당 원출처의 조건을 직접 확인하고 지켜야 합니다.

## 보안·개인정보·사실 검증

- 웹 검색 결과는 신뢰할 수 없는 입력입니다. 프롬프트는 페이지 안의 지시를 따르지 말라고 명시하지만, prompt injection 방어가 완전하다고 가정하지 마십시오.
- 웹 페이지 fetch는 DNS 결과가 전역 공개 IP인 HTTP(S) 주소만 허용하고 redirect마다 다시 확인해 기본적인 SSRF 위험을 줄입니다.
- 웹 검색이 기본 활성화되어 루트 개념, 현재 경로와 개념명으로 만든 질의가 선택한 DDGS·Brave·SearXNG 검색 공급자에 노드마다 전송됩니다. 민감한 주제를 외부 검색에 보내지 않으려면 `--no-web --allow-ungrounded`를 함께 사용하십시오.
- LLM API에는 최초 개념, 현재 경로, 웹 근거 일부가 전송됩니다. 민감한 주제를 원격 API에 보내기 전 공급자의 보존·학습 정책을 확인하십시오.
- API 키는 명령행 값이 아니라 환경 변수로 전달하십시오. 셸 기록, 로그, 저장소에 비밀값을 넣지 마십시오.
- raw 작업 폴더에는 프롬프트, 응답, 출처 본문 일부가 남습니다. 접근 권한과 백업·삭제 정책을 직접 관리하십시오.
- 인용 ID가 유효하다는 것은 그 출처가 실제로 모든 문장을 뒷받침한다는 보증이 아닙니다. 검색 순위와 작은 LLM의 요약·검수도 틀릴 수 있습니다.
- 의료·법률·재무·보안·정책처럼 위험이 큰 문서는 공식 1차 자료와 해당 분야 전문가가 최종 검토해야 합니다.
- 버전 의존 기술 정보는 출력의 출처 확인 날짜만 믿지 말고 배포 직전에 최신 공식 문서와 다시 대조하십시오.
- 원문의 긴 문장, 코드, 표가 과도하게 재현되지 않았는지 확인하고 각 출처의 저작권·라이선스를 준수하십시오.

## 현재 범위 밖

- 런타임 RAG 질문·답변, `ask` 명령, 채팅 UI
- 벡터 임베딩·벡터 데이터베이스·검색 인덱스
- 사용자 로컬 문서 업로드
- PDF 파싱, 스캔 OCR, 이미지 이해
- 자동 학술 peer review 또는 사실 정확성 보증
- CSS 테마 편집 UI

이 생성기의 책임은 **웹 근거를 바탕으로 한국어 개념 지식 맵을 완전 Eager 생성하고, 검증 가능한 작업 기록과 함께 HTML·Markdown·`sitemap.txt`로 원자적으로 게시하는 것**까지입니다.
