import assert from "node:assert/strict";
import test from "node:test";

import {
  SCHEMA_VERSION,
  STORAGE_KEY,
  createItem,
  formatRelativeTime,
  makeExportPayload,
  normalizeSnapshot,
  partitionItems,
  resolveReviewAt,
} from "../logic.js";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function holding(overrides = {}) {
  return {
    id: "holding-1",
    text: "잠깐 보관할 생각",
    createdAt: 1_000,
    reviewAt: 2_000,
    status: "holding",
    doneAt: null,
    ...overrides,
  };
}

function done(overrides = {}) {
  return {
    id: "done-1",
    text: "끝낸 생각",
    createdAt: 1_000,
    reviewAt: 2_000,
    status: "done",
    doneAt: 3_000,
    ...overrides,
  };
}

test("exports a stable storage contract", () => {
  assert.equal(SCHEMA_VERSION, 1);
  assert.equal(STORAGE_KEY, "jamkkan-matgimso:v1");
});

test("resolveReviewAt handles duration presets", () => {
  const now = new Date(2026, 6, 22, 14, 30, 15, 250).getTime();

  assert.equal(resolveReviewAt("10m", now), now + 10 * MINUTE_MS);
  assert.equal(resolveReviewAt("1h", now), now + HOUR_MS);
});

test("resolveReviewAt chooses today or tomorrow at 20:00 for tonight", () => {
  const before = new Date(2026, 6, 22, 19, 59, 59, 999).getTime();
  const exactly = new Date(2026, 6, 22, 20, 0, 0, 0).getTime();
  const after = new Date(2026, 6, 22, 20, 0, 0, 1).getTime();

  assert.equal(
    resolveReviewAt("tonight", before),
    new Date(2026, 6, 22, 20, 0, 0, 0).getTime(),
  );
  assert.equal(resolveReviewAt("tonight", exactly), exactly);
  assert.equal(
    resolveReviewAt("tonight", after),
    new Date(2026, 6, 23, 20, 0, 0, 0).getTime(),
  );
});

test("resolveReviewAt uses 09:00 on the next calendar day for tomorrow", () => {
  const monthEnd = new Date(2026, 6, 31, 23, 50, 0, 0).getTime();

  assert.equal(
    resolveReviewAt("tomorrow", monthEnd),
    new Date(2026, 7, 1, 9, 0, 0, 0).getTime(),
  );
});

test("resolveReviewAt accepts custom timestamps, Dates, local values, and zoned ISO", () => {
  const now = new Date(2026, 6, 22, 12, 0, 0, 0).getTime();
  const custom = new Date(2026, 6, 23, 8, 5, 4, 120);

  assert.equal(resolveReviewAt("custom", now, custom.getTime()), custom.getTime());
  assert.equal(resolveReviewAt("custom", now, custom), custom.getTime());
  assert.equal(
    resolveReviewAt("custom", now, "2026-07-23T08:05:04.12"),
    custom.getTime(),
  );
  assert.equal(
    resolveReviewAt("custom", now, "2026-07-22T00:00:00Z"),
    Date.parse("2026-07-22T00:00:00Z"),
  );
});

test("resolveReviewAt rejects invalid inputs without rolling invalid calendar dates", () => {
  const now = Date.now();

  assert.throws(() => resolveReviewAt("next-week", now), RangeError);
  assert.throws(() => resolveReviewAt("custom", now, ""), TypeError);
  assert.throws(
    () => resolveReviewAt("custom", now, "2026-02-30T12:00"),
    TypeError,
  );
  assert.throws(() => resolveReviewAt("10m", Number.NaN), TypeError);
});

test("createItem trims text and creates the exact holding shape", () => {
  const now = new Date(2026, 6, 22, 12, 0, 0, 0).getTime();
  const item = createItem("  나중에 답장하기  ", "1h", now);

  assert.deepEqual(Object.keys(item), [
    "id",
    "text",
    "createdAt",
    "reviewAt",
    "status",
    "doneAt",
  ]);
  assert.equal(typeof item.id, "string");
  assert.ok(item.id.length > 0);
  assert.equal(item.text, "나중에 답장하기");
  assert.equal(item.createdAt, now);
  assert.equal(item.reviewAt, now + HOUR_MS);
  assert.equal(item.status, "holding");
  assert.equal(item.doneAt, null);
});

