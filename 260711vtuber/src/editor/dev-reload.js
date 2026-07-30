export const DEV_RELOAD_SCHEMA = "chzzk-kirinuki-dev-reload/v1";

const DEV_RELOAD_KINDS = new Set([
  "initial",
  "style",
  "editor",
  "content",
  "extension"
]);

export function normalizeDevReloadMarker(value) {
  if (
    !value
    || value.schema !== DEV_RELOAD_SCHEMA
    || typeof value.revision !== "string"
    || !value.revision.trim()
    || !DEV_RELOAD_KINDS.has(value.kind)
    || !Array.isArray(value.changedFiles)
    || !value.changedFiles.every((entry) => typeof entry === "string")
    || !Number.isInteger(value.pid)
    || value.pid <= 0
    || !Number.isFinite(Date.parse(value.createdAt))
  ) {
    return null;
  }
  return {
    schema: DEV_RELOAD_SCHEMA,
    revision: value.revision.trim(),
    kind: value.kind,
    changedFiles: [...new Set(value.changedFiles)].sort(),
    pid: value.pid,
    createdAt: new Date(value.createdAt).toISOString()
  };
}

export function devReloadResumeUrl(currentHref, projectId) {
  const id = String(projectId || "").trim();
  if (!id) {
    throw new TypeError("다시 열 개발 프로젝트 ID가 없습니다.");
  }
  const url = new URL(currentHref);
  const developmentReloadEnabled = url.searchParams.get("dev") === "1";
  url.search = "";
  url.searchParams.set("project", id);
  url.searchParams.set("session", "resume");
  if (developmentReloadEnabled) {
    url.searchParams.set("dev", "1");
  }
  return url.href;
}

export function devReloadStyleUrl(currentHref, revision) {
  const normalizedRevision = String(revision || "").trim();
  if (!normalizedRevision) {
    throw new TypeError("CSS 교체 revision이 없습니다.");
  }
  const url = new URL(currentHref);
  url.searchParams.set("dev-reload", normalizedRevision);
  return url.href;
}

function canonicalJsonValue(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalJsonValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((key) => value[key] !== undefined)
        .map((key) => [key, canonicalJsonValue(value[key])])
    );
  }
  return value;
}

export function devReloadProjectFingerprint(value) {
  return JSON.stringify(canonicalJsonValue(value));
}
