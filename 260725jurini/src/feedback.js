export const FEEDBACK_SCHEMA_VERSION = "feedback.v1";
export const DEFAULT_STORAGE_KEY = "help-query-feedback-outbox:v1";
export const MAX_FEEDBACK_RECORDS = 50;

function safeParse(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function createId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `feedback-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function createMemoryStorage() {
  const data = new Map();
  return {
    getItem(key) {
      return data.has(key) ? data.get(key) : null;
    },
    setItem(key, value) {
      data.set(key, String(value));
    },
    removeItem(key) {
      data.delete(key);
    },
  };
}

export function createFeedbackService({
  storage,
  fetchImpl = globalThis.fetch?.bind(globalThis),
  endpoint = "",
  issueRepo = "studyreadbook4ever/myChangGo",
  storageKey = DEFAULT_STORAGE_KEY,
  now = () => new Date().toISOString(),
} = {}) {
  const memoryStorage = createMemoryStorage();
  let primaryStorage = storage;
  let storageFailed = false;
  let recordsCache;

  if (!primaryStorage) {
    try {
      primaryStorage = globalThis.localStorage;
    } catch {
      primaryStorage = null;
    }
  }

  if (!primaryStorage) storageFailed = true;

  function readAll() {
    if (recordsCache) return recordsCache;

    try {
      const parsed = safeParse(primaryStorage.getItem(storageKey), []);
      recordsCache = Array.isArray(parsed) ? parsed : [];
      memoryStorage.setItem(storageKey, JSON.stringify(recordsCache));
    } catch {
      storageFailed = true;
      recordsCache = safeParse(memoryStorage.getItem(storageKey), []);
    }

    return recordsCache;
  }

  function writeAll(records) {
    const limitedRecords = records
      .slice()
      .sort((first, second) =>
        String(first.updatedAt).localeCompare(String(second.updatedAt)),
      )
      .slice(-MAX_FEEDBACK_RECORDS);
    const serialized = JSON.stringify(limitedRecords);

    recordsCache = limitedRecords;
    memoryStorage.setItem(storageKey, serialized);

    if (!storageFailed) {
      try {
        primaryStorage.setItem(storageKey, serialized);
      } catch {
        storageFailed = true;
      }
    }
  }

  function saveVote({
    responseId,
    vote,
    target,
    targetType,
    schemaVersion,
    appVersion,
    reason = "",
    note = "",
  }) {
    if (!responseId) throw new Error("responseId가 필요합니다.");
    if (!["up", "down"].includes(vote)) {
      throw new Error("vote는 up 또는 down이어야 합니다.");
    }

    const records = readAll();
    const existingIndex = records.findIndex(
      (record) => record.responseId === responseId,
    );
    const previous = existingIndex >= 0 ? records[existingIndex] : null;
    const record = {
      feedbackSchema: FEEDBACK_SCHEMA_VERSION,
      id: previous?.id ?? createId(),
      idempotencyKey: createId(),
      revision: (previous?.revision ?? 0) + 1,
      responseId,
      vote,
      target,
      targetType,
      schemaVersion,
      appVersion,
      reason,
      note,
      createdAt: previous?.createdAt ?? now(),
      updatedAt: now(),
      status: "queued",
      attempts: previous?.attempts ?? 0,
    };

    if (existingIndex >= 0) records[existingIndex] = record;
    else records.push(record);

    writeAll(records);
    return record;
  }

  async function flush() {
    if (!endpoint || !fetchImpl) {
      return { sent: 0, pending: pendingCount(), configured: false };
    }

    const records = readAll();
    let sent = 0;

    for (const record of records) {
      if (record.status === "sent") continue;

      record.attempts += 1;
      record.lastAttemptAt = now();

      try {
        const response = await fetchImpl(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": record.idempotencyKey,
          },
          body: JSON.stringify(record),
          keepalive: true,
        });

        if (!response.ok) {
          throw new Error(`Feedback endpoint returned ${response.status}`);
        }

        record.status = "sent";
        record.sentAt = now();
        record.lastError = "";
        sent += 1;
      } catch (error) {
        record.status = "queued";
        record.lastError = String(error?.message ?? error);
      }
    }

    writeAll(records);
    return { sent, pending: pendingCount(), configured: true };
  }

  function pendingCount() {
    return readAll().filter((record) => record.status !== "sent").length;
  }

  function exportAll() {
    return {
      exportedAt: now(),
      feedbackSchema: FEEDBACK_SCHEMA_VERSION,
      records: readAll(),
    };
  }

  function clearSent() {
    writeAll(readAll().filter((record) => record.status !== "sent"));
  }

  function clearAll() {
    recordsCache = [];
    memoryStorage.removeItem(storageKey);

    if (!storageFailed) {
      try {
        primaryStorage.removeItem(storageKey);
      } catch {
        storageFailed = true;
      }
    }
  }

  function getStorageStatus() {
    return {
      persistent: !storageFailed,
      mode: storageFailed ? "memory" : "local",
    };
  }

  function buildIssueUrl(record) {
    const title = `[feedback] ${record.vote === "up" ? "좋아요" : "아쉬워요"} · ${record.responseId}`;
    const body = [
      "## 스키마 피드백",
      "",
      `- 평가: ${record.vote === "up" ? "좋아요" : "아쉬워요"}`,
      `- 대상 유형: ${record.targetType}`,
      `- 응답 ID: ${record.responseId}`,
      `- 이유: ${record.reason || "선택하지 않음"}`,
      `- 스키마 버전: ${record.schemaVersion}`,
      "",
      "### 공개 가능한 맥락 (선택)",
      "",
      "대상 이름이나 의견을 공개해도 괜찮다면 이곳에 직접 적어주세요.",
      "",
      "> 대상 원문과 로컬에 저장한 한마디는 개인정보 보호를 위해 자동으로 넣지 않았습니다.",
      "> 이 공개 이슈에는 개인정보를 적지 말아주세요.",
    ].join("\n");

    const query = new URLSearchParams({ title, body });
    return `https://github.com/${issueRepo}/issues/new?${query.toString()}`;
  }

  return {
    saveVote,
    flush,
    pendingCount,
    exportAll,
    clearSent,
    clearAll,
    getStorageStatus,
    buildIssueUrl,
    readAll,
    isEndpointConfigured: Boolean(endpoint),
  };
}
