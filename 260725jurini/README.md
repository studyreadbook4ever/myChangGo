https://studyreadbook4ever.github.io/myChangGo/260725jurini/

# 도와줘 · Help Query v1

회사·업종·지역산업을 입력하면 어떤 LLM에도 붙여 넣을 수 있는 공급자 중립형 프롬프트 스키마를 만드는 정적 웹사이트입니다. 이 사이트 자체는 LLM이나 생성형 AI API를 호출하지 않습니다.

## 핵심 기능

- 명확한 회사·업종·지역산업은 규칙 기반으로 분류하고, 애매하면 확인 또는 직접 지정
- 사용자 조건을 반영한 `Help Query v1` 생성
- 사람용 프롬프트와 구조화 JSON을 함께 제공
- 복사·JSON 저장
- 결과별 좋아요·싫어요
- 네트워크보다 먼저 저장하는 피드백 outbox
- 원문 대상·자유문장을 제외하는 GitHub 공개 이슈 폴백
- 키보드·화면낭독기·모바일 대응

## 개발

```bash
npm install
npm run dev
```

## 검증

```bash
npm test
npm run build
```

## 배포

이 프로젝트는 `studyreadbook4ever/myChangGo` 저장소의 `260725jurini/`
디렉터리에서 브라우저 네이티브 ES 모듈로 실행됩니다. 저장소의 GitHub Pages는
`main /`를 배포하며, 별도 LLM 또는 애플리케이션 서버가 필요하지 않습니다.

기본 배포에는 중앙 피드백 API를 연결하지 않습니다. 평가는 먼저 해당 브라우저에
저장되고, 사용자가 원할 때 최소 메타데이터만 담긴 GitHub 공개 이슈를 직접
제출합니다. 대상 원문과 자유문장 메모는 이슈 URL에 자동으로 포함하지 않습니다.
자세한 내용은 [피드백 아키텍처](docs/feedback-architecture.md)를 참고하세요.

## 환경변수

```text
VITE_FEEDBACK_ENDPOINT=
VITE_FEEDBACK_ISSUE_REPO=studyreadbook4ever/myChangGo
```

## 안전 원칙

생성되는 스키마는 주식 매수·주가 부양, 반복 검색·재생, 허위 후기, 가짜
문의·지원, 스팸 공유, 경쟁사 공격을 명시적으로 제외합니다. 사용자 입력은
지시가 아닌 JSON 데이터로 격리하며, 검색할 수 없는 LLM에는 출처와 최신 사실을
만들지 말고 `확인 불가`라고 표시하도록 요구합니다.