test("createItem produces distinct ids and rejects blank text", () => {
  const now = Date.now();
  const first = createItem("첫 번째", "10m", now);
  const second = createItem("두 번째", "10m", now);

  assert.notEqual(first.id, second.id);
  assert.throws(() => createItem(" \n\t ", "10m", now), TypeError);
  assert.throws(() => createItem(null, "10m", now), TypeError);
});

test("normalizeSnapshot accepts arrays, snapshot objects, and JSON", () => {
  const first = holding({ id: " first ", text: "  첫 생각 " });
  const second = done({ id: "second" });

  const fromArray = normalizeSnapshot([first, second]);
  const fromObject = normalizeSnapshot({ schemaVersion: 99, items: [first] });
  const fromJson = normalizeSnapshot(JSON.stringify({ items: [second] }));

  assert.deepEqual(fromArray, {
    items: [
      holding({ id: "first", text: "첫 생각" }),
      second,
    ],
    discarded: 0,
  });
  assert.deepEqual(fromObject, {
    items: [holding({ id: "first", text: "첫 생각" })],
    discarded: 0,
  });
  assert.deepEqual(fromJson, { items: [second], discarded: 0 });
});

test("normalizeSnapshot discards malformed records and later duplicate ids", () => {
  const valid = holding({ id: "same" });
  const candidates = [
    valid,
    holding({ id: " same ", text: "중복" }),
    null,
    holding({ id: " " }),
    holding({ text: " " }),
    holding({ createdAt: Number.NaN }),
    holding({ reviewAt: "soon" }),
    holding({ status: "archived" }),
    holding({ doneAt: 123 }),
    done({ doneAt: null }),
    done({ id: "valid-done" }),
  ];

  assert.deepEqual(normalizeSnapshot(candidates), {
    items: [valid, done({ id: "valid-done" })],
    discarded: 9,
  });
});

test("normalizeSnapshot is safe for malformed JSON and unknown roots", () => {
  assert.deepEqual(normalizeSnapshot("{oops"), { items: [], discarded: 0 });
  assert.deepEqual(normalizeSnapshot(null), { items: [], discarded: 0 });
  assert.deepEqual(normalizeSnapshot({ items: "not-an-array" }), {
    items: [],
    discarded: 0,
  });
});

test("normalizeSnapshot returns fresh records and does not mutate input", () => {
  const source = holding({ id: " item ", text: " 생각 " });
  const snapshot = [source];
  const result = normalizeSnapshot(snapshot);

  assert.notEqual(result.items[0], source);
  assert.deepEqual(source, holding({ id: " item ", text: " 생각 " }));
  assert.deepEqual(snapshot, [source]);
});

test("partitionItems splits due, future, and done with deterministic sorting", () => {
  const now = 10_000;
  const source = [
    holding({ id: "future-late", createdAt: 5, reviewAt: 30_000 }),
    done({ id: "done-old", createdAt: 9, doneAt: 11_000 }),
    holding({ id: "due-b", createdAt: 3, reviewAt: 9_000 }),
    holding({ id: "future-soon", createdAt: 7, reviewAt: 20_000 }),
    done({ id: "done-new-b", createdAt: 12, doneAt: 12_000 }),
    holding({ id: "due-oldest", createdAt: 4, reviewAt: 8_000 }),
    holding({ id: "due-a", createdAt: 3, reviewAt: 9_000 }),
    done({ id: "done-new-a", createdAt: 12, doneAt: 12_000 }),
    holding({ id: "due-now", createdAt: 6, reviewAt: now }),
  ];
  const sourceBefore = structuredClone(source);

  const result = partitionItems(source, now);

  assert.deepEqual(
    result.due.map((item) => item.id),
    ["due-oldest", "due-a", "due-b", "due-now"],
  );
  assert.deepEqual(
    result.holding.map((item) => item.id),
    ["future-soon", "future-late"],
  );
  assert.deepEqual(
    result.done.map((item) => item.id),
    ["done-new-a", "done-new-b", "done-old"],
  );
  assert.deepEqual(source, sourceBefore);
});

