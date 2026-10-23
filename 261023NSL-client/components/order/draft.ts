import type { Confirmation, Language, Session } from "./types";

const KEY = "damda:table-order-draft:v1";
export type StoredDraft = {
  schema: 1;
  id: string;
  language: Language;
  table: string;
  approval?: Confirmation;
};

// A tab keeps only a session reference and, while approval is unresolved, the
// exact confirmation needed for idempotent recovery. Cart data stays on server.
export function readDraft(): StoredDraft | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(KEY) || "null");
    if (
      !value ||
      value.schema !== 1 ||
      typeof value.id !== "string" ||
      typeof value.table !== "string" ||
      !/^[a-zA-Z0-9_-]{1,120}$/.test(value.id) ||
      !["ko", "en", "ja", "zh"].includes(value.language) ||
      !/^[1-9]\d?$/.test(value.table)
    )
      return null;
    if (
      value.approval &&
      (typeof value.approval.token !== "string" ||
        !Number.isInteger(value.approval.version) ||
        !Array.isArray(value.approval.summary) ||
        !Number.isFinite(value.approval.total) ||
        typeof value.approval.expiresAt !== "string")
    )
      return null;
    return value as StoredDraft;
  } catch {
    return null;
  }
}
export function writeDraft(
  session: Pick<Session, "id" | "language" | "table">,
  approval: Confirmation | null = null,
) {
  try {
    sessionStorage.setItem(
      KEY,
      JSON.stringify({
        schema: 1,
        id: session.id,
        language: session.language,
        table: session.table,
        ...(approval ? { approval } : {}),
      }),
    );
  } catch {
    /* Restricted storage must not prevent an otherwise valid order. */
  }
}
export function clearDraft() {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* Browser storage may be unavailable. */
  }
}
