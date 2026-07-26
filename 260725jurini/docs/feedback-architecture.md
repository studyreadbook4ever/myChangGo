# 피드백 아키텍처

이 프로젝트는 GitHub Pages에서도 투표가 유실되지 않도록 `local-first outbox`를 사용한다.

## 데이터 흐름

1. 사용자가 결과별 좋아요·싫어요를 선택한다.
2. `FeedbackService.saveVote()`가 네트워크 요청 전에 레코드를 브라우저 저장소에 기록한다.
3. 같은 결과의 평가가 바뀌면 안정적인 `id`는 유지하고 `revision`과 `Idempotency-Key`를 새로 만든다.
4. `VITE_FEEDBACK_ENDPOINT`가 설정되어 있으면 같은 레코드를 `Idempotency-Key`와 함께 POST한다.
5. 전송 실패 레코드는 `queued` 상태로 남고 다음 방문·저장·온라인 복귀·탭 종료 시 다시 전송된다.
6. 엔드포인트가 없는 순수 GitHub Pages 배포에서는 저장소의 사전작성 이슈 링크를 제공한다. 이 URL에는 평가·대상 유형·응답 ID·사유만 담고 대상 원문과 자유문장 메모는 넣지 않는다.
7. 사용자는 자신의 outbox를 JSON으로 내보내거나 모두 삭제할 수 있다.

## 레코드 계약

- `feedbackSchema`: 피드백 계약 버전
- `id`: 같은 결과의 평가를 묶는 안정적인 식별자
- `revision`: 평가가 수정된 횟수
- `idempotencyKey`: 한 revision의 재시도 중복 방지 키
- `responseId`: 평가 대상 Help Query의 결정적 ID
- `vote`: `up` 또는 `down`
- `target`, `targetType`, `schemaVersion`, `appVersion`
- `reason`, `note`: 선택·선택 입력
- `createdAt`, `updatedAt`, `lastAttemptAt`, `sentAt`
- `status`, `attempts`, `lastError`

## 중앙 수집기 연결

정적 사이트 코드는 특정 백엔드에 의존하지 않는다. 배포 빌드에 다음 환경변수만 추가하면 된다.

```text
VITE_FEEDBACK_ENDPOINT=https://example.com/api/feedback
VITE_FEEDBACK_ISSUE_REPO=studyreadbook4ever/myChangGo
```

수집기는 다음을 만족해야 한다.

- `POST application/json`
- 안정적인 `id`를 기준으로 가장 높은 `revision`을 upsert
- `Idempotency-Key` 기준 중복 저장 방지
- 성공 시 2xx 반환
- 허용된 GitHub Pages origin만 CORS 허용
- IP·User-Agent 등 불필요한 개인 식별정보는 저장하지 않음
- 자유문장 `note`는 최대 300자, 보관기간과 삭제 정책 명시

기본 배포에는 중앙 수집 엔드포인트를 설정하지 않는다. 별도 수집기를 켜기 전에는
서버의 멱등성·최신 revision upsert를 검증하고, 수신자·전송 필드·보관기간·서버
사본 삭제 방법을 사용자에게 고지해야 한다. 화면의 로컬 삭제는 이미 전송된 서버
사본이나 사용자가 제출한 GitHub 이슈를 삭제하지 않는다.

GitHub Pages 자체는 서버 저장소를 제공하지 않는다. 따라서 중앙 집계가 필요하면 별도 수집 엔드포인트를 연결해야 하며, 연결 전에는 GitHub 이슈 폴백이 중앙 수신 경로가 된다.
