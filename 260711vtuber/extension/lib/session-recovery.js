export const RECOVERY_SESSION_MODE = "resume";
export const RECOVERY_DRAFTS_MODE = "drafts";
export const MAX_RECOVERY_SESSIONS = 12;

function normalizedProjectId(value) {
  const projectId = String(value || "").trim();
  if (!projectId || projectId.length > 256) {
    return "";
  }
  return projectId;
}

function timestampMs(value) {
  if (value == null || value === "") {
    return 0;
  }
  const parsed = typeof value === "number"
    ? value
    : Date.parse(String(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function collectionLength(value) {
  return Array.isArray(value) ? value.length : 0;
}

function projectCounts(project) {
  return {
    clips: collectionLength(project?.clips),
    subtitles: collectionLength(project?.subtitles),
    assets: collectionLength(project?.imageAssets),
    audio: collectionLength(project?.audioRegions)
  };
}

function draftTimestampMs(draft) {
  return timestampMs(draft?.createdAtMs) || timestampMs(draft?.createdAt);
}

function projectTimestampMs(project) {
  return timestampMs(project?.updatedAt) || timestampMs(project?.createdAt);
}

function compareNewestFirst(first, second) {
  return (
    second.updatedAtMs - first.updatedAtMs
    || first.title.localeCompare(second.title, "ko")
    || first.projectId.localeCompare(second.projectId)
  );
}

/**
 * IndexedDB records can contain the whole edit graph. This projection deliberately
 * returns only the fields needed by the sidepanel and never forwards provider keys,
 * media handles, captions, image data, or any other project payload.
 */
export function buildRecoverySessionSummaries(
  projects,
  drafts,
  { limit = MAX_RECOVERY_SESSIONS } = {}
) {
  const draftsByProject = new Map();
  for (const draft of Array.isArray(drafts) ? drafts : []) {
    const projectId = normalizedProjectId(draft?.projectId);
    if (!projectId || String(draft?.project?.id || "") !== projectId) {
      continue;
    }
    const entries = draftsByProject.get(projectId) || [];
    entries.push(draft);
    draftsByProject.set(projectId, entries);
  }

  const summaries = [];
  const seenProjectIds = new Set();
  for (const project of Array.isArray(projects) ? projects : []) {
    const projectId = normalizedProjectId(project?.id);
    if (!projectId || seenProjectIds.has(projectId)) {
      continue;
    }
    seenProjectIds.add(projectId);
    const projectDrafts = (draftsByProject.get(projectId) || [])
      .sort((first, second) => (
        draftTimestampMs(second) - draftTimestampMs(first)
        || String(second?.id || "").localeCompare(String(first?.id || ""))
      ));
    const latestDraft = projectDrafts[0] || null;
    const projectUpdatedAtMs = projectTimestampMs(project);
    const latestDraftAtMs = draftTimestampMs(latestDraft);
    const updatedAtMs = Math.max(projectUpdatedAtMs, latestDraftAtMs);
    const title = String(project?.name || latestDraft?.project?.name || "")
      .replace(/\s+/gu, " ")
      .trim()
      .slice(0, 160) || "제목 없는 키리누키 프로젝트";

    summaries.push({
      projectId,
      title,
      updatedAt: updatedAtMs > 0
        ? new Date(updatedAtMs).toISOString()
        : null,
      updatedAtMs,
      counts: projectCounts(project),
      draftCount: projectDrafts.length,
      latestDraftReason: latestDraft
        ? String(latestDraft.reason || "manual").slice(0, 32)
        : null,
      latestDraftAt: latestDraftAtMs > 0
        ? new Date(latestDraftAtMs).toISOString()
        : null
    });
  }

  const requestedLimit = Number(limit);
  const normalizedLimit = Number.isFinite(requestedLimit)
    ? Math.max(0, Math.min(50, Math.floor(requestedLimit)))
    : MAX_RECOVERY_SESSIONS;
  return summaries.sort(compareNewestFirst).slice(0, normalizedLimit);
}

export function buildSavedEditorUrl(editorRoot, projectId, {
  recoveryDrafts = false
} = {}) {
  const normalizedId = normalizedProjectId(projectId);
  if (!normalizedId) {
    throw new TypeError("다시 열 프로젝트 ID가 올바르지 않습니다.");
  }
  const url = new URL(editorRoot);
  url.searchParams.set("project", normalizedId);
  url.searchParams.set("session", RECOVERY_SESSION_MODE);
  if (recoveryDrafts) {
    url.searchParams.set("recovery", RECOVERY_DRAFTS_MODE);
  }
  return url.href;
}

export function editorTabMatchesProject(tabUrl, editorRoot, projectId) {
  const normalizedId = normalizedProjectId(projectId);
  if (!normalizedId) {
    return false;
  }
  try {
    const tab = new URL(tabUrl);
    const root = new URL(editorRoot);
    return (
      tab.origin === root.origin
      && tab.pathname === root.pathname
      && tab.searchParams.get("project") === normalizedId
    );
  } catch {
    return false;
  }
}
