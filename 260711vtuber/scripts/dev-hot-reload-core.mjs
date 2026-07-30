import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export const DEV_RELOAD_SCHEMA = "chzzk-kirinuki-dev-reload/v1";

const EDITOR_SOURCE_PREFIX = "src/editor/";
const STYLE_FILES = new Set([
  "extension/editor/editor.css"
]);
const EDITOR_PAGE_FILES = new Set([
  "extension/editor.html"
]);
const CONTENT_FILES = new Set([
  "src/content-script.js",
  "extension/lib/source-platform.js"
]);
const EDITOR_DEPENDENCY_FILES = new Set([
  "extension/lib/caption-style.js"
]);
const SHARED_EXTENSION_FILES = new Set([
  "extension/lib/core.js",
  "extension/lib/editor-core.js",
  "extension/lib/source-platform.js"
]);
const EXTENSION_FILES = new Set([
  "extension/manifest.json",
  "extension/service-worker.js",
  "extension/sidepanel.html",
  "extension/sidepanel.css",
  "extension/sidepanel.js",
  "extension/lib/session-recovery.js"
]);

export function normalizeDevChangedPath(root, filePath) {
  return path.relative(root, path.resolve(filePath)).split(path.sep).join("/");
}

export function classifyDevReload(changedFiles) {
  const files = [...new Set(changedFiles.map((value) => String(value)))].sort();
  const hasEditorCode = files.some((file) => (
    file.startsWith(EDITOR_SOURCE_PREFIX)
    || EDITOR_DEPENDENCY_FILES.has(file)
  ));
  const hasEditorPage = files.some((file) => EDITOR_PAGE_FILES.has(file));
  const hasStyle = files.some((file) => STYLE_FILES.has(file));
  const hasContent = files.some((file) => CONTENT_FILES.has(file));
  const hasExtension = files.some((file) => (
    EXTENSION_FILES.has(file)
    || SHARED_EXTENSION_FILES.has(file)
  ));

  if (hasExtension) {
    return "extension";
  }
  if (hasEditorCode || hasEditorPage || (hasStyle && hasContent)) {
    return "editor";
  }
  if (hasContent) {
    return "content";
  }
  if (hasStyle) {
    return "style";
  }
  return "none";
}

export function devChangeNeedsBuild(changedFiles) {
  return changedFiles.some((file) => (
    String(file).startsWith(EDITOR_SOURCE_PREFIX)
    || EDITOR_DEPENDENCY_FILES.has(String(file))
    || SHARED_EXTENSION_FILES.has(String(file))
    || CONTENT_FILES.has(String(file))
  ));
}

export function createDevReloadMarker({
  revision,
  kind,
  changedFiles,
  pid = process.pid,
  createdAt = new Date()
}) {
  const normalizedRevision = String(revision || "").trim();
  if (!normalizedRevision) {
    throw new TypeError("개발 리로드 revision이 비어 있습니다.");
  }
  if (!["initial", "style", "editor", "content", "extension"].includes(kind)) {
    throw new TypeError(`지원하지 않는 개발 리로드 종류입니다: ${kind}`);
  }
  const createdAtDate = createdAt instanceof Date ? createdAt : new Date(createdAt);
  if (!Number.isFinite(createdAtDate.getTime())) {
    throw new TypeError("개발 리로드 생성 시각이 올바르지 않습니다.");
  }
  return {
    schema: DEV_RELOAD_SCHEMA,
    revision: normalizedRevision,
    kind,
    changedFiles: [...new Set(changedFiles.map((value) => String(value)))].sort(),
    pid: Number(pid),
    createdAt: createdAtDate.toISOString()
  };
}

export function isDevReloadMarker(value) {
  return Boolean(
    value
    && value.schema === DEV_RELOAD_SCHEMA
    && typeof value.revision === "string"
    && value.revision.trim()
    && ["initial", "style", "editor", "content", "extension"].includes(value.kind)
    && Array.isArray(value.changedFiles)
    && value.changedFiles.every((entry) => typeof entry === "string")
    && Number.isInteger(value.pid)
    && value.pid > 0
    && Number.isFinite(Date.parse(value.createdAt))
  );
}

export async function readDevReloadMarker(markerPath) {
  try {
    const parsed = JSON.parse(await readFile(markerPath, "utf8"));
    return isDevReloadMarker(parsed) ? parsed : null;
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
}

export async function writeDevReloadMarker(markerPath, marker) {
  if (!isDevReloadMarker(marker)) {
    throw new TypeError("개발 리로드 marker 형식이 올바르지 않습니다.");
  }
  await mkdir(path.dirname(markerPath), { recursive: true });
  const temporaryPath = `${markerPath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(marker, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  await rename(temporaryPath, markerPath);
}

export async function removeOwnedDevReloadMarker(markerPath, pid = process.pid) {
  const marker = await readDevReloadMarker(markerPath);
  if (!marker || marker.pid !== pid) {
    return false;
  }
  try {
    await unlink(markerPath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export function processIsRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}