test("partitionItems applies a trimmed, case-insensitive text query", () => {
  const now = 10_000;
  const source = [
    holding({ id: "due", text: "Send EMAIL", reviewAt: 9_000 }),
    holding({ id: "future", text: "이메일 주소 찾기", reviewAt: 11_000 }),
    done({ id: "done", text: "email 보냄" }),
    holding({ id: "hidden", text: "장보기", reviewAt: 9_000 }),
  ];

  const english = partitionItems(source, now, "  eMaIL ");
  assert.deepEqual(english.due.map((item) => item.id), ["due"]);
  assert.deepEqual(english.holding, []);
  assert.deepEqual(english.done.map((item) => item.id), ["done"]);

  const korean = partitionItems(source, now, "이메일");
  assert.deepEqual(korean.due, []);
  assert.deepEqual(korean.holding.map((item) => item.id), ["future"]);
  assert.deepEqual(korean.done, []);
});

test("partitionItems safely ignores invalid records and non-string queries", () => {
  const result = partitionItems(
    [holding(), { id: "bad" }, holding({ id: "holding-1" })],
    3_000,
    { unexpected: true },
  );

  assert.deepEqual(result.due.map((item) => item.id), ["holding-1"]);
  assert.deepEqual(result.holding, []);
  assert.deepEqual(result.done, []);
  assert.deepEqual(partitionItems(null, 3_000), {
    due: [],
    holding: [],
    done: [],
  });
});

test("formatRelativeTime covers immediate, minute, hour, and day labels", () => {
  const now = 10 * DAY_MS;

  assert.equal(formatRelativeTime(now, now), "지금");
  assert.equal(formatRelativeTime(now + 59_999, now), "곧");
  assert.equal(formatRelativeTime(now - 59_999, now), "방금 지남");
  assert.equal(formatRelativeTime(now + MINUTE_MS, now), "1분 후");
  assert.equal(formatRelativeTime(now - 59 * MINUTE_MS, now), "59분 지남");
  assert.equal(formatRelativeTime(now + HOUR_MS, now), "1시간 후");
  assert.equal(formatRelativeTime(now - 23 * HOUR_MS, now), "23시간 지남");
  assert.equal(formatRelativeTime(now + DAY_MS, now), "1일 후");
  assert.equal(formatRelativeTime(now - 3 * DAY_MS, now), "3일 지남");
  assert.throws(() => formatRelativeTime(Number.NaN, now), TypeError);
});

test("makeExportPayload creates a clean, versioned, detached payload", () => {
  const exportedAt = new Date(2026, 6, 22, 13, 0, 0, 0).getTime();
  const source = [
    holding(),
    done(),
    holding({ id: "holding-1", text: "duplicate" }),
    { id: "bad" },
  ];

  const payload = makeExportPayload(source, exportedAt);

  assert.deepEqual(payload, {
    schemaVersion: SCHEMA_VERSION,
    exportedAt,
    items: [holding(), done()],
  });
  assert.notEqual(payload.items[0], source[0]);

  payload.items[0].text = "changed in export";
  assert.equal(source[0].text, "잠깐 보관할 생각");

  assert.deepEqual(normalizeSnapshot(JSON.stringify(payload)), {
    items: [
      holding({ text: "changed in export" }),
      done(),
    ],
    discarded: 0,
  });
});

test("makeExportPayload rejects invalid top-level arguments", () => {
  assert.throws(() => makeExportPayload(null, Date.now()), TypeError);
  assert.throws(() => makeExportPayload([], Number.POSITIVE_INFINITY), TypeError);
});
