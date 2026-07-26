import { describe, expect, it, vi } from "vitest";
import {
  createFeedbackService,
  createMemoryStorage,
  FEEDBACK_SCHEMA_VERSION,
} from "../src/feedback.js";

function makeService(overrides = {}) {
  return createFeedbackService({
    storage: createMemoryStorage(),
    now: () => "2026-07-27T00:00:00.000Z",
    ...overrides,
  });
}

describe("feedback outbox", () => {
  it("네트워크보다 먼저 투표를 로컬에 저장한다", () => {
    const service = makeService();
    const record = service.saveVote({
      responseId: "hq-1234",
      vote: "up",
      target: "삼성전자",
      targetType: "company",
      schemaVersion: "help-query.v1.0.0",
      appVersion: "1.0.0",
    });

    expect(record.feedbackSchema).toBe(FEEDBACK_SCHEMA_VERSION);
    expect(record.status).toBe("queued");
    expect(service.pendingCount()).toBe(1);
  });

  it("같은 응답의 투표를 중복 생성하지 않고 갱신한다", () => {
    const service = makeService();
    const base = {
      responseId: "hq-1234",
      target: "삼성전자",
      targetType: "company",
      schemaVersion: "help-query.v1.0.0",
      appVersion: "1.0.0",
    };

    service.saveVote({ ...base, vote: "up" });
    const first = { ...service.readAll()[0] };
    service.saveVote({ ...base, vote: "down", reason: "너무 길어요" });

    expect(service.readAll()).toHaveLength(1);
    expect(service.readAll()[0].vote).toBe("down");
    expect(service.readAll()[0].reason).toBe("너무 길어요");
    expect(service.readAll()[0].id).toBe(first.id);
    expect(service.readAll()[0].revision).toBe(2);
    expect(service.readAll()[0].idempotencyKey).not.toBe(first.idempotencyKey);
  });

  it("엔드포인트 전송에 멱등성 키를 포함하고 성공 상태를 저장한다", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const service = makeService({
      endpoint: "https://example.test/feedback",
      fetchImpl,
    });

    service.saveVote({
      responseId: "hq-1234",
      vote: "up",
      target: "삼성전자",
      targetType: "company",
      schemaVersion: "help-query.v1.0.0",
      appVersion: "1.0.0",
    });
    const result = await service.flush();

    expect(result.sent).toBe(1);
    expect(service.pendingCount()).toBe(0);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://example.test/feedback",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Idempotency-Key": expect.any(String),
        }),
      }),
    );
  });

  it("실패한 전송은 큐에 남겨 재시도할 수 있다", async () => {
    const service = makeService({
      endpoint: "https://example.test/feedback",
      fetchImpl: vi.fn().mockRejectedValue(new Error("offline")),
    });

    service.saveVote({
      responseId: "hq-1234",
      vote: "down",
      target: "국내 가구업",
      targetType: "industry",
      schemaVersion: "help-query.v1.0.0",
      appVersion: "1.0.0",
    });
    const result = await service.flush();

    expect(result.sent).toBe(0);
    expect(result.pending).toBe(1);
    expect(service.readAll()[0].lastError).toBe("offline");
  });

  it("GitHub 피드백 이슈 URL에는 원문 대상과 자유문장을 포함하지 않는다", () => {
    const service = makeService();
    const record = service.saveVote({
      responseId: "hq-1234",
      vote: "up",
      target: "비공개 대상",
      targetType: "company",
      schemaVersion: "help-query.v1.0.0",
      appVersion: "1.0.0",
      note: "비공개 메모",
    });
    const url = new URL(service.buildIssueUrl(record));
    const issueText = `${url.searchParams.get("title")}\n${url.searchParams.get("body")}`;

    expect(url.hostname).toBe("github.com");
    expect(url.pathname).toBe("/studyreadbook4ever/myChangGo/issues/new");
    expect(issueText).toContain("hq-1234");
    expect(issueText).not.toContain("비공개 대상");
    expect(issueText).not.toContain("비공개 메모");
  });

  it("브라우저 저장소가 막혀도 메모리에서 피드백을 유지한다", () => {
    const brokenStorage = {
      getItem() {
        throw new Error("blocked");
      },
      setItem() {
        throw new Error("blocked");
      },
      removeItem() {
        throw new Error("blocked");
      },
    };
    const service = makeService({ storage: brokenStorage });

    service.saveVote({
      responseId: "hq-memory",
      vote: "down",
      target: "테스트 기업",
      targetType: "company",
      schemaVersion: "help-query.v1.0.0",
      appVersion: "1.0.0",
    });

    expect(service.pendingCount()).toBe(1);
    expect(service.getStorageStatus()).toEqual({
      persistent: false,
      mode: "memory",
    });
  });

  it("사용자가 이 브라우저의 피드백을 모두 삭제할 수 있다", () => {
    const service = makeService();
    service.saveVote({
      responseId: "hq-delete",
      vote: "up",
      target: "테스트 기업",
      targetType: "company",
      schemaVersion: "help-query.v1.0.0",
      appVersion: "1.0.0",
    });

    service.clearAll();

    expect(service.readAll()).toEqual([]);
  });
});
