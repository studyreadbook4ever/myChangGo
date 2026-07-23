/**
 * Pure data helpers for 잠깐 맡김소.
 *
 * The module intentionally has no DOM or storage side effects so it can be used
 * by both the browser UI and Node's built-in test runner.
 */

export const SCHEMA_VERSION = 1;
export const STORAGE_KEY = "jamkkan-matgimso:v1";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const MAX_DATE_MS = 8.64e15;

let fallbackIdSequence = 0;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isTimestamp(value) {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Math.abs(value) <= MAX_DATE_MS
  );
}

function requireTimestamp(value, name) {
  if (!isTimestamp(value)) {
    throw new TypeError(`${name} must be a valid millisecond timestamp`);
  }

  return value;
}

function compareStrings(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function createFallbackId(nowMs) {
  fallbackIdSequence = (fallbackIdSequence + 1) % Number.MAX_SAFE_INTEGER;

  const timePart = Math.trunc(Math.abs(nowMs)).toString(36);
  const randomPart = Math.random().toString(36).slice(2, 12).padEnd(10, "0");
  const sequencePart = fallbackIdSequence.toString(36);

  return `park-${timePart}-${randomPart}-${sequencePart}`;
}

function createId(nowMs) {
  const randomUUID = globalThis.crypto?.randomUUID;

  if (typeof randomUUID === "function") {
    try {
      return randomUUID.call(globalThis.crypto);
    } catch {
      // A privacy-hardened browser may expose randomUUID but reject the call.
      // The local fallback still gives each item a useful, collision-resistant id.
    }
  }

  return createFallbackId(nowMs);
}

function parseLocalDateTime(value) {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})(?:T|\s)(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(
      value,
    );

  if (!match) return null;

  const [
    ,
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText = "0",
    millisecondText = "0",
  ] = match;

  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const millisecond = Number(millisecondText.padEnd(3, "0"));

  const date = new Date(0);
  date.setFullYear(year, month - 1, day);
  date.setHours(hour, minute, second, millisecond);

  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day ||
    date.getHours() !== hour ||
    date.getMinutes() !== minute ||
    date.getSeconds() !== second ||
    date.getMilliseconds() !== millisecond
  ) {
    return null;
  }

  return date.getTime();
}

function parseCustomTimestamp(customValue) {
  if (typeof customValue === "number") {
    return requireTimestamp(customValue, "customValue");
  }

  if (customValue instanceof Date) {
    return requireTimestamp(customValue.getTime(), "customValue");
  }

  if (typeof customValue === "string") {
    const trimmed = customValue.trim();
    if (!trimmed) {
      throw new TypeError("customValue must contain a date and time");
    }

    const localTimestamp = parseLocalDateTime(trimmed);
    if (localTimestamp !== null) return localTimestamp;

    // Date.parse is only used for an explicitly zoned ISO date-time. Bare
    // date-times are handled above so their local-time meaning is consistent.
    if (
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(
        trimmed,
      )
    ) {
      const zonedTimestamp = Date.parse(trimmed);
      if (isTimestamp(zonedTimestamp)) return zonedTimestamp;
    }
  }

  throw new TypeError("customValue must be a valid date and time");
}

/**
 * Resolves a review preset to an absolute timestamp.
 *
 * Calendar presets use the runtime's local timezone. "tonight" is 20:00 today
 * unless that instant has already passed; "tomorrow" is 09:00 on the next
 * calendar day.
 */
export function resolveReviewAt(preset, nowMs, customValue) {
  requireTimestamp(nowMs, "nowMs");

  switch (preset) {
    case "10m":
      return nowMs + 10 * MINUTE_MS;
    case "1h":
      return nowMs + HOUR_MS;
    case "tonight": {
      const tonight = new Date(nowMs);
      tonight.setHours(20, 0, 0, 0);

      if (tonight.getTime() < nowMs) {
        tonight.setDate(tonight.getDate() + 1);
      }

      return tonight.getTime();
    }
    case "tomorrow": {
      const tomorrow = new Date(nowMs);
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(9, 0, 0, 0);
      return tomorrow.getTime();
    }
    case "custom":
      return parseCustomTimestamp(customValue);
    default:
      throw new RangeError(`Unknown review preset: ${String(preset)}`);
  }
}

/**
 * Creates a new holding item.
 */
export function createItem(
  text,
  preset = "10m",
  nowMs = Date.now(),
  customValue,
) {
  if (typeof text !== "string" || text.trim().length === 0) {
    throw new TypeError("text must be a non-empty string");
  }

  requireTimestamp(nowMs, "nowMs");

  return {
    id: createId(nowMs),
    text: text.trim(),
    createdAt: nowMs,
    reviewAt: resolveReviewAt(preset, nowMs, customValue),
    status: "holding",
    doneAt: null,
  };
}

function normalizeItem(candidate) {
  if (!isObject(candidate)) return null;

  const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
  const text =
    typeof candidate.text === "string" ? candidate.text.trim() : "";

  if (!id || !text) return null;
  if (!isTimestamp(candidate.createdAt) || !isTimestamp(candidate.reviewAt)) {
    return null;
  }
  if (candidate.status !== "holding" && candidate.status !== "done") {
    return null;
  }

  if (candidate.status === "holding" && candidate.doneAt !== null) {
    return null;
  }
  if (candidate.status === "done" && !isTimestamp(candidate.doneAt)) {
    return null;
  }

  return {
    id,
    text,
    createdAt: candidate.createdAt,
    reviewAt: candidate.reviewAt,
    status: candidate.status,
    doneAt: candidate.status === "done" ? candidate.doneAt : null,
  };
}

function extractCandidates(snapshot) {
  let decoded = snapshot;

  if (typeof snapshot === "string") {
    try {
      decoded = JSON.parse(snapshot);
    } catch {
      return [];
    }
  }

  if (Array.isArray(decoded)) return decoded;
  if (isObject(decoded) && Array.isArray(decoded.items)) return decoded.items;
  return [];
}

/**
 * Safely reads an unknown local-storage/import snapshot.
 *
 * Accepted roots are an item array or an object containing an `items` array.
 * Invalid records and later records with a duplicate id are counted as
 * discarded. The first valid record for an id wins.
 */
export function normalizeSnapshot(snapshot) {
  const candidates = extractCandidates(snapshot);
  const items = [];
  const seenIds = new Set();
  let discarded = 0;

  for (const candidate of candidates) {
    const item = normalizeItem(candidate);

    if (!item || seenIds.has(item.id)) {
      discarded += 1;
      continue;
    }

    seenIds.add(item.id);
    items.push(item);
  }

  return { items, discarded };
}

function compareScheduled(left, right) {
  return (
    left.reviewAt - right.reviewAt ||
    left.createdAt - right.createdAt ||
    compareStrings(left.id, right.id)
  );
}

function compareDone(left, right) {
  return (
    right.doneAt - left.doneAt ||
    right.createdAt - left.createdAt ||
    compareStrings(left.id, right.id)
  );
}

/**
 * Splits items for display without mutating the source collection.
 *
 * Due and future holdings are ordered by review time (oldest/soonest first).
 * Done items are ordered by completion time (most recent first).
 */
export function partitionItems(items, nowMs, query = "") {
  requireTimestamp(nowMs, "nowMs");

  const normalizedItems = normalizeSnapshot(items).items;
  const normalizedQuery =
    typeof query === "string" ? query.trim().toLocaleLowerCase() : "";

  const visibleItems = normalizedQuery
    ? normalizedItems.filter((item) =>
        item.text.toLocaleLowerCase().includes(normalizedQuery),
      )
    : normalizedItems;

  const due = [];
  const holding = [];
  const done = [];

  for (const item of visibleItems) {
    if (item.status === "done") {
      done.push(item);
    } else if (item.reviewAt <= nowMs) {
      due.push(item);
    } else {
      holding.push(item);
    }
  }

  due.sort(compareScheduled);
  holding.sort(compareScheduled);
  done.sort(compareDone);

  return { due, holding, done };
}

/**
 * Produces a compact Korean relative-time label.
 */
export function formatRelativeTime(targetMs, nowMs) {
  requireTimestamp(targetMs, "targetMs");
  requireTimestamp(nowMs, "nowMs");

  const delta = targetMs - nowMs;
  const absoluteDelta = Math.abs(delta);

  if (delta === 0) return "지금";
  if (absoluteDelta < MINUTE_MS) {
    return delta > 0 ? "곧" : "방금 지남";
  }

  let amount;
  let unit;

  if (absoluteDelta < HOUR_MS) {
    amount = Math.floor(absoluteDelta / MINUTE_MS);
    unit = "분";
  } else if (absoluteDelta < DAY_MS) {
    amount = Math.floor(absoluteDelta / HOUR_MS);
    unit = "시간";
  } else {
    amount = Math.floor(absoluteDelta / DAY_MS);
    unit = "일";
  }

  return `${amount}${unit} ${delta > 0 ? "후" : "지남"}`;
}

/**
 * Creates a JSON-serializable, versioned export object.
 */
export function makeExportPayload(items, exportedAtMs) {
  if (!Array.isArray(items)) {
    throw new TypeError("items must be an array");
  }

  requireTimestamp(exportedAtMs, "exportedAtMs");

  return {
    schemaVersion: SCHEMA_VERSION,
    exportedAt: exportedAtMs,
    items: normalizeSnapshot(items).items,
  };
}
