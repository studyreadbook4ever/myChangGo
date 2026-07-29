import {
  EDITOR_SEED_PREFIX,
  MAX_SUBTITLE_LANES,
  addSubtitleLane,
  appendAiSubtitleDrafts,
  applyCaptionStylePreset,
  applyMediaAlignmentOffset,
  audioRegionAtTimeline,
  audioRegionTimelineRange,
  canReorderClipGroup,
  captureProjectId,
  clipDurationMs,
  createAudioRegion,
  createEditorProjectFromCapture,
  createImageAsset,
  createSubtitleCue,
  cuesAtTimeline,
  cueTimelineRange,
  deleteAudioRegion,
  deleteImageAsset,
  deleteSubtitleCue,
  findAudioRegionOverlaps,
  imageAssetsAtTimeline,
  imageAssetTimelineRange,
  findSubtitleOverlaps,
  mapSourceToTimeline,
  mapTimelineToSource,
  mergeAiWarnings,
  mergeCaptureIntoEditorProject,
  normalizeEditorProject,
  projectDurationMs,
  reorderClip,
  reorderClipGroup,
  replaceAiSubtitleDraft,
  rippleDeleteTimelineRange,
  serializeSrt,
  updateAudioRegion,
  updateClipTrim,
  updateImageAsset,
  updateSubtitleCue
} from "../../extension/lib/editor-core.js";
import {
  DEFAULT_CAPTION_STYLE_PRESET_ID,
  captionSpeakerColor,
  captionSpeakerColorAssignments,
  captionStylePreset
} from "../../extension/lib/caption-style.js";
import { STORAGE_KEY } from "../../extension/lib/core.js";
import {
  extractClipCaptionPlacementHints,
  extractClipPcm16k,
  fallbackCaptionPlacementHints,
  fitSingleLineCaptionFontSize,
  getPreferredOutputProfile,
  inspectMediaFile,
  renderProjectVideo,
  singleLineCaptionText
} from "./media-engine.js";
import {
  deleteMediaHandle,
  getFileFromStoredHandle,
  listLocalDrafts,
  loadImageAssetBlob,
  loadLocalDraft,
  loadProject,
  pruneImageAssetBlobs,
  restoreLocalDraft,
  saveMediaHandle,
  saveLocalDraft,
  saveProjectWithImageAssetBlob,
  saveProject
} from "./project-store.js";
import {
  DEFAULT_CAPTION_AGENT_SETTINGS,
  MAX_CAPTION_AGENT_CLIPS_PER_RUN,
  MAX_CAPTION_AGENT_CUES_PER_RUN,
  captionAgentAudioFootprint,
  captionAgentResumePlan,
  captionAgentRunEstimate,
  createCaptionAgentCheckpoint,
  createCaptionAgentRequest,
  discardCaptionAgentCheckpointsForClips,
  encodePcm16WavBase64,
  ensureCaptionAgentPermission,
  ensureCaptionAgentSession,
  isLoopbackCaptionAgentEndpoint,
  loadCaptionAgentSettings,
  normalizeCaptionAgentCues,
  normalizeCaptionAgentEndpoint,
  probeCaptionAgent,
  requestCaptionAgentWithSessionRetry,
  sameCaptionMediaIdentity,
  saveCaptionAgentSettings,
  upsertCaptionAgentCheckpoint
} from "./caption-agent.js";
import {
  nextEnabledPreviewClip,
  preparedPreviewMatches,
  previewReachedClipBoundary
} from "./preview-transition.js";

const CAPTION_REVIEW_WARNING_CODES = new Set([
  "NO_RECOGNIZABLE_SPEECH",
  "DROPPED_INVALID_CUE",
  "DROPPED_EMPTY_RANGE",
  "TRIMMED_CUE_COUNT",
  "TRIMMED_WARNING_COUNT",
  "HARNESS_READING_RATE_EXCEEDED",
  "HARNESS_TRANSCRIPT_COVERAGE_LOW",
  "HARNESS_TRANSCRIPT_PRECISION_LOW",
  "HARNESS_SHORT_CUE_UNRESOLVED",
  "HARNESS_UNRESOLVED_SAME_SPEAKER_OVERLAP",
  "HARNESS_CUE_TEXT_TOO_WIDE",
  "HARNESS_LINE_TOO_WIDE",
  "HARNESS_TOO_MANY_LINES"
]);

const elements = Object.fromEntries([
  "project-name",
  "source-kind",
  "source-title",
  "source-link-state",
  "undo",
  "redo",
  "create-local-draft",
  "open-local-drafts",
  "pick-media",
  "export-video",
  "clip-count",
  "media-card",
  "media-name",
  "media-meta",
  "source-offset",
  "apply-source-offset",
  "clip-list",
  "clip-group-toolbar",
  "clip-group-status",
  "move-selected-clips-up",
  "move-selected-clips-down",
  "clear-clip-group-selection",
  "clip-template",
  "focus-source",
  "preview-source-tab",
  "stage",
  "preview-video",
  "stage-empty",
  "pick-media-empty",
  "subtitle-overlays",
  "image-asset-overlays",
  "previous-clip",
  "play-toggle",
  "next-clip",
  "current-time",
  "duration-time",
  "toggle-mute",
  "volume",
  "caption-mode-tab",
  "asset-mode-tab",
  "audio-mode-tab",
  "inspector-overline",
  "inspector-title",
  "caption-inspector-content",
  "asset-inspector-content",
  "audio-inspector-content",
  "add-cue-top",
  "caption-agent-endpoint",
  "caption-agent-token",
  "caption-stt-endpoint",
  "caption-stt-model",
  "caption-stt-api-key",
  "caption-upstage-api-key",
  "clear-caption-provider-keys",
  "caption-style-preset",
  "caption-model",
  "caption-local-status",
  "caption-advanced-settings",
  "test-caption-agent",
  "caption-agent-warning",
  "generate-captions",
  "ai-progress",
  "ai-progress-label",
  "ai-progress-value",
  "cue-list-tab",
  "cue-selected-tab",
  "cue-selected-panel",
  "cue-count",
  "cue-empty",
  "cue-editor",
  "cue-review-note",
  "cue-text",
  "cue-start",
  "cue-end",
  "cue-x",
  "cue-y",
  "cue-x-value",
  "cue-y-value",
  "font-size",
  "font-color",
  "reset-font-color",
  "delete-cue",
  "cue-list",
  "asset-empty",
  "asset-editor",
  "asset-thumbnail",
  "asset-name",
  "asset-meta",
  "asset-start",
  "asset-end",
  "asset-x",
  "asset-y",
  "asset-x-value",
  "asset-y-value",
  "asset-scale",
  "asset-scale-value",
  "asset-opacity",
  "asset-opacity-value",
  "asset-paste",
  "asset-pick-file",
  "delete-asset",
  "audio-empty",
  "audio-editor",
  "audio-region-label",
  "audio-start",
  "audio-end",
  "audio-volume",
  "audio-volume-value",
  "audio-mute",
  "audio-mute-label",
  "audio-fade-in",
  "audio-fade-in-value",
  "audio-fade-out",
  "audio-fade-out-value",
  "reset-audio-region",
  "delete-audio-region",
  "set-range-start",
  "set-range-end",
  "clear-range",
  "delete-range",
  "add-audio-region",
  "paste-image-asset",
  "add-cue",
  "subtitle-lane-count",
  "add-subtitle-lane",
  "fit-timeline",
  "timeline-zoom",
  "timeline-scroll",
  "timeline-content",
  "timeline-ruler",
  "video-track",
  "asset-track",
  "audio-track",
  "caption-tracks",
  "timeline-range-selection",
  "timeline-range-summary",
  "range-start-handle",
  "range-end-handle",
  "playhead",
  "timeline-context-menu",
  "context-set-range-start",
  "context-set-range-end",
  "context-delete-range",
  "context-add-cue",
  "context-paste-asset",
  "context-pick-asset",
  "context-add-audio",
  "context-delete-cue",
  "context-delete-asset",
  "context-delete-audio",
  "context-add-lane",
  "media-input",
  "asset-input",
  "job-dialog",
  "job-title",
  "job-message",
  "job-progress",
  "job-percent",
  "cancel-job",
  "local-draft-dialog",
  "local-draft-title",
  "local-draft-description",
  "local-draft-list",
  "local-draft-empty",
  "local-draft-status",
  "restore-local-draft",
  "close-local-draft-dialog",
  "toast"
].map((id) => [id.replaceAll("-", "_"), document.querySelector(`#${id}`)]));

const captionInspectorTab = elements.cue_selected_tab;
const positionButtons = [...document.querySelectorAll("[data-position]")];

let project = null;
let mediaFile = null;
let mediaHandle = null;
let mediaUrl = null;
let sourceBindingConnected = false;
let pixelsPerSecond = 70;
let saveTimer = null;
let imageAssetPruneTimer = null;
let toastTimer = null;
let activeClipId = null;
let undoStack = [];
let redoStack = [];
let activeJobController = null;
let pointerEditActive = false;
let inspectorMode = "selected";
let fieldEditSession = null;
let focusBeforeJob = null;
let projectMutationLockCount = 0;
let pendingCaptureSeed = null;
let exportRequestPending = false;
let activeJobCancelable = false;
let previewSeekSequence = 0;
let pendingPreviewSeek = null;
let propertyInspectorMode = "caption";
let previewVolume = 1;
let previewMuted = false;
let timelineContext = null;
let rangeStartMs = null;
let rangeEndMs = null;
let rangeHandleDragActive = false;
let liveTimelineGeometryFrame = null;
let previewAudioClockTimer = null;
let previewPlaybackFrame = null;
let standbyPreviewVideo = null;
let previewPreloadSequence = 0;
let preparedPreview = null;
let previewBoundaryTransitioning = false;
let pendingAssetTimelineMs = null;
let imageAssetRenderSequence = 0;
let localDraftAutosaveTimer = null;
let localDraftOperationQueue = Promise.resolve();
let localDraftOperationActive = false;
let automaticLocalDraftOperation = null;
let lastAutomaticDraftAtMs = 0;
let localDraftAutosaveAnchorAtMs = 0;
let focusBeforeLocalDraftDialog = null;
let captionAgentSettings = { ...DEFAULT_CAPTION_AGENT_SETTINGS };
const imageAssetObjectUrls = new Map();
const clipGroupSelection = new Set();

const EXPORT_LOCK_NAME = "chzzk-kirinuki-export";
const MAX_IMAGE_ASSET_BYTES = 25 * 1024 * 1024;
const MAX_IMAGE_ASSET_DIMENSION = 8192;
const MAX_IMAGE_ASSET_PIXELS = 40_000_000;
const ASSET_TRACK_BASE_HEIGHT_PX = 54;
const ASSET_SUBROW_STRIDE_PX = 47;
const ASSET_BLOCK_TOP_PX = 7;
const MIN_TIMELINE_RANGE_MS = 100;
const PREVIEW_AUDIO_CLOCK_INTERVAL_MS = 10;
const PREVIEW_PRELOAD_TIMEOUT_MS = 12_000;
const LOCAL_DRAFT_AUTOSAVE_INTERVAL_MS = 5 * 60 * 1_000;
const LOCAL_DRAFT_BUSY_RETRY_MS = 30 * 1_000;
const ALLOWED_IMAGE_ASSET_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif"
]);
const cloneProject = (value) => structuredClone(value);

function formatTime(milliseconds, { compact = false } = {}) {
  const value = Math.max(0, Math.round(Number(milliseconds) || 0));
  const hours = Math.floor(value / 3_600_000);
  const minutes = Math.floor((value % 3_600_000) / 60_000);
  const seconds = Math.floor((value % 60_000) / 1000);
  const millis = value % 1000;
  if (compact && hours === 0) {
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
  }
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

function parseTime(value) {
  const input = String(value || "").trim();
  if (!input) {
    return null;
  }
  if (/^\d+(?:\.\d+)?$/.test(input)) {
    return Math.round(Number(input) * 1000);
  }
  const parts = input.split(":");
  if (parts.length < 2 || parts.length > 3) {
    return null;
  }
  const seconds = Number(parts.at(-1));
  const minutes = Number(parts.at(-2));
  const hours = parts.length === 3 ? Number(parts[0]) : 0;
  if (![seconds, minutes, hours].every(Number.isFinite) || minutes < 0 || minutes >= 60 || seconds < 0 || seconds >= 60) {
    return null;
  }
  return Math.round((hours * 3600 + minutes * 60 + seconds) * 1000);
}

function formatDuration(milliseconds) {
  const seconds = Math.max(0, milliseconds / 1000);
  if (seconds < 60) {
    return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}초`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return `${minutes}분 ${remainder}초`;
}

function clipOutsideMedia(candidateProject = project) {
  const durationMs = Number(candidateProject?.mediaAsset?.durationMs);
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return null;
  }
  return candidateProject.clips.find((clip) => (
    clip.enabled !== false &&
    (clip.sourceStartMs < 0 || clip.sourceEndMs > durationMs)
  )) || null;
}

function sanitizeFileName(value) {
  return String(value || "kirinuki")
    .normalize("NFKC")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "kirinuki";
}

function showToast(message, type = "info", timeout = 3600) {
  clearTimeout(toastTimer);
  toastTimer = null;
  elements.toast.textContent = message;
  elements.toast.className = `toast ${type}`;
  elements.toast.setAttribute("role", type === "error" ? "alert" : "status");
  elements.toast.setAttribute("aria-live", type === "error" ? "assertive" : "polite");
  elements.toast.hidden = false;
  if (timeout > 0) {
    toastTimer = setTimeout(() => {
      elements.toast.hidden = true;
      toastTimer = null;
    }, timeout);
  }
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    void saveProject(project)
      .then(() => scheduleImageAssetBlobPrune())
      .catch((error) => {
        showToast(`프로젝트 저장 실패: ${error.message}`, "error", 0);
      });
  }, 180);
}

function flushSave() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!project) {
    return Promise.resolve();
  }
  return saveProject(project).then((savedProject) => {
    scheduleImageAssetBlobPrune();
    return savedProject;
  });
}

const localDraftDateFormatter = new Intl.DateTimeFormat("ko-KR", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit"
});

function localDraftReasonLabel(reason) {
  return {
    manual: "수동",
    auto: "자동",
    "pre-restore": "복원 직전"
  }[reason] || "임시";
}

function setLocalDraftOperationActive(active) {
  localDraftOperationActive = Boolean(active);
  elements.create_local_draft.disabled = localDraftOperationActive;
  elements.open_local_drafts.disabled = localDraftOperationActive;
  elements.close_local_draft_dialog.disabled = localDraftOperationActive;
  const selectedDraft = elements.local_draft_list.querySelector(
    'input[name="local-draft-choice"]:checked'
  );
  elements.restore_local_draft.disabled = (
    localDraftOperationActive || !selectedDraft
  );
  for (const input of elements.local_draft_list.querySelectorAll("input")) {
    input.disabled = localDraftOperationActive;
  }
}

function queueLocalDraftOperation(operation) {
  const queued = localDraftOperationQueue
    .catch(() => undefined)
    .then(async () => {
      setLocalDraftOperationActive(true);
      try {
        return await operation();
      } finally {
        setLocalDraftOperationActive(false);
      }
    });
  localDraftOperationQueue = queued.catch(() => undefined);
  return queued;
}

function localDraftSummary(draft) {
  const snapshot = draft?.project || {};
  return [
    `컷 ${snapshot.clips?.length || 0}`,
    `자막 ${snapshot.subtitles?.length || 0}`,
    `에셋 ${snapshot.imageAssets?.length || 0}`,
    `음성 ${snapshot.audioRegions?.length || 0}`
  ].join(" · ");
}

function updateLocalDraftStatus(drafts = []) {
  const count = Math.min(5, drafts.length);
  const lastAutoText = lastAutomaticDraftAtMs > 0
    ? ` · 마지막 자동 ${localDraftDateFormatter.format(lastAutomaticDraftAtMs)}`
    : "";
  elements.local_draft_status.textContent = (
    `최근 ${count}/5개 · 5분마다 자동 저장${lastAutoText}`
  );
  elements.open_local_drafts.title = (
    `최근 임시저장 ${count}개 불러오기`
  );
}

function renderLocalDraftList(drafts, selectedId = "") {
  const fragment = document.createDocumentFragment();
  for (const draft of drafts) {
    const label = document.createElement("label");
    label.className = "local-draft-item";

    const input = document.createElement("input");
    input.type = "radio";
    input.name = "local-draft-choice";
    input.value = draft.id;
    input.checked = draft.id === selectedId;
    input.disabled = localDraftOperationActive;
    input.addEventListener("change", () => {
      elements.restore_local_draft.disabled = localDraftOperationActive;
    });

    const copy = document.createElement("span");
    copy.className = "local-draft-item-copy";

    const heading = document.createElement("span");
    heading.className = "local-draft-item-heading";

    const reason = document.createElement("span");
    reason.className = `local-draft-reason ${draft.reason || "manual"}`;
    reason.textContent = localDraftReasonLabel(draft.reason);

    const time = document.createElement("time");
    time.dateTime = draft.createdAt;
    time.textContent = localDraftDateFormatter.format(
      new Date(draft.createdAtMs || draft.createdAt)
    );
    heading.append(time, reason);

    const summary = document.createElement("span");
    summary.className = "local-draft-item-meta";
    summary.textContent = localDraftSummary(draft);

    copy.append(heading, summary);
    label.append(input, copy);
    fragment.append(label);
  }
  elements.local_draft_list.replaceChildren(fragment);
  elements.local_draft_empty.hidden = drafts.length > 0;
  elements.restore_local_draft.disabled = (
    localDraftOperationActive ||
    !elements.local_draft_list.querySelector(
      'input[name="local-draft-choice"]:checked'
    )
  );
  updateLocalDraftStatus(drafts);
}

async function refreshLocalDraftList({ preserveSelection = true } = {}) {
  const selectedId = preserveSelection
    ? elements.local_draft_list.querySelector(
      'input[name="local-draft-choice"]:checked'
    )?.value || ""
    : "";
  const drafts = await listLocalDrafts(project.id, { limit: 5 });
  renderLocalDraftList(drafts, selectedId);
  return drafts;
}

async function saveCurrentLocalDraft(reason, {
  restoredFromDraftId = null,
  announce = false
} = {}) {
  if (!project?.id) {
    throw new Error("임시저장할 프로젝트가 없습니다.");
  }
  if (reason !== "auto") {
    fieldEditSession = null;
  }
  clearTimeout(saveTimer);
  saveTimer = null;
  const snapshot = cloneProject(project);
  const draft = await saveLocalDraft(snapshot, {
    reason,
    restoredFromDraftId,
    now: Date.now(),
    id: crypto.randomUUID()
  });
  if (reason === "auto") {
    lastAutomaticDraftAtMs = draft.createdAtMs;
    localDraftAutosaveAnchorAtMs = draft.createdAtMs;
  }
  scheduleImageAssetBlobPrune();
  if (elements.local_draft_dialog.open) {
    await refreshLocalDraftList();
  } else {
    const drafts = await listLocalDrafts(project.id, { limit: 5 });
    updateLocalDraftStatus(drafts);
  }
  if (announce) {
    showToast("현재 상태를 이 기기에 임시저장했습니다.", "success");
  }
  return draft;
}

function createManualLocalDraft() {
  void queueLocalDraftOperation(() => (
    saveCurrentLocalDraft("manual", { announce: true })
  )).catch((error) => {
    showToast(`임시저장 실패: ${error.message}`, "error", 0);
  });
}

function localDraftAutosaveBlocked() {
  return (
    !project ||
    pointerEditActive ||
    rangeHandleDragActive ||
    projectMutationLockCount > 0 ||
    Boolean(activeJobController) ||
    !elements.job_dialog.hidden ||
    elements.local_draft_dialog.open ||
    localDraftOperationActive
  );
}

function scheduleLocalDraftAutosave(delayMs = LOCAL_DRAFT_AUTOSAVE_INTERVAL_MS) {
  clearTimeout(localDraftAutosaveTimer);
  localDraftAutosaveTimer = setTimeout(() => {
    localDraftAutosaveTimer = null;
    void runAutomaticLocalDraft();
  }, Math.max(0, delayMs));
}

function runAutomaticLocalDraft() {
  if (automaticLocalDraftOperation) {
    return automaticLocalDraftOperation;
  }
  if (localDraftAutosaveBlocked()) {
    scheduleLocalDraftAutosave(LOCAL_DRAFT_BUSY_RETRY_MS);
    return Promise.resolve(null);
  }
  automaticLocalDraftOperation = queueLocalDraftOperation(
    () => saveCurrentLocalDraft("auto")
  )
    .catch((error) => {
      console.warn("5분 자동 임시저장에 실패했습니다.", error);
      showToast(`자동 임시저장 실패: ${error.message}`, "error", 0);
      return null;
    })
    .finally(() => {
      automaticLocalDraftOperation = null;
      scheduleLocalDraftAutosave();
    });
  return automaticLocalDraftOperation;
}

async function openLocalDraftDialog() {
  if (!elements.job_dialog.hidden) {
    showToast("진행 중인 작업이 끝난 뒤 임시저장 기록을 열어 주세요.");
    return;
  }
  focusBeforeLocalDraftDialog = elements.open_local_drafts;
  try {
    const drafts = await queueLocalDraftOperation(() => (
      refreshLocalDraftList({ preserveSelection: false })
    ));
    elements.local_draft_dialog.hidden = false;
    if (!elements.local_draft_dialog.open) {
      elements.local_draft_dialog.showModal();
    }
    const firstInput = elements.local_draft_list.querySelector("input");
    (firstInput || elements.close_local_draft_dialog).focus();
    updateLocalDraftStatus(drafts);
  } catch (error) {
    showToast(`임시저장 목록을 열지 못했습니다: ${error.message}`, "error", 0);
  }
}

function closeLocalDraftDialog() {
  if (elements.local_draft_dialog.open) {
    elements.local_draft_dialog.close();
  }
  elements.local_draft_dialog.hidden = true;
}

async function countSameProjectEditorTabs() {
  const editorUrl = chrome.runtime.getURL("editor.html");
  const tabs = await chrome.tabs.query({});
  return tabs.filter((tab) => {
    if (!String(tab.url || "").startsWith(editorUrl)) {
      return false;
    }
    try {
      return new URL(tab.url).searchParams.get("project") === project.id;
    } catch {
      return false;
    }
  }).length;
}

async function restoreSelectedLocalDraft() {
  const selectedId = elements.local_draft_list.querySelector(
    'input[name="local-draft-choice"]:checked'
  )?.value;
  if (!selectedId) {
    return;
  }
  await queueLocalDraftOperation(async () => {
    if (await countSameProjectEditorTabs() > 1) {
      throw new Error(
        "같은 프로젝트 편집기 탭이 둘 이상 열려 있습니다. 다른 탭을 닫고 다시 불러와 주세요."
      );
    }
    const draft = await loadLocalDraft(project.id, selectedId);
    if (!draft) {
      throw new Error("선택한 임시저장을 찾지 못했습니다.");
    }
    const restoredProject = normalizeEditorProject(
      cloneProject(draft.project)
    );
    if (!restoredProject || restoredProject.id !== project.id) {
      throw new Error("다른 프로젝트의 임시저장은 불러올 수 없습니다.");
    }

    const currentProject = cloneProject(project);
    elements.preview_video.pause();
    stopPreviewAudioClock({ sync: false });
    closeTimelineContextMenu();
    lockProjectMutations();
    try {
      clearTimeout(saveTimer);
      saveTimer = null;
      await restoreLocalDraft(currentProject, draft, {
        now: Date.now(),
        id: crypto.randomUUID()
      });
      project = restoredProject;
      undoStack = [currentProject];
      redoStack = [];
      fieldEditSession = null;
      pendingPreviewSeek = null;
      activeClipId = null;
      clearTimelineRangeSelection({ render: false });
      releaseAllImageAssetObjectUrls();
      renderAll();
      await syncPreviewToPlayhead();
      scheduleImageAssetBlobPrune();
      closeLocalDraftDialog();
      try {
        updateLocalDraftStatus(
          await listLocalDrafts(project.id, { limit: 5 })
        );
      } catch (error) {
        console.warn("복원 뒤 임시저장 상태를 갱신하지 못했습니다.", error);
      }
      showToast(
        "임시저장을 불러왔습니다. 직전 상태도 자동으로 임시저장했습니다.",
        "success",
        5200
      );
    } finally {
      unlockProjectMutations();
    }
  }).catch((error) => {
    showToast(`임시저장 불러오기 실패: ${error.message}`, "error", 0);
  });
}

function startLocalDraftAutosave() {
  localDraftAutosaveAnchorAtMs = Date.now();
  scheduleLocalDraftAutosave();
}

function stopLocalDraftAutosave() {
  clearTimeout(localDraftAutosaveTimer);
  localDraftAutosaveTimer = null;
}

function collectImageAssetBlobKeys(candidateProject, keys) {
  for (const asset of candidateProject?.imageAssets || []) {
    if (asset.source?.kind === "blob-key" && asset.source.value) {
      keys.add(String(asset.source.value));
    }
  }
}

async function pruneUnusedImageAssetBlobs() {
  if (!project?.id) {
    return 0;
  }
  const projectId = project.id;
  const editorUrl = chrome.runtime.getURL("editor.html");
  const editorTabs = await chrome.tabs.query({});
  const sameProjectTabs = editorTabs.filter((tab) => {
    if (!String(tab.url || "").startsWith(editorUrl)) {
      return false;
    }
    try {
      return new URL(tab.url).searchParams.get("project") === projectId;
    } catch {
      return false;
    }
  });
  if (sameProjectTabs.length > 1) {
    return 0;
  }
  const keep = new Set();
  collectImageAssetBlobKeys(project, keep);
  for (const snapshot of undoStack) {
    collectImageAssetBlobKeys(snapshot, keep);
  }
  for (const snapshot of redoStack) {
    collectImageAssetBlobKeys(snapshot, keep);
  }
  collectImageAssetBlobKeys(fieldEditSession?.snapshot, keep);

  return pruneImageAssetBlobs(projectId, keep);
}

function scheduleImageAssetBlobPrune() {
  clearTimeout(imageAssetPruneTimer);
  imageAssetPruneTimer = setTimeout(() => {
    imageAssetPruneTimer = null;
    void pruneUnusedImageAssetBlobs().catch((error) => {
      console.warn("사용하지 않는 이미지 에셋 데이터를 정리하지 못했습니다.", error);
    });
  }, 3_000);
}

function pushUndo(snapshot) {
  undoStack.push(snapshot);
  if (undoStack.length > 60) {
    undoStack.shift();
  }
  redoStack = [];
}

function applyProject(next, {
  record = true,
  render = true,
  save = true
} = {}) {
  if (!next || next === project) {
    return;
  }
  if (record) {
    pushUndo(cloneProject(project));
  }
  project = next;
  if (render) {
    renderAll();
  }
  if (save) {
    scheduleSave();
  }
}

function lockProjectMutations() {
  projectMutationLockCount += 1;
  if (project) {
    renderTimelineRange();
  }
}

function unlockProjectMutations() {
  projectMutationLockCount = Math.max(0, projectMutationLockCount - 1);
  if (project) {
    renderTimelineRange();
  }
  if (projectMutationLockCount === 0) {
    flushPendingCaptureSeed();
  }
}

function applyFieldProject(next, key) {
  if (!next || next === project) {
    return;
  }
  if (!fieldEditSession || fieldEditSession.key !== key) {
    fieldEditSession = {
      key,
      snapshot: cloneProject(project),
      recorded: false
    };
  }
  if (!fieldEditSession.recorded) {
    pushUndo(fieldEditSession.snapshot);
    fieldEditSession.recorded = true;
  }
  project = next;
  renderAll({ keepScroll: true });
  scheduleSave();
}

function endFieldEdit(key) {
  if (!fieldEditSession || (key && fieldEditSession.key !== key)) {
    return;
  }
  fieldEditSession = null;
  renderHeader();
  void flushSave().catch((error) => {
    showToast(`프로젝트 저장 실패: ${error.message}`, "error", 0);
  });
}

function undo() {
  fieldEditSession = null;
  const previous = undoStack.pop();
  if (!previous) {
    return;
  }
  redoStack.push(cloneProject(project));
  project = previous;
  clearTimelineRangeSelection({ render: false });
  renderAll();
  scheduleSave();
  void syncPreviewToPlayhead();
}

function redo() {
  fieldEditSession = null;
  const next = redoStack.pop();
  if (!next) {
    return;
  }
  undoStack.push(cloneProject(project));
  project = next;
  clearTimelineRangeSelection({ render: false });
  renderAll();
  scheduleSave();
  void syncPreviewToPlayhead();
}

function selectedCue() {
  return project.subtitles.find((cue) => cue.id === project.selectedCueId) || null;
}

function selectedAudioRegion() {
  return project.audioRegions.find((region) => region.id === project.selectedAudioRegionId) || null;
}

function selectedImageAsset() {
  return (project.imageAssets || []).find((asset) => asset.id === project.selectedImageAssetId) || null;
}

function selectedClip() {
  return project.clips.find((clip) => clip.id === project.selectedClipId) || project.clips[0] || null;
}

function formatFileSize(bytes) {
  const value = Math.max(0, Number(bytes) || 0);
  if (value >= 1024 * 1024) {
    return `${(value / (1024 * 1024)).toFixed(value >= 10 * 1024 * 1024 ? 0 : 1)}MB`;
  }
  return `${Math.max(1, Math.round(value / 1024))}KB`;
}

function releaseImageAssetObjectUrl(assetId) {
  const cached = imageAssetObjectUrls.get(assetId);
  if (cached?.url) {
    URL.revokeObjectURL(cached.url);
  }
  imageAssetObjectUrls.delete(assetId);
}

function releaseAllImageAssetObjectUrls() {
  for (const assetId of imageAssetObjectUrls.keys()) {
    releaseImageAssetObjectUrl(assetId);
  }
}

async function resolveImageAssetUrl(asset) {
  if (!asset?.source) {
    return null;
  }
  if (asset.source.kind === "data-url") {
    return /^data:image\/(?:png|jpeg|webp|gif);base64,/i.test(asset.source.value)
      ? asset.source.value
      : null;
  }
  if (asset.source.kind !== "blob-key") {
    return null;
  }
  const sourceKey = `${asset.source.kind}:${asset.source.value}`;
  const cached = imageAssetObjectUrls.get(asset.id);
  if (cached?.sourceKey === sourceKey) {
    return cached.url;
  }
  releaseImageAssetObjectUrl(asset.id);
  const blob = await loadImageAssetBlob(project.id, asset.source.value);
  if (!(blob instanceof Blob) || !ALLOWED_IMAGE_ASSET_TYPES.has(blob.type)) {
    return null;
  }
  const afterLoad = imageAssetObjectUrls.get(asset.id);
  if (afterLoad?.sourceKey === sourceKey) {
    return afterLoad.url;
  }
  const assetStillPresent = project.imageAssets?.some((candidate) => (
    candidate.id === asset.id &&
    candidate.source?.kind === asset.source.kind &&
    candidate.source?.value === asset.source.value
  ));
  if (!assetStillPresent) {
    return null;
  }
  releaseImageAssetObjectUrl(asset.id);
  const url = URL.createObjectURL(blob);
  imageAssetObjectUrls.set(asset.id, { sourceKey, url });
  return url;
}

function renderHeader() {
  if (elements.project_name.value !== project.name && document.activeElement !== elements.project_name) {
    elements.project_name.value = project.name;
  }
  const sourcePlatform = String(project.source?.platform || "CHZZK").toUpperCase();
  const sourceType = String(project.source?.contentType || "UNKNOWN").toUpperCase();
  elements.source_kind.textContent = sourceType === "UNKNOWN"
    ? sourcePlatform
    : `${sourcePlatform} · ${sourceType}`;
  elements.source_title.textContent = [
    project.source?.streamerName,
    project.source?.broadcastTitle
  ].filter(Boolean).join(" · ") || "키리누키 프로젝트";
  elements.source_link_state.classList.toggle("connected", sourceBindingConnected);
  elements.source_link_state.title = sourceBindingConnected
    ? "원래 영상 탭과 연결됨"
    : "원래 영상 탭을 찾지 못함";
  elements.undo.disabled = undoStack.length === 0;
  elements.redo.disabled = redoStack.length === 0;
  elements.export_video.disabled = !mediaFile || !project.clips.some((clip) => clip.enabled !== false);
  if (
    !activeJobController &&
    document.activeElement !== elements.caption_model &&
    [...elements.caption_model.options].some((option) => option.value === project.ai?.model)
  ) {
    elements.caption_model.value = project.ai.model;
  }
  if (document.activeElement !== elements.caption_style_preset) {
    elements.caption_style_preset.value = (
      project.subtitleDefaults?.stylePresetId
      || DEFAULT_CAPTION_STYLE_PRESET_ID
    );
  }
  const warnings = Array.isArray(project.ai?.warnings)
    ? project.ai.warnings.filter((warning) => (
      warning &&
      typeof warning.code === "string" &&
      warning.code.trim()
    ))
    : [];
  elements.caption_agent_warning.hidden = warnings.length === 0;
  if (warnings.length > 0) {
    const warningLabels = {
      NO_RECOGNIZABLE_SPEECH: "인식된 발화 없음",
      LOCAL_VISUAL_ANALYSIS_FAILED: "화면 위치 분석 실패·하단 기본값 사용",
      DROPPED_INVALID_CUE: "유효하지 않은 자막 제외",
      DROPPED_EMPTY_RANGE: "빈 시간 자막 제외",
      EXPANDED_SHORT_CUE: "0.1초 미만 자막 자동 보정",
      TRIMMED_LONG_TEXT: "긴 텍스트 축약",
      SPLIT_LONG_CUE: "4초 이하로 자동 분할",
      TRIMMED_WARNING_COUNT: "추가 처리 경고 생략",
      TRIMMED_CUE_COUNT: "자막 개수 상한으로 일부 제외",
      HARNESS_NORMALIZED_CUE_TEXT: "공백·종결 마침표 정리",
      HARNESS_SPLIT_CUE: "한 줄 길이·읽기속도 기준 시간 분할",
      HARNESS_EXPANDED_CUE_RANGE: "읽을 시간 확보",
      HARNESS_EXPANDED_SHORT_CUE: "짧은 자막 표시시간 확보",
      HARNESS_STABILIZED_PLACEMENT: "완성본 기준 하단 고정",
      HARNESS_REPAIRED_SAME_SPEAKER_OVERLAP: "같은 화자 겹침 보정",
      HARNESS_READING_RATE_EXCEEDED: "읽기속도 재검수 필요",
      HARNESS_TRANSCRIPT_COVERAGE_LOW: "STT 대비 발화 누락 가능성",
      HARNESS_TRANSCRIPT_PRECISION_LOW: "STT에 없는 문구 가능성",
      HARNESS_SHORT_CUE_UNRESOLVED: "너무 짧은 자막 재검수 필요",
      HARNESS_UNRESOLVED_SAME_SPEAKER_OVERLAP: "같은 화자 겹침 재검수 필요",
      HARNESS_CUE_TEXT_TOO_WIDE: "한 줄 폭 재검수 필요",
      HARNESS_LINE_TOO_WIDE: "한 줄 폭 재검수 필요",
      HARNESS_TOO_MANY_LINES: "여러 줄 자막 재검수 필요"
    };
    const counts = new Map();
    for (const warning of warnings) {
      const label = warningLabels[warning.code] || "기타 처리 경고";
      counts.set(label, (counts.get(label) || 0) + 1);
    }
    const summary = [...counts.entries()]
      .map(([label, count]) => `${label} ${count}건`)
      .join(" · ");
    const reviewCount = warnings.filter(
      (warning) => CAPTION_REVIEW_WARNING_CODES.has(warning.code)
    ).length;
    elements.caption_agent_warning.textContent = reviewCount > 0
      ? `품질 검수 필요 ${reviewCount}건 · ${summary}. 표시된 컷 원음을 확인해 주세요.`
      : `키리누키 품질 하네스 자동 정리 ${warnings.length}건 · ${summary}`;
  } else {
    elements.caption_agent_warning.textContent = "";
  }
}

function renderMediaCard() {
  const asset = project.mediaAsset;
  elements.media_card.classList.toggle("empty", !mediaFile);
  elements.stage_empty.hidden = Boolean(mediaFile);
  if (document.activeElement !== elements.source_offset) {
    elements.source_offset.value = String((project.broadcastSession?.alignmentOffsetMs || 0) / 1000);
  }
  elements.source_offset.disabled = !mediaFile;
  elements.apply_source_offset.disabled = !mediaFile;
  if (!asset) {
    elements.media_name.textContent = "원본 영상 미연결";
    elements.media_meta.textContent = "본인 소유·사용 허가 파일을 연결하세요";
    return;
  }
  elements.media_name.textContent = asset.name;
  const dimensions = asset.width && asset.height ? ` · ${asset.width}×${asset.height}` : "";
  elements.media_meta.textContent = `${asset.sizeLabel || ""}${dimensions} · ${formatTime(asset.durationMs, { compact: true })}`;
}

function pruneClipGroupSelection() {
  const availableIds = new Set(
    project.clips.map((clip) => clip.id)
  );
  for (const clipId of clipGroupSelection) {
    if (!availableIds.has(clipId)) {
      clipGroupSelection.delete(clipId);
    }
  }
}

function clipListPositionMap() {
  return new Map(
    [...elements.clip_list.querySelectorAll(".clip-item")].map((item) => [
      item.dataset.id,
      item.getBoundingClientRect().top
    ])
  );
}

function animateClipListReorder(previousPositions) {
  if (
    !previousPositions?.size ||
    globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches
  ) {
    return;
  }
  for (const item of elements.clip_list.querySelectorAll(".clip-item")) {
    const previousTop = previousPositions.get(item.dataset.id);
    const currentTop = item.getBoundingClientRect().top;
    const delta = Number.isFinite(previousTop) ? previousTop - currentTop : 0;
    if (Math.abs(delta) < 0.5 || typeof item.animate !== "function") {
      continue;
    }
    item.animate(
      [
        { transform: `translateY(${delta}px)` },
        { transform: "translateY(0)" }
      ],
      {
        duration: 210,
        easing: "cubic-bezier(0.22, 1, 0.36, 1)"
      }
    );
  }
}

function renderClipGroupControls({ announcement = "" } = {}) {
  pruneClipGroupSelection();
  const selectedCount = clipGroupSelection.size;
  elements.clip_group_toolbar.hidden = project.clips.length === 0;
  elements.move_selected_clips_up.disabled = !canReorderClipGroup(
    project.clips,
    clipGroupSelection,
    -1
  );
  elements.move_selected_clips_down.disabled = !canReorderClipGroup(
    project.clips,
    clipGroupSelection,
    1
  );
  elements.clear_clip_group_selection.disabled = selectedCount === 0;
  const status = announcement || (
    selectedCount > 0 ? `${selectedCount}개 컷 체크됨` : "체크한 컷 없음"
  );
  if (elements.clip_group_status.textContent !== status) {
    elements.clip_group_status.textContent = status;
  }
  for (const item of elements.clip_list.querySelectorAll(".clip-item")) {
    const checked = clipGroupSelection.has(item.dataset.id);
    item.classList.toggle("clip-group-selected", checked);
    const checkbox = item.querySelector(".clip-group-checkbox");
    if (checkbox && checkbox.checked !== checked) {
      checkbox.checked = checked;
    }
  }
}

function focusClipGroupCheckbox(clipId) {
  const item = [...elements.clip_list.querySelectorAll(".clip-item")]
    .find((candidate) => candidate.dataset.id === clipId);
  item?.querySelector(".clip-group-checkbox:not(:disabled)")?.focus({
    preventScroll: true
  });
}

function focusClipGroupMoveControl(direction) {
  const requested = direction < 0
    ? elements.move_selected_clips_up
    : elements.move_selected_clips_down;
  const reverse = direction < 0
    ? elements.move_selected_clips_down
    : elements.move_selected_clips_up;
  const target = !requested.disabled
    ? requested
    : !reverse.disabled
      ? reverse
      : elements.clear_clip_group_selection;
  target?.focus({ preventScroll: true });
}

function moveSelectedClipGroup(direction, {
  restoreCheckboxClipId = null,
  focusControl = false
} = {}) {
  const nextProject = anchorPlayheadAfterClipReorder(
    reorderClipGroup(project, clipGroupSelection, direction)
  );
  if (!nextProject || nextProject === project) {
    renderClipGroupControls();
    if (restoreCheckboxClipId) {
      focusClipGroupCheckbox(restoreCheckboxClipId);
    } else if (focusControl) {
      focusClipGroupMoveControl(direction);
    }
    return false;
  }
  const previousPositions = clipListPositionMap();
  clearTimelineRangeSelection({ render: false });
  applyProject(nextProject);
  animateClipListReorder(previousPositions);
  renderClipGroupControls({
    announcement: `${clipGroupSelection.size}개 컷을 한 단계 ${direction < 0 ? "위로" : "아래로"} 이동`
  });
  if (restoreCheckboxClipId) {
    focusClipGroupCheckbox(restoreCheckboxClipId);
  } else if (focusControl) {
    focusClipGroupMoveControl(direction);
  }
  void syncPreviewToPlayhead();
  return true;
}

function anchorPlayheadAfterClipReorder(nextProject) {
  if (!nextProject || nextProject === project) {
    return nextProject;
  }
  const current = mapTimelineToSource(project, project.playheadMs);
  const anchoredPlayheadMs = current
    ? mapSourceToTimeline(nextProject, current.clipId, current.sourceMs)
    : null;
  if (anchoredPlayheadMs == null) {
    return nextProject;
  }
  activeClipId = current.clipId;
  return {
    ...nextProject,
    playheadMs: anchoredPlayheadMs,
    selectedClipId: current.clipId
  };
}

function renderClipList() {
  pruneClipGroupSelection();
  elements.clip_count.textContent = String(project.clips.length);
  elements.clip_list.replaceChildren();
  project.clips.forEach((clip, index) => {
    const fragment = elements.clip_template.content.cloneNode(true);
    const item = fragment.querySelector(".clip-item");
    const clipDisabled = clip.enabled === false;
    item.dataset.id = clip.id;
    item.classList.toggle("selected", project.selectedClipId === clip.id);
    item.classList.toggle("clip-disabled", clipDisabled);
    item.classList.toggle("clip-group-selected", clipGroupSelection.has(clip.id));
    fragment.querySelector(".clip-index").textContent = String(index + 1);
    const clipTitle = clip.note || `선택 구간 ${index + 1}`;
    fragment.querySelector(".clip-title").textContent = clipTitle;
    fragment.querySelector(".clip-time").textContent = `${formatTime(clip.sourceStartMs)} → ${formatTime(clip.sourceEndMs)}`;
    fragment.querySelector(".clip-duration").textContent = formatDuration(clipDurationMs(clip));
    const checkbox = fragment.querySelector(".clip-group-checkbox");
    checkbox.dataset.clipId = clip.id;
    checkbox.checked = clipGroupSelection.has(clip.id);
    checkbox.setAttribute(
      "aria-label",
      `${index + 1}번 컷 ${clipTitle}, 묶음 이동 선택`
    );
    checkbox.title = clipDisabled
      ? "출력 비활성 컷도 묶음 순서 이동 가능"
      : "묶음 이동할 컷 체크";
    const up = fragment.querySelector("[data-action='up']");
    const down = fragment.querySelector("[data-action='down']");
    up.disabled = index === 0;
    down.disabled = index === project.clips.length - 1;
    elements.clip_list.append(fragment);
  });
  renderClipGroupControls();
}

function renderCueInspector() {
  const cue = selectedCue();
  const showingList = inspectorMode === "list";
  elements.cue_count.textContent = String(project.subtitles.length);
  captionInspectorTab.classList.toggle("active", !showingList);
  captionInspectorTab.setAttribute("aria-selected", String(!showingList));
  captionInspectorTab.tabIndex = showingList ? -1 : 0;
  elements.cue_list_tab.classList.toggle("active", showingList);
  elements.cue_list_tab.setAttribute("aria-selected", String(showingList));
  elements.cue_list_tab.tabIndex = showingList ? 0 : -1;
  elements.cue_selected_panel.hidden = showingList;
  elements.cue_list.hidden = !showingList;
  elements.cue_empty.hidden = Boolean(cue);
  elements.cue_editor.hidden = !cue;
  if (!cue || showingList) {
    return;
  }
  elements.cue_review_note.hidden = !(
    cue.origin === "ai" &&
    cue.remoteMeta?.reviewRequired &&
    !cue.humanEdited
  );
  const range = cueTimelineRange(project, cue);
  if (document.activeElement !== elements.cue_text) {
    elements.cue_text.value = cue.text;
  }
  if (document.activeElement !== elements.cue_start) {
    elements.cue_start.value = formatTime(range.startMs, { compact: true });
  }
  if (document.activeElement !== elements.cue_end) {
    elements.cue_end.value = formatTime(range.endMs, { compact: true });
  }
  elements.cue_x.value = String(Math.round(cue.x * 100));
  elements.cue_y.value = String(Math.round(cue.y * 100));
  elements.cue_x_value.textContent = `${Math.round(cue.x * 100)}%`;
  elements.cue_y_value.textContent = `${Math.round(cue.y * 100)}%`;
  elements.font_size.value = String((project.subtitleDefaults.fontScale || 0.0675) * 100);
  elements.font_color.value = cue.color || project.subtitleDefaults.color || "#ffffff";
  const position = cue.y < 0.34 ? "top" : cue.y > 0.67 ? "bottom" : "center";
  positionButtons.forEach((button) => button.classList.toggle("active", button.dataset.position === position));
}

function renderImageAssetInspector() {
  const asset = selectedImageAsset();
  elements.asset_empty.hidden = Boolean(asset);
  elements.asset_editor.hidden = !asset;
  if (!asset) {
    elements.asset_thumbnail.removeAttribute("src");
    elements.asset_thumbnail.alt = "";
    return;
  }
  const range = imageAssetTimelineRange(project, asset);
  elements.asset_name.textContent = asset.name;
  elements.asset_meta.textContent = [
    asset.naturalWidth && asset.naturalHeight
      ? `${asset.naturalWidth}×${asset.naturalHeight}`
      : null,
    asset.mimeType?.replace("image/", "").toUpperCase(),
    asset.mimeType === "image/png" || asset.mimeType === "image/webp"
      ? "투명 배경 지원"
      : null
  ].filter(Boolean).join(" · ");
  if (document.activeElement !== elements.asset_start) {
    elements.asset_start.value = formatTime(range?.startMs || 0, { compact: true });
  }
  if (document.activeElement !== elements.asset_end) {
    elements.asset_end.value = formatTime(range?.endMs || 0, { compact: true });
  }
  const xPercent = Math.round(asset.x * 100);
  const yPercent = Math.round(asset.y * 100);
  const scalePercent = Math.round(asset.scale * 100);
  const opacityPercent = Math.round(asset.opacity * 100);
  elements.asset_x.value = String(xPercent);
  elements.asset_y.value = String(yPercent);
  elements.asset_x_value.textContent = `${xPercent}%`;
  elements.asset_y_value.textContent = `${yPercent}%`;
  elements.asset_scale.value = String(scalePercent);
  elements.asset_scale_value.textContent = `${scalePercent}%`;
  elements.asset_opacity.value = String(opacityPercent);
  elements.asset_opacity_value.textContent = `${opacityPercent}%`;
  elements.asset_thumbnail.alt = `${asset.name} 미리보기`;
  const selectedId = asset.id;
  void resolveImageAssetUrl(asset).then((url) => {
    if (selectedImageAsset()?.id !== selectedId) {
      return;
    }
    if (url) {
      elements.asset_thumbnail.src = url;
    } else {
      elements.asset_thumbnail.removeAttribute("src");
    }
  }).catch((error) => {
    console.warn("이미지 에셋 미리보기를 불러오지 못했습니다.", error);
    elements.asset_thumbnail.removeAttribute("src");
  });
}

function renderAudioInspector() {
  const region = selectedAudioRegion();
  elements.audio_empty.hidden = Boolean(region);
  elements.audio_editor.hidden = !region;
  if (!region) {
    return;
  }
  const range = audioRegionTimelineRange(project, region);
  const clipIndex = project.clips.findIndex((clip) => clip.id === region.clipId);
  elements.audio_region_label.textContent = `${clipIndex + 1}번 컷 · 음성 설정`;
  if (document.activeElement !== elements.audio_start) {
    elements.audio_start.value = formatTime(range.startMs, { compact: true });
  }
  if (document.activeElement !== elements.audio_end) {
    elements.audio_end.value = formatTime(range.endMs, { compact: true });
  }
  const gainPercent = Math.round(region.gain * 100);
  elements.audio_volume.value = String(gainPercent);
  elements.audio_volume_value.textContent = `${gainPercent}%`;
  elements.audio_mute.classList.toggle("active", region.muted);
  elements.audio_mute.setAttribute("aria-pressed", String(region.muted));
  elements.audio_mute_label.textContent = region.muted
    ? "이 구간 음소거 해제"
    : "이 구간 음소거";
  const durationMs = Math.max(0, region.endOffsetMs - region.startOffsetMs);
  const maximumFadeMs = Math.min(3_000, durationMs);
  elements.audio_fade_in.max = String(maximumFadeMs);
  elements.audio_fade_out.max = String(maximumFadeMs);
  elements.audio_fade_in.value = String(Math.min(region.fadeInMs, maximumFadeMs));
  elements.audio_fade_out.value = String(Math.min(region.fadeOutMs, maximumFadeMs));
  elements.audio_fade_in_value.textContent = `${(region.fadeInMs / 1000).toFixed(1)}초`;
  elements.audio_fade_out_value.textContent = `${(region.fadeOutMs / 1000).toFixed(1)}초`;
}

function renderPropertyInspector() {
  const showingAudio = propertyInspectorMode === "audio";
  const showingAsset = propertyInspectorMode === "asset";
  const showingCaption = !showingAudio && !showingAsset;
  elements.caption_mode_tab.classList.toggle("active", showingCaption);
  elements.caption_mode_tab.setAttribute("aria-selected", String(showingCaption));
  elements.caption_mode_tab.tabIndex = showingCaption ? 0 : -1;
  elements.asset_mode_tab.classList.toggle("active", showingAsset);
  elements.asset_mode_tab.setAttribute("aria-selected", String(showingAsset));
  elements.asset_mode_tab.tabIndex = showingAsset ? 0 : -1;
  elements.audio_mode_tab.classList.toggle("active", showingAudio);
  elements.audio_mode_tab.setAttribute("aria-selected", String(showingAudio));
  elements.audio_mode_tab.tabIndex = showingAudio ? 0 : -1;
  elements.caption_inspector_content.hidden = !showingCaption;
  elements.asset_inspector_content.hidden = !showingAsset;
  elements.audio_inspector_content.hidden = !showingAudio;
  elements.inspector_overline.textContent = showingAudio
    ? "VOICE"
    : showingAsset
      ? "IMAGE ASSETS"
      : "CAPTIONS";
  elements.inspector_title.textContent = showingAudio
    ? "구간별 음성"
    : showingAsset
      ? "영상 위 이미지"
      : "한글 자막";
  elements.add_cue_top.hidden = !showingCaption;
  renderCueInspector();
  renderImageAssetInspector();
  renderAudioInspector();
}

function renderCueList() {
  elements.cue_list.replaceChildren();
  const sorted = [...project.subtitles].sort((a, b) => {
    const rangeA = cueTimelineRange(project, a);
    const rangeB = cueTimelineRange(project, b);
    return (rangeA?.startMs || 0) - (rangeB?.startMs || 0);
  });
  sorted.forEach((cue) => {
    const range = cueTimelineRange(project, cue);
    if (!range) {
      return;
    }
    const button = document.createElement("button");
    button.type = "button";
    button.className = "cue-list-item";
    button.classList.toggle("selected", cue.id === project.selectedCueId);
    const reviewRequired = (
      cue.origin === "ai" &&
      cue.remoteMeta?.reviewRequired &&
      !cue.humanEdited
    );
    button.classList.toggle("review-required", reviewRequired);
    if (reviewRequired) {
      button.title = "AI가 불명확한 발화로 표시함 · 원음 재확인 필요";
    }
    button.dataset.id = cue.id;
    const time = document.createElement("time");
    time.textContent = `L${cue.lane + 1} · ${formatTime(range.startMs, { compact: true }).slice(0, -4)}`;
    const text = document.createElement("span");
    text.textContent = cue.text || "(빈 자막)";
    button.append(time, text);
    elements.cue_list.append(button);
  });
}

function timelineWidth() {
  const durationSeconds = Math.max(1, projectDurationMs(project) / 1000);
  const viewport = elements.timeline_scroll.clientWidth || 700;
  return Math.max(viewport - 2, Math.ceil(durationSeconds * pixelsPerSecond));
}

function timelineX(milliseconds) {
  return milliseconds / 1000 * pixelsPerSecond;
}

function clampTimelineMs(milliseconds) {
  return Math.max(
    0,
    Math.min(projectDurationMs(project), Math.round(Number(milliseconds) || 0))
  );
}

function selectedTimelineRange() {
  if (!Number.isFinite(rangeStartMs) || !Number.isFinite(rangeEndMs)) {
    return null;
  }
  const startMs = Math.min(rangeStartMs, rangeEndMs);
  const endMs = Math.max(rangeStartMs, rangeEndMs);
  return endMs - startMs >= MIN_TIMELINE_RANGE_MS
    ? { startMs, endMs }
    : null;
}

function renderTimelineRange() {
  if (!project) {
    return;
  }
  const durationMs = projectDurationMs(project);
  if (Number.isFinite(rangeStartMs)) {
    rangeStartMs = Math.max(0, Math.min(durationMs, Math.round(rangeStartMs)));
  }
  if (Number.isFinite(rangeEndMs)) {
    rangeEndMs = Math.max(0, Math.min(durationMs, Math.round(rangeEndMs)));
  }
  const hasStart = Number.isFinite(rangeStartMs);
  const hasEnd = Number.isFinite(rangeEndMs);
  const rawRange = hasStart && hasEnd
    ? {
      startMs: Math.min(rangeStartMs, rangeEndMs),
      endMs: Math.max(rangeStartMs, rangeEndMs)
    }
    : null;
  const range = selectedTimelineRange();
  const anchorMs = rawRange?.startMs ?? (hasStart ? rangeStartMs : rangeEndMs);
  const endMs = rawRange?.endMs ?? anchorMs;

  elements.set_range_start.classList.toggle("active", hasStart);
  elements.set_range_start.setAttribute("aria-pressed", String(hasStart));
  elements.set_range_start.disabled = durationMs === 0;
  elements.set_range_end.classList.toggle("active", hasEnd);
  elements.set_range_end.setAttribute("aria-pressed", String(hasEnd));
  elements.set_range_end.disabled = durationMs === 0;
  elements.clear_range.hidden = !hasStart && !hasEnd;
  elements.delete_range.disabled = (
    !range ||
    projectMutationLockCount > 0 ||
    pointerEditActive ||
    rangeHandleDragActive
  );

  elements.timeline_range_selection.hidden = !hasStart && !hasEnd;
  elements.timeline_range_selection.classList.toggle("valid", Boolean(range));
  elements.timeline_range_selection.style.left = `${timelineX(anchorMs || 0)}px`;
  elements.timeline_range_selection.style.width = `${timelineX(Math.max(0, (endMs || 0) - (anchorMs || 0)))}px`;
  elements.range_start_handle.hidden = !hasStart;
  elements.range_end_handle.hidden = !hasEnd;

  const updateHandle = (handle, valueMs, minimumMs, maximumMs) => {
    handle.setAttribute("aria-valuemin", String(Math.max(0, minimumMs) / 1000));
    handle.setAttribute("aria-valuemax", String(Math.max(minimumMs, maximumMs) / 1000));
    handle.setAttribute("aria-valuenow", String((valueMs || 0) / 1000));
    handle.setAttribute("aria-valuetext", formatTime(valueMs || 0));
  };
  updateHandle(
    elements.range_start_handle,
    rawRange?.startMs ?? rangeStartMs,
    0,
    range ? Math.max(0, range.endMs - MIN_TIMELINE_RANGE_MS) : durationMs
  );
  updateHandle(
    elements.range_end_handle,
    rawRange?.endMs ?? rangeEndMs,
    range ? Math.min(durationMs, range.startMs + MIN_TIMELINE_RANGE_MS) : 0,
    durationMs
  );

  elements.timeline_range_summary.hidden = !rawRange;
  elements.timeline_range_summary.textContent = range
    ? `${formatTime(range.startMs, { compact: true })}–${formatTime(range.endMs, { compact: true })} · ${formatDuration(range.endMs - range.startMs)} 삭제`
    : rawRange
      ? `${formatDuration(rawRange.endMs - rawRange.startMs)} · 0.1초 이상 필요`
      : "";
}

function setTimelineRangeBoundary(side, milliseconds, {
  constrain = false
} = {}) {
  let valueMs = clampTimelineMs(milliseconds);
  if (side === "start") {
    if (constrain && Number.isFinite(rangeEndMs)) {
      valueMs = Math.min(valueMs, Math.max(0, rangeEndMs - MIN_TIMELINE_RANGE_MS));
    }
    rangeStartMs = valueMs;
  } else {
    if (constrain && Number.isFinite(rangeStartMs)) {
      valueMs = Math.max(valueMs, Math.min(projectDurationMs(project), rangeStartMs + MIN_TIMELINE_RANGE_MS));
    }
    rangeEndMs = valueMs;
  }
  if (!constrain && Number.isFinite(rangeStartMs) && Number.isFinite(rangeEndMs) && rangeStartMs > rangeEndMs) {
    [rangeStartMs, rangeEndMs] = [rangeEndMs, rangeStartMs];
  }
  renderTimelineRange();
}

function clearTimelineRangeSelection({ render = true } = {}) {
  rangeStartMs = null;
  rangeEndMs = null;
  if (render) {
    renderTimelineRange();
  }
}

function nudgeTimelineRangeBoundary(side, deltaMs) {
  const currentMs = side === "start" ? rangeStartMs : rangeEndMs;
  if (!Number.isFinite(currentMs)) {
    return;
  }
  setTimelineRangeBoundary(side, currentMs + deltaMs, { constrain: true });
  const handle = side === "start"
    ? elements.range_start_handle
    : elements.range_end_handle;
  handle.focus({ preventScroll: true });
}

function bindTimelineRangeHandle(handle, side, event) {
  event.preventDefault();
  event.stopPropagation();
  rangeHandleDragActive = true;
  renderTimelineRange();
  const pointerId = event.pointerId;
  handle.setPointerCapture(pointerId);
  const move = (moveEvent) => {
    if (moveEvent.pointerId !== pointerId) {
      return;
    }
    const rect = elements.timeline_content.getBoundingClientRect();
    const timelineMs = (moveEvent.clientX - rect.left) / pixelsPerSecond * 1000;
    setTimelineRangeBoundary(side, timelineMs, { constrain: true });
  };
  const finish = (finishEvent) => {
    if (finishEvent?.pointerId !== undefined && finishEvent.pointerId !== pointerId) {
      return;
    }
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", finish);
    window.removeEventListener("pointercancel", finish);
    if (handle.hasPointerCapture(pointerId)) {
      handle.releasePointerCapture(pointerId);
    }
    rangeHandleDragActive = false;
    renderTimelineRange();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", finish);
  window.addEventListener("pointercancel", finish);
}

function deleteSelectedTimelineRange() {
  const range = selectedTimelineRange();
  if (!range) {
    showToast("삭제할 구간의 시작과 끝을 0.1초 이상 벌려 지정해 주세요.", "error");
    return;
  }
  if (pointerEditActive || rangeHandleDragActive) {
    showToast("손잡이 조정을 마친 뒤 선택 구간을 삭제해 주세요.", "error");
    return;
  }
  if (projectMutationLockCount > 0) {
    showToast("진행 중인 미디어 작업이 끝난 뒤 구간을 삭제해 주세요.", "error");
    return;
  }
  elements.preview_video.pause();
  try {
    let next = rippleDeleteTimelineRange(project, range);
    const nextDurationMs = projectDurationMs(next);
    const junctionMs = Math.min(range.startMs, nextDurationMs);
    const mapping = mapTimelineToSource(next, junctionMs);
    next = {
      ...next,
      playheadMs: junctionMs,
      selectedClipId: mapping?.clipId || next.clips[0]?.id || null
    };
    clearTimelineRangeSelection({ render: false });
    applyProject(next);
    void syncPreviewToPlayhead();
    showToast(
      `${formatDuration(range.endMs - range.startMs)} 구간을 삭제했습니다. Ctrl+Z로 되돌릴 수 있습니다.`,
      "success"
    );
  } catch (error) {
    showToast(error.message, "error", 0);
  }
}

function setTimedBlockGeometry(block, range) {
  block.hidden = !range;
  if (!range) {
    return;
  }
  block.style.left = `${timelineX(range.startMs)}px`;
  block.style.width = `${Math.max(8, timelineX(range.endMs - range.startMs))}px`;
}

function syncLiveTimelineGeometry() {
  liveTimelineGeometryFrame = null;
  const width = timelineWidth();
  const clipById = new Map(project.clips.map((clip) => [clip.id, clip]));
  const cueById = new Map(project.subtitles.map((cue) => [cue.id, cue]));
  const assetById = new Map((project.imageAssets || []).map((asset) => [asset.id, asset]));
  const audioById = new Map(project.audioRegions.map((region) => [region.id, region]));
  elements.timeline_content.style.width = `${width}px`;
  elements.timeline_ruler.style.width = `${width}px`;
  for (const track of [
    elements.video_track,
    elements.asset_track,
    elements.audio_track,
    ...elements.caption_tracks.querySelectorAll(".caption-track-row")
  ]) {
    track.style.width = `${width}px`;
  }
  for (const block of elements.video_track.querySelectorAll(".clip-block")) {
    const clip = clipById.get(block.dataset.id);
    setTimedBlockGeometry(block, clip && clip.enabled !== false ? {
      startMs: clip.timelineStartMs,
      endMs: clip.timelineStartMs + clipDurationMs(clip)
    } : null);
  }
  for (const block of elements.audio_track.querySelectorAll(".audio-source-block")) {
    const clip = clipById.get(block.dataset.clipId);
    setTimedBlockGeometry(block, clip && clip.enabled !== false ? {
      startMs: clip.timelineStartMs,
      endMs: clip.timelineStartMs + clipDurationMs(clip)
    } : null);
  }
  for (const block of elements.asset_track.querySelectorAll(".asset-block")) {
    const asset = assetById.get(block.dataset.id);
    setTimedBlockGeometry(block, asset ? imageAssetTimelineRange(project, asset) : null);
  }
  for (const block of elements.audio_track.querySelectorAll(".audio-block")) {
    const region = audioById.get(block.dataset.id);
    setTimedBlockGeometry(block, region ? audioRegionTimelineRange(project, region) : null);
  }
  for (const block of elements.caption_tracks.querySelectorAll(".cue-block")) {
    const cue = cueById.get(block.dataset.id);
    setTimedBlockGeometry(block, cue ? cueTimelineRange(project, cue) : null);
  }
  const durationMs = projectDurationMs(project);
  const previewPlayheadMs = Math.max(0, Math.min(durationMs, project.playheadMs || 0));
  elements.playhead.style.left = `${timelineX(previewPlayheadMs)}px`;
  elements.current_time.textContent = formatTime(previewPlayheadMs);
  elements.duration_time.textContent = `/ ${formatTime(durationMs)}`;
  renderTimelineRange();
}

function scheduleLiveTimelineGeometry() {
  if (liveTimelineGeometryFrame !== null) {
    return;
  }
  liveTimelineGeometryFrame = requestAnimationFrame(syncLiveTimelineGeometry);
}

function layoutImageAssetSubrows(candidateProject) {
  const entries = (candidateProject.imageAssets || [])
    .map((asset, assetIndex) => ({
      asset,
      assetIndex,
      range: imageAssetTimelineRange(candidateProject, asset)
    }))
    .filter((entry) => entry.range)
    .sort((first, second) => (
      first.range.startMs - second.range.startMs ||
      first.range.endMs - second.range.endMs ||
      first.assetIndex - second.assetIndex
    ));
  const subrowEndTimes = [];
  const byAssetId = new Map();

  entries.forEach((entry) => {
    let subrow = subrowEndTimes.findIndex((endMs) => endMs <= entry.range.startMs);
    if (subrow === -1) {
      subrow = subrowEndTimes.length;
      subrowEndTimes.push(entry.range.endMs);
    } else {
      subrowEndTimes[subrow] = entry.range.endMs;
    }
    byAssetId.set(entry.asset.id, {
      range: entry.range,
      subrow
    });
  });

  return {
    byAssetId,
    subrowCount: Math.max(1, subrowEndTimes.length)
  };
}

function renderRuler(width) {
  elements.timeline_ruler.replaceChildren();
  const durationSeconds = Math.max(1, projectDurationMs(project) / 1000);
  const majorStep = pixelsPerSecond >= 160 ? 1 : pixelsPerSecond >= 90 ? 2 : pixelsPerSecond >= 45 ? 5 : 10;
  const minorStep = majorStep >= 5 ? majorStep / 5 : 1;
  for (let second = 0; second <= durationSeconds + minorStep; second += minorStep) {
    const tick = document.createElement("span");
    const major = Math.abs(second / majorStep - Math.round(second / majorStep)) < 0.001;
    tick.className = `ruler-tick${major ? " major" : ""}`;
    tick.style.left = `${second * pixelsPerSecond}px`;
    if (major) {
      const label = document.createElement("span");
      label.textContent = formatTime(second * 1000, { compact: true }).slice(0, -4);
      tick.append(label);
    }
    elements.timeline_ruler.append(tick);
  }
  elements.timeline_ruler.style.width = `${width}px`;
}

function makeHandle(side, onStart, onNudge, {
  label,
  valueMs,
  minMs,
  maxMs
} = {}) {
  const handle = document.createElement("button");
  handle.type = "button";
  handle.className = `trim-handle ${side}`;
  handle.setAttribute("role", "slider");
  handle.setAttribute("aria-orientation", "horizontal");
  handle.setAttribute("aria-label", label || (side === "left" ? "시작 시각 조정" : "끝 시각 조정"));
  handle.setAttribute("aria-valuemin", String(Math.max(0, Number(minMs) || 0) / 1000));
  handle.setAttribute("aria-valuemax", String(Math.max(Number(minMs) || 0, Number(maxMs) || 0) / 1000));
  handle.setAttribute("aria-valuenow", String(Math.max(0, Number(valueMs) || 0) / 1000));
  handle.setAttribute("aria-valuetext", formatTime(valueMs || 0));
  handle.title = "←/→ 0.1초 · Shift+←/→ 1초";
  handle.addEventListener("pointerdown", onStart);
  handle.addEventListener("keydown", (event) => {
    if (!onNudge || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const owner = handle.closest(".clip-block, .asset-block, .cue-block, .audio-block");
    const ownerId = owner?.dataset.id;
    const ownerClass = owner?.classList.contains("clip-block")
      ? "clip-block"
      : owner?.classList.contains("asset-block")
        ? "asset-block"
      : owner?.classList.contains("audio-block")
        ? "audio-block"
        : "cue-block";
    const amount = event.shiftKey ? 1_000 : 100;
    onNudge(event.key === "ArrowLeft" ? -amount : amount);
    queueMicrotask(() => {
      const nextOwner = [...document.querySelectorAll(`.${ownerClass}`)]
        .find((candidate) => candidate.dataset.id === ownerId);
      nextOwner?.querySelector(`.trim-handle.${side}`)?.focus({ preventScroll: true });
    });
  });
  return handle;
}

function beginPointerHistory() {
  if (!pointerEditActive) {
    pushUndo(cloneProject(project));
    pointerEditActive = true;
    renderTimelineRange();
  }
}

function endPointerHistory({ clipStructureChanged = false } = {}) {
  pointerEditActive = false;
  if (liveTimelineGeometryFrame !== null) {
    cancelAnimationFrame(liveTimelineGeometryFrame);
    liveTimelineGeometryFrame = null;
  }
  if (clipStructureChanged) {
    clearTimelineRangeSelection({ render: false });
  }
  renderAll({ keepScroll: true });
  scheduleSave();
  void syncPreviewToPlayhead();
}

function bindClipTrim(handle, clip, side, event) {
  event.preventDefault();
  event.stopPropagation();
  const originalProject = project;
  beginPointerHistory();
  const startX = event.clientX;
  const originalStart = clip.sourceStartMs;
  const originalEnd = clip.sourceEndMs;
  const maxDuration = project.mediaAsset?.durationMs || Infinity;
  const pointerId = event.pointerId;
  const block = handle.closest(".clip-block");
  handle.setPointerCapture(event.pointerId);

  const move = (moveEvent) => {
    if (moveEvent.pointerId !== pointerId) {
      return;
    }
    const delta = Math.round((moveEvent.clientX - startX) / pixelsPerSecond * 1000);
    const start = side === "left"
      ? Math.max(0, Math.min(originalEnd - 100, originalStart + delta))
      : originalStart;
    const end = side === "right"
      ? Math.min(maxDuration, Math.max(originalStart + 100, originalEnd + delta))
      : originalEnd;
    project = updateClipTrim(originalProject, clip.id, { sourceStartMs: start, sourceEndMs: end });
    const nextClip = project.clips.find((candidate) => candidate.id === clip.id);
    if (block && nextClip) {
      block.style.left = `${timelineX(nextClip.timelineStartMs)}px`;
      block.style.width = `${Math.max(8, timelineX(clipDurationMs(nextClip)))}px`;
    }
    scheduleLiveTimelineGeometry();
  };
  const finish = (finishEvent) => {
    if (finishEvent?.pointerId !== undefined && finishEvent.pointerId !== pointerId) {
      return;
    }
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", finish);
    window.removeEventListener("pointercancel", finish);
    if (handle.hasPointerCapture(pointerId)) {
      handle.releasePointerCapture(pointerId);
    }
    endPointerHistory({ clipStructureChanged: true });
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", finish);
  window.addEventListener("pointercancel", finish);
}

function bindCueTrim(handle, cue, side, event) {
  event.preventDefault();
  event.stopPropagation();
  beginPointerHistory();
  propertyInspectorMode = "caption";
  inspectorMode = "selected";
  const originalProject = {
    ...project,
    selectedCueId: cue.id,
    selectedClipId: cue.clipId
  };
  project = originalProject;
  handle.closest(".cue-block")?.classList.add("selected");
  const startX = event.clientX;
  const originalStart = cue.startOffsetMs;
  const originalEnd = cue.endOffsetMs;
  const clip = project.clips.find((candidate) => candidate.id === cue.clipId);
  const duration = clipDurationMs(clip);
  const pointerId = event.pointerId;
  const block = handle.closest(".cue-block");
  let overlapBlocked = false;
  handle.setPointerCapture(event.pointerId);

  const move = (moveEvent) => {
    if (moveEvent.pointerId !== pointerId) {
      return;
    }
    const delta = Math.round((moveEvent.clientX - startX) / pixelsPerSecond * 1000);
    const startOffsetMs = side === "left"
      ? Math.max(0, Math.min(originalEnd - 100, originalStart + delta))
      : originalStart;
    const endOffsetMs = side === "right"
      ? Math.min(duration, Math.max(originalStart + 100, originalEnd + delta))
      : originalEnd;
    const nextProject = updateSubtitleCue(originalProject, cue.id, { startOffsetMs, endOffsetMs });
    if (cueHasOverlap(nextProject, cue.id)) {
      overlapBlocked = true;
      return;
    }
    overlapBlocked = false;
    project = nextProject;
    const nextCue = project.subtitles.find((candidate) => candidate.id === cue.id);
    const range = cueTimelineRange(project, nextCue);
    if (block && range) {
      block.style.left = `${timelineX(range.startMs)}px`;
      block.style.width = `${Math.max(8, timelineX(range.endMs - range.startMs))}px`;
    }
  };
  const finish = (finishEvent) => {
    if (finishEvent?.pointerId !== undefined && finishEvent.pointerId !== pointerId) {
      return;
    }
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", finish);
    window.removeEventListener("pointercancel", finish);
    if (handle.hasPointerCapture(pointerId)) {
      handle.releasePointerCapture(pointerId);
    }
    endPointerHistory();
    if (overlapBlocked) {
      showToast("같은 자막 레인 안에서는 자막이 겹칠 수 없습니다.", "error");
    }
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", finish);
  window.addEventListener("pointercancel", finish);
}

function bindImageAssetTrim(handle, asset, side, event) {
  event.preventDefault();
  event.stopPropagation();
  beginPointerHistory();
  propertyInspectorMode = "asset";
  const originalProject = {
    ...project,
    selectedImageAssetId: asset.id,
    selectedClipId: asset.clipId
  };
  project = originalProject;
  handle.closest(".asset-block")?.classList.add("selected");
  const startX = event.clientX;
  const originalStart = asset.startOffsetMs;
  const originalEnd = asset.endOffsetMs;
  const clip = project.clips.find((candidate) => candidate.id === asset.clipId);
  const duration = clipDurationMs(clip);
  const pointerId = event.pointerId;
  const block = handle.closest(".asset-block");
  handle.setPointerCapture(pointerId);

  const move = (moveEvent) => {
    if (moveEvent.pointerId !== pointerId) {
      return;
    }
    const delta = Math.round((moveEvent.clientX - startX) / pixelsPerSecond * 1000);
    const startOffsetMs = side === "left"
      ? Math.max(0, Math.min(originalEnd - 100, originalStart + delta))
      : originalStart;
    const endOffsetMs = side === "right"
      ? Math.min(duration, Math.max(originalStart + 100, originalEnd + delta))
      : originalEnd;
    project = updateImageAsset(originalProject, asset.id, { startOffsetMs, endOffsetMs });
    const nextAsset = selectedImageAsset();
    const range = imageAssetTimelineRange(project, nextAsset);
    if (block && range) {
      block.style.left = `${timelineX(range.startMs)}px`;
      block.style.width = `${Math.max(8, timelineX(range.endMs - range.startMs))}px`;
    }
    renderImageAssetInspector();
  };
  const finish = (finishEvent) => {
    if (finishEvent?.pointerId !== undefined && finishEvent.pointerId !== pointerId) {
      return;
    }
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", finish);
    window.removeEventListener("pointercancel", finish);
    if (handle.hasPointerCapture(pointerId)) {
      handle.releasePointerCapture(pointerId);
    }
    endPointerHistory();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", finish);
  window.addEventListener("pointercancel", finish);
}

function audioRegionHasOverlap(candidateProject, regionId) {
  return findAudioRegionOverlaps(candidateProject).some((overlap) => (
    overlap.firstRegionId === regionId || overlap.secondRegionId === regionId
  ));
}

function bindAudioTrim(handle, region, side, event) {
  event.preventDefault();
  event.stopPropagation();
  beginPointerHistory();
  const startX = event.clientX;
  const originalStart = region.startOffsetMs;
  const originalEnd = region.endOffsetMs;
  const clip = project.clips.find((candidate) => candidate.id === region.clipId);
  const duration = clipDurationMs(clip);
  const pointerId = event.pointerId;
  const block = handle.closest(".audio-block");
  let overlapBlocked = false;
  handle.setPointerCapture(pointerId);

  const move = (moveEvent) => {
    if (moveEvent.pointerId !== pointerId) {
      return;
    }
    const delta = Math.round((moveEvent.clientX - startX) / pixelsPerSecond * 1000);
    const startOffsetMs = side === "left"
      ? Math.max(0, Math.min(originalEnd - 100, originalStart + delta))
      : originalStart;
    const endOffsetMs = side === "right"
      ? Math.min(duration, Math.max(originalStart + 100, originalEnd + delta))
      : originalEnd;
    const nextProject = updateAudioRegion(project, region.id, { startOffsetMs, endOffsetMs });
    if (audioRegionHasOverlap(nextProject, region.id)) {
      overlapBlocked = true;
      return;
    }
    overlapBlocked = false;
    project = nextProject;
    const nextRegion = selectedAudioRegion();
    const range = audioRegionTimelineRange(project, nextRegion);
    if (block && range) {
      block.style.left = `${timelineX(range.startMs)}px`;
      block.style.width = `${Math.max(8, timelineX(range.endMs - range.startMs))}px`;
    }
    renderAudioInspector();
    applyPreviewAudioSettings();
  };
  const finish = (finishEvent) => {
    if (finishEvent?.pointerId !== undefined && finishEvent.pointerId !== pointerId) {
      return;
    }
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", finish);
    window.removeEventListener("pointercancel", finish);
    if (handle.hasPointerCapture(pointerId)) {
      handle.releasePointerCapture(pointerId);
    }
    endPointerHistory();
    if (overlapBlocked) {
      showToast("음성 설정 구간끼리는 겹칠 수 없습니다.", "error");
    }
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", finish);
  window.addEventListener("pointercancel", finish);
}

function renderTimeline({ keepScroll = false } = {}) {
  const scrollLeft = elements.timeline_scroll.scrollLeft;
  const width = timelineWidth();
  const laneCount = Math.max(2, project.subtitleLaneCount || 2);
  const assetLayout = layoutImageAssetSubrows(project);
  const assetTrackHeight = ASSET_TRACK_BASE_HEIGHT_PX +
    (assetLayout.subrowCount - 1) * ASSET_SUBROW_STRIDE_PX;
  document.documentElement.style.setProperty("--subtitle-lane-count", String(laneCount));
  document.documentElement.style.setProperty("--asset-track-height", `${assetTrackHeight}px`);
  elements.subtitle_lane_count.textContent = String(laneCount);
  elements.add_subtitle_lane.disabled = laneCount >= MAX_SUBTITLE_LANES;
  elements.timeline_content.style.width = `${width}px`;
  elements.video_track.style.width = `${width}px`;
  elements.asset_track.style.width = `${width}px`;
  elements.audio_track.style.width = `${width}px`;
  elements.video_track.style.backgroundSize = `${pixelsPerSecond}px 100%`;
  elements.asset_track.style.backgroundSize = `${pixelsPerSecond}px 100%`;
  elements.audio_track.style.backgroundSize = `${pixelsPerSecond}px 100%`;
  renderRuler(width);
  elements.video_track.replaceChildren();
  elements.asset_track.replaceChildren();
  elements.audio_track.replaceChildren();
  elements.caption_tracks.replaceChildren();
  const captionRows = Array.from({ length: laneCount }, (_, lane) => {
    const row = document.createElement("div");
    row.className = "timeline-track caption-track-row";
    row.dataset.lane = String(lane);
    row.setAttribute("aria-label", `자막 ${lane + 1} 레인`);
    row.style.width = `${width}px`;
    row.style.backgroundSize = `${pixelsPerSecond}px 100%`;
    elements.caption_tracks.append(row);
    return row;
  });

  project.clips.filter((clip) => clip.enabled !== false).forEach((clip, index) => {
    const block = document.createElement("div");
    block.className = "clip-block";
    block.classList.toggle("selected", clip.id === project.selectedClipId);
    block.dataset.id = clip.id;
    block.style.left = `${timelineX(clip.timelineStartMs)}px`;
    block.style.width = `${Math.max(8, timelineX(clipDurationMs(clip)))}px`;
    const body = document.createElement("button");
    body.type = "button";
    body.className = "clip-block-body";
    body.textContent = `${index + 1} · ${clip.note || "사용자 선택"}`;
    body.addEventListener("click", () => {
      project = { ...project, selectedClipId: clip.id };
      void seekTimeline(clip.timelineStartMs);
      renderAll({ keepScroll: true });
      const nextBlock = [...elements.video_track.querySelectorAll(".clip-block")]
        .find((candidate) => candidate.dataset.id === clip.id);
      nextBlock?.querySelector(".clip-block-body")?.focus({ preventScroll: true });
      scheduleSave();
    });
    const nudgeClip = (side, delta) => {
      const current = project.clips.find((candidate) => candidate.id === clip.id);
      const maxDuration = project.mediaAsset?.durationMs || Infinity;
      const sourceStartMs = side === "left"
        ? Math.max(0, Math.min(current.sourceEndMs - 100, current.sourceStartMs + delta))
        : current.sourceStartMs;
      const sourceEndMs = side === "right"
        ? Math.min(maxDuration, Math.max(current.sourceStartMs + 100, current.sourceEndMs + delta))
        : current.sourceEndMs;
      clearTimelineRangeSelection({ render: false });
      applyProject(
        updateClipTrim(project, clip.id, { sourceStartMs, sourceEndMs }),
        { render: false }
      );
      renderAll({ keepScroll: true });
      void syncPreviewToPlayhead();
    };
    const clipMaximumMs = Number.isFinite(project.mediaAsset?.durationMs)
      ? Math.max(project.mediaAsset.durationMs, clip.sourceEndMs)
      : Math.max(clip.sourceEndMs, clip.selectionEndMs || 0) + 3_600_000;
    block.append(
      makeHandle(
        "left",
        (event) => bindClipTrim(event.currentTarget, clip, "left", event),
        (delta) => nudgeClip("left", delta),
        {
          label: `${index + 1}번 컷 시작 시각`,
          valueMs: clip.sourceStartMs,
          minMs: 0,
          maxMs: clip.sourceEndMs - 100
        }
      ),
      body,
      makeHandle(
        "right",
        (event) => bindClipTrim(event.currentTarget, clip, "right", event),
        (delta) => nudgeClip("right", delta),
        {
          label: `${index + 1}번 컷 끝 시각`,
          valueMs: clip.sourceEndMs,
          minMs: clip.sourceStartMs + 100,
          maxMs: clipMaximumMs
        }
      )
    );
    elements.video_track.append(block);

    const audioSource = document.createElement("button");
    audioSource.type = "button";
    audioSource.className = "audio-source-block";
    audioSource.dataset.clipId = clip.id;
    audioSource.style.left = `${timelineX(clip.timelineStartMs)}px`;
    audioSource.style.width = `${Math.max(8, timelineX(clipDurationMs(clip)))}px`;
    audioSource.textContent = `${index + 1} · 원본 음성`;
    audioSource.title = "클릭하면 이 위치에 음성 설정 구간을 만듭니다.";
    audioSource.addEventListener("click", (event) => {
      const rect = elements.timeline_content.getBoundingClientRect();
      const timelineMs = (event.clientX - rect.left) / pixelsPerSecond * 1000;
      addAudioRegionAtTimeline(timelineMs);
    });
    elements.audio_track.append(audioSource);
  });

  (project.imageAssets || []).forEach((asset, assetIndex) => {
    const layout = assetLayout.byAssetId.get(asset.id);
    if (!layout) {
      return;
    }
    const { range, subrow } = layout;
    const block = document.createElement("div");
    block.className = "asset-block";
    block.classList.toggle("selected", asset.id === project.selectedImageAssetId);
    block.dataset.id = asset.id;
    block.dataset.subrow = String(subrow);
    block.style.left = `${timelineX(range.startMs)}px`;
    block.style.width = `${Math.max(8, timelineX(range.endMs - range.startMs))}px`;
    block.style.setProperty(
      "--asset-block-top",
      `${ASSET_BLOCK_TOP_PX + subrow * ASSET_SUBROW_STRIDE_PX}px`
    );
    block.style.zIndex = asset.id === project.selectedImageAssetId ? "12" : "2";
    const body = document.createElement("button");
    body.type = "button";
    body.className = "asset-block-body";
    body.textContent = asset.name || `이미지 ${assetIndex + 1}`;
    body.title = `${asset.name || "이미지 에셋"} · 겹친 이미지는 에셋 트랙의 별도 줄에 표시됩니다.`;
    body.addEventListener("click", () => selectImageAsset(asset.id, { seek: true }));
    const assetClip = project.clips.find((candidate) => candidate.id === asset.clipId);
    const nudgeAsset = (side, delta) => {
      const current = project.imageAssets.find((candidate) => candidate.id === asset.id);
      const currentClip = project.clips.find((candidate) => candidate.id === current.clipId);
      const duration = clipDurationMs(currentClip);
      const startOffsetMs = side === "left"
        ? Math.max(0, Math.min(current.endOffsetMs - 100, current.startOffsetMs + delta))
        : current.startOffsetMs;
      const endOffsetMs = side === "right"
        ? Math.min(duration, Math.max(current.startOffsetMs + 100, current.endOffsetMs + delta))
        : current.endOffsetMs;
      applyProject(
        updateImageAsset(project, asset.id, { startOffsetMs, endOffsetMs }),
        { render: false }
      );
      renderAll({ keepScroll: true });
    };
    block.append(
      makeHandle(
        "left",
        (event) => bindImageAssetTrim(event.currentTarget, asset, "left", event),
        (delta) => nudgeAsset("left", delta),
        {
          label: `${assetIndex + 1}번 이미지 에셋 시작 시각`,
          valueMs: range.startMs,
          minMs: assetClip.timelineStartMs,
          maxMs: range.endMs - 100
        }
      ),
      body,
      makeHandle(
        "right",
        (event) => bindImageAssetTrim(event.currentTarget, asset, "right", event),
        (delta) => nudgeAsset("right", delta),
        {
          label: `${assetIndex + 1}번 이미지 에셋 끝 시각`,
          valueMs: range.endMs,
          minMs: range.startMs + 100,
          maxMs: assetClip.timelineStartMs + clipDurationMs(assetClip)
        }
      )
    );
    elements.asset_track.append(block);
  });

  project.audioRegions.forEach((region, regionIndex) => {
    const range = audioRegionTimelineRange(project, region);
    if (!range) {
      return;
    }
    const block = document.createElement("div");
    block.className = "audio-block";
    block.classList.toggle("selected", region.id === project.selectedAudioRegionId);
    block.classList.toggle("muted", region.muted);
    block.dataset.id = region.id;
    block.style.left = `${timelineX(range.startMs)}px`;
    block.style.width = `${Math.max(8, timelineX(range.endMs - range.startMs))}px`;
    const body = document.createElement("button");
    body.type = "button";
    body.className = "audio-block-body";
    body.textContent = region.muted ? "음소거" : `음량 ${Math.round(region.gain * 100)}%`;
    body.addEventListener("click", () => selectAudioRegion(region.id, { seek: true }));
    const regionClip = project.clips.find((candidate) => candidate.id === region.clipId);
    const nudgeRegion = (side, delta) => {
      const current = project.audioRegions.find((candidate) => candidate.id === region.id);
      const currentClip = project.clips.find((candidate) => candidate.id === current.clipId);
      const duration = clipDurationMs(currentClip);
      const startOffsetMs = side === "left"
        ? Math.max(0, Math.min(current.endOffsetMs - 100, current.startOffsetMs + delta))
        : current.startOffsetMs;
      const endOffsetMs = side === "right"
        ? Math.min(duration, Math.max(current.startOffsetMs + 100, current.endOffsetMs + delta))
        : current.endOffsetMs;
      const nextProject = updateAudioRegion(project, region.id, { startOffsetMs, endOffsetMs });
      if (audioRegionHasOverlap(nextProject, region.id)) {
        showToast("음성 설정 구간끼리는 겹칠 수 없습니다.", "error");
        return;
      }
      applyProject(nextProject, { render: false });
      renderAll({ keepScroll: true });
      applyPreviewAudioSettings();
    };
    block.append(
      makeHandle(
        "left",
        (event) => bindAudioTrim(event.currentTarget, region, "left", event),
        (delta) => nudgeRegion("left", delta),
        {
          label: `${regionIndex + 1}번 음성 설정 시작 시각`,
          valueMs: range.startMs,
          minMs: regionClip.timelineStartMs,
          maxMs: range.endMs - 100
        }
      ),
      body,
      makeHandle(
        "right",
        (event) => bindAudioTrim(event.currentTarget, region, "right", event),
        (delta) => nudgeRegion("right", delta),
        {
          label: `${regionIndex + 1}번 음성 설정 끝 시각`,
          valueMs: range.endMs,
          minMs: range.startMs + 100,
          maxMs: regionClip.timelineStartMs + clipDurationMs(regionClip)
        }
      )
    );
    elements.audio_track.append(block);
  });

  project.subtitles.forEach((cue, cueIndex) => {
    const range = cueTimelineRange(project, cue);
    if (!range) {
      return;
    }
    const block = document.createElement("div");
    block.className = `cue-block ${cue.origin === "ai" ? "ai" : "human"}${cue.humanEdited ? " human-edited" : ""}`;
    const reviewRequired = (
      cue.origin === "ai" &&
      cue.remoteMeta?.reviewRequired &&
      !cue.humanEdited
    );
    block.classList.toggle("review-required", reviewRequired);
    if (reviewRequired) {
      block.title = "AI가 불명확한 발화로 표시함 · 원음 재확인 필요";
    }
    block.classList.toggle("selected", cue.id === project.selectedCueId);
    block.dataset.id = cue.id;
    block.dataset.lane = String(cue.lane);
    block.style.left = `${timelineX(range.startMs)}px`;
    block.style.width = `${Math.max(8, timelineX(range.endMs - range.startMs))}px`;
    block.style.setProperty("--cue-color", cue.color || "#ffffff");
    const body = document.createElement("button");
    body.type = "button";
    body.className = "cue-block-body";
    body.textContent = cue.text || "(빈 자막)";
    body.addEventListener("click", () => {
      selectCue(cue.id, { seek: true });
      elements.cue_text.focus({ preventScroll: true });
    });
    const cueClip = project.clips.find((candidate) => candidate.id === cue.clipId);
    const nudgeCue = (side, delta) => {
      const current = project.subtitles.find((candidate) => candidate.id === cue.id);
      const currentClip = project.clips.find((candidate) => candidate.id === current.clipId);
      const duration = clipDurationMs(currentClip);
      const startOffsetMs = side === "left"
        ? Math.max(0, Math.min(current.endOffsetMs - 100, current.startOffsetMs + delta))
        : current.startOffsetMs;
      const endOffsetMs = side === "right"
        ? Math.min(duration, Math.max(current.startOffsetMs + 100, current.endOffsetMs + delta))
        : current.endOffsetMs;
      const nextProject = updateSubtitleCue(project, cue.id, { startOffsetMs, endOffsetMs });
      if (cueHasOverlap(nextProject, cue.id)) {
        showToast("같은 자막 레인 안에서는 자막이 겹칠 수 없습니다.", "error");
        return;
      }
      applyProject(nextProject, { render: false });
      renderAll({ keepScroll: true });
    };
    block.append(
      makeHandle(
        "left",
        (event) => bindCueTrim(event.currentTarget, cue, "left", event),
        (delta) => nudgeCue("left", delta),
        {
          label: `${cueIndex + 1}번 자막 시작 시각`,
          valueMs: range.startMs,
          minMs: cueClip.timelineStartMs,
          maxMs: range.endMs - 100
        }
      ),
      body,
      makeHandle(
        "right",
        (event) => bindCueTrim(event.currentTarget, cue, "right", event),
        (delta) => nudgeCue("right", delta),
        {
          label: `${cueIndex + 1}번 자막 끝 시각`,
          valueMs: range.endMs,
          minMs: range.startMs + 100,
          maxMs: cueClip.timelineStartMs + clipDurationMs(cueClip)
        }
      )
    );
    (captionRows[cue.lane] || captionRows[0]).append(block);
  });

  renderTimelineRange();
  updatePlayhead();
  if (keepScroll) {
    elements.timeline_scroll.scrollLeft = scrollLeft;
  }
}

function videoContentRect() {
  const stageRect = elements.stage.getBoundingClientRect();
  const video = elements.preview_video;
  if (!video.videoWidth || !video.videoHeight) {
    return { left: 0, top: 0, width: stageRect.width, height: stageRect.height };
  }
  const scale = Math.min(stageRect.width / video.videoWidth, stageRect.height / video.videoHeight);
  const width = video.videoWidth * scale;
  const height = video.videoHeight * scale;
  return {
    left: (stageRect.width - width) / 2,
    top: (stageRect.height - height) / 2,
    width,
    height
  };
}

async function renderImageAssetOverlays() {
  const sequence = ++imageAssetRenderSequence;
  elements.image_asset_overlays.replaceChildren();
  const assets = mediaFile ? imageAssetsAtTimeline(project, project.playheadMs) : [];
  if (assets.length === 0) {
    return;
  }
  const resolved = await Promise.all(assets.map(async (asset) => ({
    asset,
    url: await resolveImageAssetUrl(asset)
  })));
  if (sequence !== imageAssetRenderSequence) {
    return;
  }
  const contentRect = videoContentRect();
  resolved.forEach(({ asset, url }) => {
    if (!url) {
      return;
    }
    const naturalWidth = Math.max(1, asset.naturalWidth || 512);
    const naturalHeight = Math.max(1, asset.naturalHeight || 512);
    const baseFit = Math.min(
      1,
      contentRect.width * 0.35 / naturalWidth,
      contentRect.height * 0.35 / naturalHeight
    );
    const overlay = document.createElement("button");
    overlay.type = "button";
    overlay.className = "image-asset-overlay";
    overlay.classList.toggle("selected", asset.id === project.selectedImageAssetId);
    overlay.dataset.assetId = asset.id;
    overlay.setAttribute("aria-label", `이미지 에셋: ${asset.name}`);
    overlay.style.left = `${contentRect.left + contentRect.width * asset.x}px`;
    overlay.style.top = `${contentRect.top + contentRect.height * asset.y}px`;
    overlay.style.width = `${Math.max(1, naturalWidth * baseFit * asset.scale)}px`;
    overlay.style.height = `${Math.max(1, naturalHeight * baseFit * asset.scale)}px`;
    overlay.style.opacity = String(asset.opacity);
    const image = document.createElement("img");
    image.src = url;
    image.alt = "";
    image.draggable = false;
    const indicator = document.createElement("i");
    indicator.className = "asset-drag-indicator";
    indicator.setAttribute("aria-hidden", "true");
    overlay.append(image, indicator);
    elements.image_asset_overlays.append(overlay);
  });
}

function renderSubtitleOverlay() {
  elements.subtitle_overlays.replaceChildren();
  const cues = mediaFile ? cuesAtTimeline(project, project.playheadMs) : [];
  if (cues.length === 0) {
    return;
  }
  const contentRect = videoContentRect();
  cues.forEach((cue) => {
    const overlay = document.createElement("button");
    overlay.type = "button";
    overlay.className = "subtitle-overlay";
    overlay.classList.toggle("selected", cue.id === project.selectedCueId);
    overlay.dataset.cueId = cue.id;
    overlay.setAttribute("aria-label", `${cue.lane + 1}번 레인 자막: ${cue.text || "빈 자막"}`);
    const text = document.createElement("span");
    const maximumLines = Math.max(
      1,
      Math.min(2, Math.round(Number(project.subtitleDefaults.maxLines) || 1))
    );
    const displayText = maximumLines === 1
      ? singleLineCaptionText(cue.text)
      : String(cue.text || "");
    text.textContent = displayText || " ";
    const indicator = document.createElement("i");
    indicator.className = "drag-indicator";
    indicator.setAttribute("aria-hidden", "true");
    overlay.append(text, indicator);
    overlay.style.left = `${contentRect.left + contentRect.width * cue.x}px`;
    overlay.style.top = `${contentRect.top + contentRect.height * cue.y}px`;
    const maxWidth = contentRect.width * (
      project.subtitleDefaults.maxWidth || 0.86
    );
    overlay.style.maxWidth = `${maxWidth}px`;
    overlay.style.whiteSpace = maximumLines === 1 ? "nowrap" : "pre-wrap";
    const fontScale = project.subtitleDefaults.fontScale || 0.0675;
    let fontSize = Math.max(14, Math.min(
      contentRect.height * fontScale,
      contentRect.width * fontScale * 9 / 16
    ));
    const fontFamily = String(
      project.subtitleDefaults.fontFamily || "Pretendard"
    ).replace(/["\\]/gu, "");
    const fontWeight = Math.round(
      Number(project.subtitleDefaults.fontWeight) || 800
    );
    if (maximumLines === 1 && displayText) {
      const measureContext = document.createElement("canvas").getContext("2d");
      if (measureContext) {
        measureContext.font = `${fontWeight} ${fontSize}px "${fontFamily}", "Noto Sans KR", sans-serif`;
        fontSize = fitSingleLineCaptionFontSize({
          baseFontSize: fontSize,
          measuredWidth: measureContext.measureText(displayText).width,
          maxWidth
        });
      }
    }
    overlay.style.fontSize = `${fontSize}px`;
    overlay.style.fontFamily = `"${fontFamily}", "Noto Sans KR", sans-serif`;
    overlay.style.fontWeight = String(fontWeight);
    overlay.style.lineHeight = String(
      Number(project.subtitleDefaults.lineHeight) || 1.24
    );
    overlay.style.color = cue.color || project.subtitleDefaults.color || "#ffffff";
    overlay.style.background = "transparent";
    overlay.style.textShadow = [
      `${Number(project.subtitleDefaults.shadowOffsetXEm) || 0}em`,
      `${Number(project.subtitleDefaults.shadowOffsetYEm) || 0}em`,
      `${Math.max(0, Number(project.subtitleDefaults.shadowBlurEm) || 0)}em`,
      String(project.subtitleDefaults.shadowColor || "rgba(0, 0, 0, 0.45)")
    ].join(" ");
    overlay.style.setProperty(
      "--subtitle-stroke",
      `${Math.max(1.5, contentRect.height * (project.subtitleDefaults.outlineWidth || 0.006))}px`
    );
    overlay.style.setProperty(
      "--subtitle-outline-color",
      project.subtitleDefaults.outlineColor || "#111111"
    );
    elements.subtitle_overlays.append(overlay);

    const overlayRect = overlay.getBoundingClientRect();
    const halfWidth = Math.min(overlayRect.width / 2, contentRect.width / 2);
    const halfHeight = Math.min(overlayRect.height / 2, contentRect.height / 2);
    const desiredLeft = contentRect.left + contentRect.width * cue.x;
    const desiredTop = contentRect.top + contentRect.height * cue.y;
    overlay.style.left = `${Math.min(
      contentRect.left + contentRect.width - halfWidth,
      Math.max(contentRect.left + halfWidth, desiredLeft)
    )}px`;
    overlay.style.top = `${Math.min(
      contentRect.top + contentRect.height - halfHeight,
      Math.max(contentRect.top + halfHeight, desiredTop)
    )}px`;
  });
}

function previewTimelineMsFromVideoClock() {
  const video = elements.preview_video;
  if (!video || !project || !mediaFile || pendingPreviewSeek) {
    return project?.playheadMs || 0;
  }
  const clip = project.clips.find((candidate) => candidate.id === activeClipId);
  if (!clip) {
    return project.playheadMs || 0;
  }
  const sourceMs = previewSecondsToSourceMs(video.currentTime);
  return Math.max(
    clip.timelineStartMs,
    Math.min(
      clip.timelineStartMs + clipDurationMs(clip),
      clip.timelineStartMs + sourceMs - clip.sourceStartMs
    )
  );
}

function applyPreviewAudioSettings(timelineMs = project?.playheadMs || 0) {
  const video = elements.preview_video;
  if (!video || !project) {
    return;
  }
  const targetTimelineMs = Math.max(
    0,
    Math.min(projectDurationMs(project), Number(timelineMs) || 0)
  );
  const region = audioRegionAtTimeline(project, targetTimelineMs);
  const targetGain = region?.muted ? 0 : (region?.gain ?? 1);
  let blend = region ? 1 : 0;
  if (region) {
    const range = audioRegionTimelineRange(project, region);
    const elapsedMs = Math.max(0, targetTimelineMs - range.startMs);
    const remainingMs = Math.max(0, range.endMs - targetTimelineMs);
    if (region.fadeInMs > 0) {
      blend = Math.min(blend, Math.min(1, elapsedMs / region.fadeInMs));
    }
    if (region.fadeOutMs > 0) {
      blend = Math.min(blend, Math.min(1, remainingMs / region.fadeOutMs));
    }
  }
  const regionGain = 1 + (targetGain - 1) * blend;
  video.muted = previewMuted || Boolean(region?.muted && region.fadeInMs === 0 && region.fadeOutMs === 0);
  video.volume = Math.max(0, Math.min(1, previewVolume * regionGain));
  elements.toggle_mute.classList.toggle("active", previewMuted);
  elements.toggle_mute.title = region?.muted && !previewMuted
    ? "현재 음성 설정 구간이 음소거됨"
    : previewMuted
      ? "미리보기 음소거 해제"
      : "미리보기 음소거";
}

function stopPreviewAudioClock({ sync = true } = {}) {
  if (previewAudioClockTimer !== null) {
    clearTimeout(previewAudioClockTimer);
    previewAudioClockTimer = null;
  }
  if (sync && project) {
    applyPreviewAudioSettings(previewTimelineMsFromVideoClock());
  }
}

function startPreviewAudioClock() {
  if (previewAudioClockTimer !== null || elements.preview_video.paused) {
    return;
  }
  const tick = () => {
    previewAudioClockTimer = null;
    if (elements.preview_video.paused || elements.preview_video.ended || !mediaFile) {
      applyPreviewAudioSettings(previewTimelineMsFromVideoClock());
      return;
    }
    applyPreviewAudioSettings(previewTimelineMsFromVideoClock());
    previewAudioClockTimer = setTimeout(tick, PREVIEW_AUDIO_CLOCK_INTERVAL_MS);
  };
  tick();
}

function updatePlayhead() {
  const duration = projectDurationMs(project);
  project.playheadMs = Math.max(0, Math.min(duration, project.playheadMs || 0));
  elements.playhead.style.left = `${timelineX(project.playheadMs)}px`;
  elements.playhead.setAttribute("aria-valuemax", String(duration / 1000));
  elements.playhead.setAttribute("aria-valuenow", String(project.playheadMs / 1000));
  elements.playhead.setAttribute("aria-valuetext", formatTime(project.playheadMs));
  elements.current_time.textContent = formatTime(project.playheadMs);
  elements.duration_time.textContent = `/ ${formatTime(duration)}`;
  void renderImageAssetOverlays().catch((error) => {
    console.warn("이미지 에셋 오버레이를 그리지 못했습니다.", error);
  });
  renderSubtitleOverlay();
  applyPreviewAudioSettings();
}

function renderTransport() {
  const clip = mapTimelineToSource(project, project.playheadMs);
  elements.preview_video.style.visibility = clip && mediaFile ? "" : "hidden";
  activeClipId = clip?.clipId || project.clips[0]?.id || null;
  elements.previous_clip.disabled = project.clips.length === 0;
  elements.next_clip.disabled = project.clips.length === 0;
  elements.play_toggle.disabled = !mediaFile || project.clips.length === 0;
  updatePlayhead();
}

function renderAll(options = {}) {
  if (!project) {
    return;
  }
  renderHeader();
  renderMediaCard();
  renderClipList();
  renderPropertyInspector();
  renderCueList();
  renderTimeline(options);
  renderTransport();
  applyPreviewAudioSettings();
}

function sourceMsToPreviewSeconds(sourceMs) {
  const mediaOriginMs = Number(project.mediaAsset?.mediaOriginMs) || 0;
  return (mediaOriginMs + sourceMs) / 1000;
}

function previewSecondsToSourceMs(previewSeconds) {
  const mediaOriginMs = Number(project.mediaAsset?.mediaOriginMs) || 0;
  return previewSeconds * 1000 - mediaOriginMs;
}

function configurePreviewVideoLayer(video, { active }) {
  video.classList.add("preview-video");
  video.classList.toggle("preview-video-active", active);
  video.classList.toggle("preview-video-standby", !active);
  if (!active) {
    video.preload = "auto";
  }
  video.style.visibility = active && mediaFile ? "" : "hidden";
  video.style.zIndex = active ? "1" : "0";
  video.style.pointerEvents = "none";
  video.setAttribute("aria-hidden", active ? "false" : "true");
  if (!active) {
    video.muted = true;
  }
}

function ensureStandbyPreviewVideo() {
  if (standbyPreviewVideo) {
    return standbyPreviewVideo;
  }
  const video = document.createElement("video");
  video.id = "preview-video-standby";
  video.preload = "auto";
  video.playsInline = true;
  configurePreviewVideoLayer(video, { active: false });
  elements.stage.insertBefore(video, elements.stage_empty);
  standbyPreviewVideo = video;
  bindPreviewVideoEvents(video);
  return video;
}

function cancelPreviewPreload({ clearSource = false } = {}) {
  previewPreloadSequence += 1;
  preparedPreview = null;
  if (!standbyPreviewVideo) {
    return;
  }
  standbyPreviewVideo.pause();
  configurePreviewVideoLayer(standbyPreviewVideo, { active: false });
  if (clearSource) {
    standbyPreviewVideo.removeAttribute("src");
    standbyPreviewVideo.load();
  }
}

function waitForStandbyEvent(video, eventName, sequence) {
  return new Promise((resolve, reject) => {
    let timeout = null;
    const cleanup = () => {
      clearTimeout(timeout);
      video.removeEventListener(eventName, handleEvent);
      video.removeEventListener("error", handleError);
    };
    const handleEvent = () => {
      cleanup();
      resolve(sequence === previewPreloadSequence);
    };
    const handleError = () => {
      cleanup();
      reject(new Error("다음 컷 미리보기를 미리 읽지 못했습니다."));
    };
    video.addEventListener(eventName, handleEvent, { once: true });
    video.addEventListener("error", handleError, { once: true });
    timeout = setTimeout(() => {
      cleanup();
      resolve(false);
    }, PREVIEW_PRELOAD_TIMEOUT_MS);
  });
}

async function prepareNextClipPreview(fromClipId = activeClipId) {
  const next = nextEnabledPreviewClip(project?.clips, fromClipId);
  if (!mediaUrl || !next || !standbyPreviewVideo) {
    cancelPreviewPreload();
    return false;
  }
  const targetSeconds = sourceMsToPreviewSeconds(next.sourceStartMs);
  if (
    preparedPreview
    && preparedPreview.fromClipId === fromClipId
    && preparedPreview.clipId === next.id
    && Math.abs(preparedPreview.targetSeconds - targetSeconds) <= 0.03
  ) {
    return preparedPreview.promise;
  }

  const video = standbyPreviewVideo;
  const sequence = ++previewPreloadSequence;
  video.pause();
  configurePreviewVideoLayer(video, { active: false });
  preparedPreview = {
    sequence,
    fromClipId,
    clipId: next.id,
    targetSeconds,
    ready: false,
    promise: null
  };

  const operation = (async () => {
    try {
      if (video.src !== mediaUrl) {
        video.src = mediaUrl;
      }
      if (video.readyState < HTMLMediaElement.HAVE_METADATA) {
        const loaded = await waitForStandbyEvent(video, "loadedmetadata", sequence);
        if (!loaded) {
          return false;
        }
      }
      if (sequence !== previewPreloadSequence) {
        return false;
      }
      if (Number.isFinite(video.duration) && video.duration + 0.02 < targetSeconds) {
        return false;
      }
      if (
        Math.abs(video.currentTime - targetSeconds) > 0.02
        || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA
      ) {
        const seeked = waitForStandbyEvent(
          video,
          Math.abs(video.currentTime - targetSeconds) > 0.02 ? "seeked" : "loadeddata",
          sequence
        );
        if (Math.abs(video.currentTime - targetSeconds) > 0.02) {
          video.currentTime = targetSeconds;
        }
        if (!await seeked) {
          return false;
        }
      }
      if (
        sequence !== previewPreloadSequence
        || Math.abs(video.currentTime - targetSeconds) > 0.03
      ) {
        return false;
      }
      if (video.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) {
        const canPlay = await waitForStandbyEvent(video, "canplay", sequence);
        if (!canPlay) {
          return false;
        }
      }
      if (
        sequence !== previewPreloadSequence
        || video.readyState < HTMLMediaElement.HAVE_FUTURE_DATA
      ) {
        return false;
      }
      if (preparedPreview?.sequence === sequence) {
        preparedPreview.ready = true;
      }
      return true;
    } catch (error) {
      if (sequence === previewPreloadSequence) {
        console.warn("다음 컷을 미리 준비하지 못해 일반 탐색으로 전환합니다.", error);
      }
      return false;
    }
  })();
  const promise = operation.then((ready) => {
    if (!ready && preparedPreview?.sequence === sequence) {
      preparedPreview = null;
    }
    return ready;
  });
  preparedPreview.promise = promise;
  return promise;
}

function stopPreviewPlaybackClock() {
  if (previewPlaybackFrame !== null) {
    cancelAnimationFrame(previewPlaybackFrame);
    previewPlaybackFrame = null;
  }
}

function startPreviewPlaybackClock() {
  if (previewPlaybackFrame !== null || elements.preview_video.paused) {
    return;
  }
  const tick = () => {
    previewPlaybackFrame = null;
    if (elements.preview_video.paused || elements.preview_video.ended || !mediaFile) {
      return;
    }
    if (!pendingPreviewSeek && !previewBoundaryTransitioning) {
      const clip = project.clips.find((candidate) => candidate.id === activeClipId);
      const sourceMs = previewSecondsToSourceMs(elements.preview_video.currentTime);
      if (clip && previewReachedClipBoundary(sourceMs, clip.sourceEndMs)) {
        handleVideoTimeUpdate();
      }
    }
    if (!elements.preview_video.paused && !elements.preview_video.ended) {
      previewPlaybackFrame = requestAnimationFrame(tick);
    }
  };
  previewPlaybackFrame = requestAnimationFrame(tick);
}

function transitionToPreparedPreview(next) {
  const nextVideo = standbyPreviewVideo;
  const previousVideo = elements.preview_video;
  const targetSeconds = sourceMsToPreviewSeconds(next.sourceStartMs);
  if (
    previewBoundaryTransitioning
    || !nextVideo
    || !preparedPreviewMatches(preparedPreview, next, targetSeconds)
  ) {
    return false;
  }

  previewBoundaryTransitioning = true;
  previewPreloadSequence += 1;
  preparedPreview = null;
  previousVideo.muted = true;
  configurePreviewVideoLayer(nextVideo, { active: true });
  configurePreviewVideoLayer(previousVideo, { active: false });
  previousVideo.id = "preview-video-standby";
  nextVideo.id = "preview-video";
  elements.preview_video = nextVideo;
  standbyPreviewVideo = previousVideo;
  activeClipId = next.id;
  project.selectedClipId = next.id;
  project.playheadMs = next.timelineStartMs;
  updatePlayhead();
  applyPreviewAudioSettings(next.timelineStartMs);

  const playback = nextVideo.play();
  previousVideo.pause();
  void playback
    .then(() => {
      void prepareNextClipPreview(next.id);
    })
    .catch((error) => {
      nextVideo.pause();
      elements.play_toggle.classList.remove("playing");
      stopPreviewPlaybackClock();
      stopPreviewAudioClock();
      console.warn("미리 준비한 다음 컷을 재생하지 못했습니다.", error);
    })
    .finally(() => {
      previewBoundaryTransitioning = false;
    });
  return true;
}

async function seekPreviewToSourceMs(sourceMs) {
  const video = elements.preview_video;
  const targetSeconds = sourceMsToPreviewSeconds(sourceMs);
  const sequence = ++previewSeekSequence;
  if (Math.abs(video.currentTime - targetSeconds) <= 0.02) {
    pendingPreviewSeek = null;
    return true;
  }

  pendingPreviewSeek = { sequence, sourceMs, targetSeconds };
  return new Promise((resolve) => {
    let retries = 0;
    let retryTimer = null;
    let settleTimer = null;

    const cleanup = (matched) => {
      video.removeEventListener("seeked", handleSeeked);
      video.removeEventListener("durationchange", retryWhenAvailable);
      clearTimeout(retryTimer);
      clearTimeout(settleTimer);
      if (pendingPreviewSeek?.sequence === sequence) {
        pendingPreviewSeek = null;
      }
      resolve(matched);
    };

    const assignTarget = () => {
      if (sequence !== previewSeekSequence) {
        cleanup(false);
        return;
      }
      video.currentTime = targetSeconds;
    };

    const retryWhenAvailable = () => {
      if (sequence !== previewSeekSequence) {
        cleanup(false);
        return;
      }
      if (Number.isFinite(video.duration) && video.duration + 0.02 < targetSeconds) {
        return;
      }
      video.removeEventListener("durationchange", retryWhenAvailable);
      clearTimeout(retryTimer);
      requestAnimationFrame(assignTarget);
    };

    const scheduleRetry = () => {
      retries += 1;
      video.addEventListener("durationchange", retryWhenAvailable);
      retryTimer = setTimeout(() => {
        video.removeEventListener("durationchange", retryWhenAvailable);
        assignTarget();
      }, 350);
      retryWhenAvailable();
    };

    const handleSeeked = () => {
      if (sequence !== previewSeekSequence) {
        cleanup(false);
        return;
      }
      if (Math.abs(video.currentTime - targetSeconds) <= 0.03) {
        cleanup(true);
        return;
      }
      if (retries < 1) {
        scheduleRetry();
        return;
      }
      cleanup(false);
    };

    video.addEventListener("seeked", handleSeeked);
    settleTimer = setTimeout(() => {
      if (retries < 1) {
        scheduleRetry();
        settleTimer = setTimeout(() => cleanup(
          Math.abs(video.currentTime - targetSeconds) <= 0.03
        ), 1500);
        return;
      }
      cleanup(Math.abs(video.currentTime - targetSeconds) <= 0.03);
    }, 1500);
    assignTarget();
  });
}

async function seekTimeline(timelineMs, { play = false } = {}) {
  const mapping = mapTimelineToSource(project, timelineMs);
  if (!mapping) {
    return;
  }
  cancelPreviewPreload();
  project.playheadMs = mapping.timelineMs;
  activeClipId = mapping.clipId;
  project.selectedClipId = mapping.clipId;
  updatePlayhead();
  if (mediaFile) {
    const matched = await seekPreviewToSourceMs(mapping.sourceMs);
    if (!matched) {
      console.warn("미리보기 플레이어가 요청 시각과 정확히 맞지 않았습니다.");
    }
    if (play) {
      await elements.preview_video.play();
    }
    void prepareNextClipPreview(mapping.clipId);
  }
  updatePlayhead();
}

async function syncPreviewToPlayhead() {
  if (!mediaFile) {
    return;
  }
  const wasPlaying = !elements.preview_video.paused;
  try {
    await seekTimeline(project.playheadMs, { play: wasPlaying });
  } catch (error) {
    if (error.name !== "AbortError") {
      console.warn("미리보기 시각을 다시 맞추지 못했습니다.", error);
    }
  }
}

async function togglePlayback() {
  if (!mediaFile) {
    showToast("먼저 원본 영상을 연결해 주세요.", "error");
    return;
  }
  if (elements.preview_video.paused) {
    await seekTimeline(project.playheadMs, { play: true });
  } else {
    elements.preview_video.pause();
  }
}

function adjacentClip(direction) {
  const enabled = project.clips.filter((clip) => clip.enabled !== false);
  const index = enabled.findIndex((clip) => clip.id === activeClipId);
  const target = enabled[Math.max(0, Math.min(enabled.length - 1, index + direction))];
  if (target) {
    project.selectedClipId = target.id;
    void seekTimeline(target.timelineStartMs);
    renderAll({ keepScroll: true });
  }
}

function handleVideoTimeUpdate(event) {
  const video = event?.currentTarget || elements.preview_video;
  if (
    video !== elements.preview_video
    || pendingPreviewSeek
    || previewBoundaryTransitioning
  ) {
    return;
  }
  const clip = project.clips.find((candidate) => candidate.id === activeClipId);
  if (!clip) {
    return;
  }
  const sourceMs = previewSecondsToSourceMs(video.currentTime);
  if (previewReachedClipBoundary(sourceMs, clip.sourceEndMs)) {
    const next = nextEnabledPreviewClip(project.clips, clip.id);
    if (next && !video.paused) {
      if (transitionToPreparedPreview(next)) {
        return;
      }
      previewBoundaryTransitioning = true;
      cancelPreviewPreload();
      activeClipId = next.id;
      project.selectedClipId = next.id;
      project.playheadMs = next.timelineStartMs;
      updatePlayhead();
      void seekPreviewToSourceMs(next.sourceStartMs)
        .then(() => elements.preview_video.play())
        .then(() => {
          void prepareNextClipPreview(next.id);
        })
        .catch((error) => console.warn("다음 컷 미리보기를 시작하지 못했습니다.", error))
        .finally(() => {
          previewBoundaryTransitioning = false;
        });
      return;
    }
    project.playheadMs = clip.timelineStartMs + clipDurationMs(clip);
    video.pause();
    updatePlayhead();
    return;
  }
  project.playheadMs = Math.max(
    clip.timelineStartMs,
    Math.min(clip.timelineStartMs + clipDurationMs(clip), clip.timelineStartMs + sourceMs - clip.sourceStartMs)
  );
  updatePlayhead();
}

function bindPreviewVideoEvents(video) {
  video.addEventListener("timeupdate", handleVideoTimeUpdate);
  video.addEventListener("play", (event) => {
    if (event.currentTarget !== elements.preview_video) {
      return;
    }
    elements.play_toggle.classList.add("playing");
    startPreviewAudioClock();
    startPreviewPlaybackClock();
    void prepareNextClipPreview(activeClipId);
  });
  video.addEventListener("pause", (event) => {
    if (event.currentTarget !== elements.preview_video) {
      return;
    }
    elements.play_toggle.classList.remove("playing");
    stopPreviewPlaybackClock();
    stopPreviewAudioClock();
  });
  video.addEventListener("loadedmetadata", (event) => {
    if (event.currentTarget !== elements.preview_video) {
      return;
    }
    void renderImageAssetOverlays();
    renderSubtitleOverlay();
  });
}

function selectCue(cueId, { seek = false } = {}) {
  const cue = project.subtitles.find((candidate) => candidate.id === cueId);
  if (!cue) {
    return;
  }
  project = {
    ...project,
    selectedCueId: cue.id,
    selectedClipId: cue.clipId
  };
  inspectorMode = "selected";
  propertyInspectorMode = "caption";
  const range = cueTimelineRange(project, cue);
  if (seek && range) {
    void seekTimeline(range.startMs);
  }
  renderAll({ keepScroll: true });
  scheduleSave();
}

function cueHasOverlap(candidateProject, cueId) {
  return findSubtitleOverlaps(candidateProject).some((overlap) => (
    overlap.firstCueId === cueId || overlap.secondCueId === cueId
  ));
}

function selectAudioRegion(regionId, { seek = false } = {}) {
  const region = project.audioRegions.find((candidate) => candidate.id === regionId);
  if (!region) {
    return;
  }
  project = {
    ...project,
    selectedAudioRegionId: region.id,
    selectedClipId: region.clipId
  };
  propertyInspectorMode = "audio";
  const range = audioRegionTimelineRange(project, region);
  if (seek && range) {
    void seekTimeline(range.startMs);
  }
  renderAll({ keepScroll: true });
  scheduleSave();
}

function selectImageAsset(assetId, { seek = false } = {}) {
  const asset = (project.imageAssets || []).find((candidate) => candidate.id === assetId);
  if (!asset) {
    return;
  }
  project = {
    ...project,
    selectedImageAssetId: asset.id,
    selectedClipId: asset.clipId
  };
  propertyInspectorMode = "asset";
  const range = imageAssetTimelineRange(project, asset);
  if (seek && range) {
    void seekTimeline(range.startMs);
  }
  renderAll({ keepScroll: true });
  scheduleSave();
}

async function inspectImageAssetBlob(blob) {
  if (!(blob instanceof Blob) || blob.size === 0) {
    throw new Error("클립보드나 파일에 이미지 데이터가 없습니다.");
  }
  if (!ALLOWED_IMAGE_ASSET_TYPES.has(blob.type)) {
    throw new Error("PNG, JPEG, WebP 또는 GIF 이미지만 사용할 수 있습니다. SVG는 안전을 위해 제외합니다.");
  }
  if (blob.size > MAX_IMAGE_ASSET_BYTES) {
    throw new Error(`이미지 한 장은 ${formatFileSize(MAX_IMAGE_ASSET_BYTES)} 이하여야 합니다.`);
  }
  let bitmap;
  try {
    bitmap = await createImageBitmap(blob);
    const width = bitmap.width;
    const height = bitmap.height;
    if (
      width <= 0 ||
      height <= 0 ||
      width > MAX_IMAGE_ASSET_DIMENSION ||
      height > MAX_IMAGE_ASSET_DIMENSION ||
      width * height > MAX_IMAGE_ASSET_PIXELS
    ) {
      throw new Error(
        `이미지가 너무 큽니다. 최대 ${MAX_IMAGE_ASSET_DIMENSION}px, ${Math.round(MAX_IMAGE_ASSET_PIXELS / 1_000_000)}메가픽셀까지 사용할 수 있습니다.`
      );
    }
    return { width, height };
  } catch (error) {
    if (error instanceof Error && error.message.includes("이미지가 너무 큽니다")) {
      throw error;
    }
    throw new Error("손상되었거나 브라우저가 읽을 수 없는 이미지입니다.");
  } finally {
    bitmap?.close();
  }
}

function pastedImageName(mimeType) {
  const extension = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif"
  }[mimeType] || "image";
  return `붙여넣은 이미지.${extension}`;
}

async function addImageAssetFromBlob(blob, {
  timelineMs = project.playheadMs,
  name = pastedImageName(blob?.type)
} = {}) {
  if (projectMutationLockCount > 0) {
    showToast("다른 미디어 작업이 끝난 뒤 이미지를 추가해 주세요.", "error");
    return null;
  }
  const mapping = mapTimelineToSource(project, timelineMs);
  if (!mapping) {
    showToast("이미지를 추가할 영상 구간이 없습니다.", "error");
    return null;
  }
  let dimensions;
  try {
    dimensions = await inspectImageAssetBlob(blob);
  } catch (error) {
    showToast(error.message, "error", 0);
    return null;
  }
  const clip = project.clips.find((candidate) => candidate.id === mapping.clipId);
  const startOffsetMs = mapping.clipOffsetMs;
  const endOffsetMs = Math.min(clipDurationMs(clip), startOffsetMs + 2_000);
  if (endOffsetMs - startOffsetMs < 100) {
    showToast("컷 끝에서 최소 0.1초 앞쪽에 이미지를 추가해 주세요.", "error");
    return null;
  }
  const id = `asset-${crypto.randomUUID()}`;
  const asset = createImageAsset(project, {
    id,
    clipId: clip.id,
    startOffsetMs,
    endOffsetMs,
    name: String(name || pastedImageName(blob.type)).slice(0, 160),
    mimeType: blob.type,
    source: { kind: "blob-key", value: id },
    naturalWidth: dimensions.width,
    naturalHeight: dimensions.height
  });
  const nextProject = {
    ...project,
    imageAssets: [...(project.imageAssets || []), asset],
    selectedImageAssetId: asset.id,
    selectedClipId: clip.id
  };
  try {
    await saveProjectWithImageAssetBlob(nextProject, asset.id, blob);
  } catch (error) {
    showToast(`이미지 에셋을 저장하지 못했습니다: ${error.message}`, "error", 0);
    return null;
  }
  propertyInspectorMode = "asset";
  applyProject(nextProject, { save: false });
  await seekTimeline(mapping.timelineMs);
  showToast(
    `${asset.name}을 에셋 트랙에 추가했습니다.${blob.type === "image/png" || blob.type === "image/webp" ? " 투명 배경도 유지됩니다." : ""}`,
    "success"
  );
  return asset;
}

function imageBlobFromPasteEvent(event) {
  const items = [...(event.clipboardData?.items || [])];
  const imageItem = items.find((item) => (
    item.kind === "file" && ALLOWED_IMAGE_ASSET_TYPES.has(item.type)
  ));
  return imageItem?.getAsFile() || null;
}

async function pasteImageFromSystemClipboard(timelineMs = project.playheadMs) {
  if (!navigator.clipboard?.read) {
    elements.stage.focus({ preventScroll: true });
    showToast("편집기에서 Ctrl/Cmd+V를 눌러 이미지를 붙여넣어 주세요.");
    return false;
  }
  try {
    const clipboardItems = await navigator.clipboard.read();
    for (const item of clipboardItems) {
      const type = item.types.find((candidate) => ALLOWED_IMAGE_ASSET_TYPES.has(candidate));
      if (type) {
        const blob = await item.getType(type);
        return Boolean(await addImageAssetFromBlob(blob, { timelineMs }));
      }
    }
    showToast("클립보드에 PNG, JPEG, WebP 또는 GIF 이미지가 없습니다.", "error");
    return false;
  } catch (error) {
    elements.stage.focus({ preventScroll: true });
    showToast(
      error.name === "NotAllowedError"
        ? "클립보드 읽기가 차단됐습니다. 웹에서 ‘이미지 복사’ 후 편집기에서 Ctrl/Cmd+V를 눌러 주세요."
        : `클립보드 이미지를 읽지 못했습니다: ${error.message}`,
      error.name === "NotAllowedError" ? "info" : "error"
    );
    return false;
  }
}

function openImageAssetFilePicker(timelineMs = project.playheadMs) {
  pendingAssetTimelineMs = timelineMs;
  elements.asset_input.click();
}

function addCueAtPlayhead({ timelineMs = project.playheadMs, lane: requestedLane = null } = {}) {
  const mapping = mapTimelineToSource(project, timelineMs);
  if (!mapping) {
    showToast("자막을 추가할 영상 구간이 없습니다.", "error");
    return;
  }
  let workingProject = project;
  const occupiedLanes = new Set(cuesAtTimeline(workingProject, mapping.timelineMs).map((cue) => cue.lane));
  let lane = Number.isInteger(requestedLane) &&
    requestedLane >= 0 &&
    requestedLane < workingProject.subtitleLaneCount &&
    !occupiedLanes.has(requestedLane)
    ? requestedLane
    : Array.from(
      { length: workingProject.subtitleLaneCount },
      (_, index) => index
    ).find((candidate) => !occupiedLanes.has(candidate));
  if (lane === undefined && workingProject.subtitleLaneCount < MAX_SUBTITLE_LANES) {
    workingProject = addSubtitleLane(workingProject);
    lane = workingProject.subtitleLaneCount - 1;
  }
  if (lane === undefined) {
    showToast(`현재 시각의 ${MAX_SUBTITLE_LANES}개 자막 레인이 모두 사용 중입니다.`, "error");
    return;
  }
  const clip = workingProject.clips.find((candidate) => candidate.id === mapping.clipId);
  const startOffsetMs = mapping.clipOffsetMs;
  const nextCueStartMs = workingProject.subtitles
    .filter((cue) => (
      cue.clipId === clip.id &&
      cue.lane === lane &&
      cue.startOffsetMs > startOffsetMs
    ))
    .map((cue) => cue.startOffsetMs)
    .sort((a, b) => a - b)[0] ?? clipDurationMs(clip);
  const endOffsetMs = Math.min(
    clipDurationMs(clip),
    startOffsetMs + 2_000,
    nextCueStartMs
  );
  if (endOffsetMs - startOffsetMs < 100) {
    showToast("이 레인의 다음 자막과 간격이 너무 짧습니다.", "error");
    return;
  }
  const cue = createSubtitleCue(workingProject, {
    clipId: clip.id,
    startOffsetMs,
    endOffsetMs,
    text: "새 자막",
    lane,
    y: Math.max(0.12, (workingProject.subtitleDefaults?.y || 0.84) - lane * 0.1),
    origin: "human"
  });
  propertyInspectorMode = "caption";
  inspectorMode = "selected";
  applyProject({
    ...workingProject,
    subtitles: [...workingProject.subtitles, cue],
    selectedCueId: cue.id,
    selectedClipId: clip.id
  });
  elements.cue_text.focus();
  elements.cue_text.select();
}

function addAudioRegionAtTimeline(timelineMs = project.playheadMs) {
  const mapping = mapTimelineToSource(project, timelineMs);
  if (!mapping) {
    showToast("음성을 조절할 영상 구간이 없습니다.", "error");
    return;
  }
  const activeRegion = audioRegionAtTimeline(project, mapping.timelineMs);
  if (activeRegion) {
    selectAudioRegion(activeRegion.id);
    showToast("현재 시각의 음성 설정 구간을 선택했습니다.");
    return;
  }
  const clip = project.clips.find((candidate) => candidate.id === mapping.clipId);
  const startOffsetMs = mapping.clipOffsetMs;
  const nextRegionStartMs = project.audioRegions
    .filter((region) => region.clipId === clip.id && region.startOffsetMs > startOffsetMs)
    .map((region) => region.startOffsetMs)
    .sort((a, b) => a - b)[0] ?? clipDurationMs(clip);
  const endOffsetMs = Math.min(clipDurationMs(clip), startOffsetMs + 2_000, nextRegionStartMs);
  if (endOffsetMs - startOffsetMs < 100) {
    showToast("다음 음성 설정 구간과 간격이 너무 짧습니다.", "error");
    return;
  }
  const region = createAudioRegion(project, {
    clipId: clip.id,
    startOffsetMs,
    endOffsetMs
  });
  propertyInspectorMode = "audio";
  applyProject({
    ...project,
    audioRegions: [...project.audioRegions, region],
    selectedAudioRegionId: region.id,
    selectedClipId: clip.id
  });
}

function updateSelectedCue(patch, options) {
  const cue = selectedCue();
  if (!cue) {
    return;
  }
  const next = updateSubtitleCue(project, cue.id, patch, options);
  if (cueHasOverlap(next, cue.id)) {
    showToast("같은 자막 레인 안에서는 자막이 겹칠 수 없습니다.", "error");
    renderCueInspector();
    return;
  }
  applyProject(next);
}

function updateSelectedAudioRegion(patch) {
  const region = selectedAudioRegion();
  if (!region) {
    return false;
  }
  const next = updateAudioRegion(project, region.id, patch);
  if (audioRegionHasOverlap(next, region.id)) {
    showToast("음성 설정 구간끼리는 겹칠 수 없습니다.", "error");
    renderAudioInspector();
    return false;
  }
  applyProject(next);
  applyPreviewAudioSettings();
  return true;
}

function updateSelectedImageAsset(patch, { fieldKey = null } = {}) {
  const asset = selectedImageAsset();
  if (!asset) {
    return false;
  }
  const next = updateImageAsset(project, asset.id, patch);
  if (fieldKey) {
    applyFieldProject(next, fieldKey);
  } else {
    applyProject(next);
  }
  return true;
}

function deleteSelectedImageAsset(assetId = selectedImageAsset()?.id) {
  if (!assetId) {
    return;
  }
  const asset = project.imageAssets.find((candidate) => candidate.id === assetId);
  if (!asset) {
    return;
  }
  applyProject(deleteImageAsset(project, asset.id));
  releaseImageAssetObjectUrl(asset.id);
  showToast("이미지 에셋을 삭제했습니다. 실행 취소로 되돌릴 수 있습니다.");
}

async function chooseMediaFile() {
  if (projectMutationLockCount > 0) {
    showToast("다른 미디어 작업이 끝난 뒤 다시 시도해 주세요.", "error");
    return;
  }
  if (typeof window.showOpenFilePicker === "function") {
    try {
      const [handle] = await window.showOpenFilePicker({
        id: "chzzk-kirinuki-source",
        multiple: false,
        types: [{
          description: "영상 파일",
          accept: {
            "video/*": [".mp4", ".mkv", ".webm", ".mov", ".m4v", ".ts"],
            "audio/*": [".m4a", ".mp3", ".wav", ".flac", ".ogg"]
          }
        }]
      });
      const file = await handle.getFile();
      const attached = await attachMediaFile(file);
      if (attached) {
        const handleSaved = await saveMediaHandle(project.id, handle);
        if (handleSaved) {
          const persistedProject = {
            ...project,
            mediaAsset: {
              ...project.mediaAsset,
              fileHandleStored: true
            },
            updatedAt: new Date().toISOString()
          };
          try {
            await saveProject(persistedProject);
            project = persistedProject;
            mediaHandle = handle;
          } catch (error) {
            mediaHandle = null;
            await deleteMediaHandle(project.id);
            showToast(
              `원본은 현재 탭에 연결했지만 재시작용 파일 권한을 저장하지 못했습니다: ${error.message}`,
              "error",
              0
            );
          }
        } else {
          mediaHandle = null;
          await deleteMediaHandle(project.id);
          showToast(
            "원본은 현재 탭에 연결했지만 파일 권한을 저장하지 못했습니다. 편집기를 다시 열면 원본을 다시 선택해 주세요.",
            "error",
            0
          );
        }
      }
    } catch (error) {
      if (error.name !== "AbortError") {
        showToast(`원본 파일을 열지 못했습니다: ${error.message}`, "error", 0);
      }
    }
    return;
  }
  elements.media_input.click();
}

async function attachMediaFile(file, { fileHandleStored = false } = {}) {
  lockProjectMutations();
  showJob("원본을 살펴보고 있어요", "메타데이터와 영상 트랙을 확인합니다.", 0.08, { cancelable: false });
  const previousMediaUrl = mediaUrl;
  let nextMediaUrl = null;
  try {
    cancelPreviewPreload({ clearSource: true });
    const asset = await inspectMediaFile(file);
    if (!asset.hasVideo) {
      throw new Error("영상 트랙이 없는 파일입니다.");
    }
    nextMediaUrl = URL.createObjectURL(file);
    await new Promise((resolve, reject) => {
      const cleanup = () => {
        elements.preview_video.removeEventListener("loadedmetadata", onLoaded);
        elements.preview_video.removeEventListener("error", onError);
      };
      const onLoaded = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error("Chrome 영상 플레이어가 파일을 열지 못했습니다."));
      };
      elements.preview_video.addEventListener("loadedmetadata", onLoaded);
      elements.preview_video.addEventListener("error", onError);
      elements.preview_video.src = nextMediaUrl;
    });
    const mediaIdentityChanged = !sameCaptionMediaIdentity(
      project.mediaAsset,
      asset
    );
    const nextProject = {
      ...project,
      ...(mediaIdentityChanged
        ? {
          ai: {
            ...project.ai,
            captionCheckpoints: []
          }
        }
        : {}),
      mediaAsset: {
        ...asset,
        fileHandleStored
      },
      updatedAt: new Date().toISOString()
    };
    await saveProject(nextProject);
    mediaFile = file;
    mediaUrl = nextMediaUrl;
    project = nextProject;
    if (previousMediaUrl && previousMediaUrl !== nextMediaUrl) {
      URL.revokeObjectURL(previousMediaUrl);
    }
    hideJob();
    renderAll();
    await seekTimeline(project.playheadMs || 0);
    const overrun = clipOutsideMedia(project);
    if (overrun) {
      showToast("선택 구간 일부가 연결한 원본 길이 밖에 있습니다. 페이지↔로컬 정렬값을 확인해 주세요.", "error", 7000);
    } else {
      showToast("원본 영상을 연결했습니다.", "success");
    }
    return true;
  } catch (error) {
    if (nextMediaUrl && nextMediaUrl !== mediaUrl) {
      URL.revokeObjectURL(nextMediaUrl);
    }
    if (previousMediaUrl && elements.preview_video.src !== previousMediaUrl) {
      elements.preview_video.src = previousMediaUrl;
      if (standbyPreviewVideo) {
        standbyPreviewVideo.src = previousMediaUrl;
      }
    } else if (!previousMediaUrl && !mediaUrl) {
      elements.preview_video.removeAttribute("src");
      elements.preview_video.load();
      cancelPreviewPreload({ clearSource: true });
    }
    hideJob();
    showToast(error.message, "error", 0);
    return false;
  } finally {
    unlockProjectMutations();
  }
}

function readCaptionAgentConfig() {
  return {
    endpoint: normalizeCaptionAgentEndpoint(elements.caption_agent_endpoint.value),
    token: elements.caption_agent_token.value,
    model: elements.caption_model.value,
    providerConfig: {
      sttEndpoint: elements.caption_stt_endpoint.value,
      sttModel: elements.caption_stt_model.value,
      sttApiKey: elements.caption_stt_api_key.value,
      upstageApiKey: elements.caption_upstage_api_key.value
    }
  };
}

function setCaptionLocalStatus(message, state = "idle") {
  elements.caption_local_status.textContent = message;
  elements.caption_local_status.dataset.state = state;
}

async function ensureLocalCaptionSession(config, signal) {
  if (!isLoopbackCaptionAgentEndpoint(config.endpoint)) {
    return config;
  }
  setCaptionLocalStatus(
    String(config.token || "").trim()
      ? "로컬 자막 엔진 세션을 확인하는 중"
      : "로컬 자막 엔진에 자동 연결하는 중",
    "connecting"
  );
  const token = await ensureCaptionAgentSession({
    endpoint: config.endpoint,
    token: config.token,
    signal
  });
  elements.caption_agent_token.value = token;
  setCaptionLocalStatus(
    "로컬 STT 준비됨 · Solar API 키만 현재 탭에 입력하세요",
    "ready"
  );
  return { ...config, token };
}

async function prepareCaptionAgentConfig() {
  let config = readCaptionAgentConfig();
  const permissionGranted = await ensureCaptionAgentPermission(config.endpoint);
  if (!permissionGranted) {
    throw new Error("자막 에이전트 주소 접근 권한이 허용되지 않았습니다.");
  }
  config = await ensureLocalCaptionSession(
    config,
    activeJobController?.signal
  );
  captionAgentSettings = await saveCaptionAgentSettings({
    endpoint: config.endpoint,
    model: config.model,
    sttEndpoint: config.providerConfig.sttEndpoint,
    sttModel: config.providerConfig.sttModel
  });
  elements.caption_agent_endpoint.value = captionAgentSettings.endpoint;
  elements.caption_stt_endpoint.value = captionAgentSettings.sttEndpoint;
  elements.caption_stt_model.value = captionAgentSettings.sttModel;
  return {
    ...config,
    ...captionAgentSettings,
    providerConfig: {
      ...config.providerConfig,
      sttEndpoint: captionAgentSettings.sttEndpoint,
      sttModel: captionAgentSettings.sttModel
    }
  };
}

function formatCaptionRunDuration(milliseconds) {
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return [
    hours > 0 ? `${hours}시간` : "",
    minutes > 0 ? `${minutes}분` : "",
    `${seconds}초`
  ].filter(Boolean).join(" ");
}

function confirmCaptionAgentRun(enabledClips, { skippedClipCount = 0 } = {}) {
  const estimate = captionAgentRunEstimate(enabledClips);
  const selectedModel = elements.caption_model.value === "solar-mini"
    ? "Solar Mini"
    : "Solar Pro 3";
  let externalStt = false;
  try {
    externalStt = Boolean(
      elements.caption_stt_endpoint.value.trim()
      && !isLoopbackCaptionAgentEndpoint(elements.caption_stt_endpoint.value)
    );
  } catch {
    externalStt = true;
  }
  const sttNotice = externalStt
    ? "고급 설정의 외부 STT도 별도 과금될 수 있습니다"
    : "로컬 STT는 별도 API 과금이 없습니다";
  return window.confirm([
    skippedClipCount > 0
      ? "중단된 Solar 자막 초벌을 이어서 할까요?"
      : "Solar 자막 초벌을 시작할까요?",
    "",
    ...(skippedClipCount > 0
      ? [`저장 완료된 컷 ${skippedClipCount}개는 건너뜁니다`]
      : []),
    `활성 컷 ${estimate.clipCount}개 · 총 ${formatCaptionRunDuration(estimate.totalDurationMs)}`,
    `${selectedModel} 요청 ${estimate.plannedSolarRequests}회 · 컷당 1회`,
    `로컬 품질 보정 추가 Solar 호출 0회 · 최대 ${estimate.maximumSolarRequests}회`,
    sttNotice,
    "",
    "취소하면 오디오 추출과 유료 API 요청은 시작되지 않습니다."
  ].join("\n"));
}

async function testCaptionAgentConnection() {
  if (activeJobController || projectMutationLockCount > 0) {
    return;
  }
  const controller = new AbortController();
  activeJobController = controller;
  elements.test_caption_agent.disabled = true;
  try {
    const config = await prepareCaptionAgentConfig();
    const result = await probeCaptionAgent({
      ...config,
      signal: controller.signal
    });
    const availableModels = Array.isArray(result.availableModels)
      ? result.availableModels.map((model) => String(model))
      : [];
    if (
      availableModels.length > 0
      && !availableModels.includes(config.model)
    ) {
      throw new Error(`로컬 companion이 ${config.model} 모델을 지원하지 않습니다.`);
    }
    const provider = result.provider ? ` · ${result.provider}` : "";
    const model = config.model;
    const readiness = result.configured?.ready === false
      ? " · STT/Upstage 설정 미완료"
      : "";
    showToast(
      `자막 에이전트 연결 확인 완료${provider} · ${model}${readiness}`,
      result.configured?.ready === false ? "error" : "success",
      result.configured?.ready === false ? 0 : 5200
    );
    setCaptionLocalStatus(
      result.configured?.ready === false
        ? "로컬 STT 연결됨 · Solar API 키를 현재 탭에 입력하세요"
        : "로컬 STT 준비됨 · Solar 자막 초벌을 시작할 수 있습니다",
      result.configured?.ready === false ? "waiting" : "ready"
    );
  } catch (error) {
    const canceled = error.name === "AbortError";
    if (!canceled) {
      elements.caption_advanced_settings.open = true;
    }
    showToast(
      canceled ? "자막 에이전트 연결 확인을 취소했습니다." : `자막 에이전트 연결 실패: ${error.message}`,
      canceled ? "info" : "error",
      0
    );
    setCaptionLocalStatus(
      "로컬 자막 엔진 연결 필요 · 세부설정에서 실행 상태를 확인하세요",
      "error"
    );
  } finally {
    activeJobController = null;
    elements.test_caption_agent.disabled = false;
  }
}

function setAiProgress(progress, label) {
  const value = Math.max(0, Math.min(1, Number(progress) || 0));
  elements.ai_progress.hidden = false;
  elements.ai_progress.querySelector(".progress-track span").style.width = `${Math.round(value * 100)}%`;
  elements.ai_progress_value.textContent = `${Math.round(value * 100)}%`;
  elements.ai_progress_label.textContent = label;
  if (!elements.job_dialog.hidden) {
    updateJob(value, label);
  }
}

async function generateCaptions() {
  if (!mediaFile) {
    showToast("AI 자막을 만들려면 먼저 원본 영상을 연결해 주세요.", "error");
    return;
  }
  const allEnabledClips = project.clips.filter(
    (clip) => clip.enabled !== false
  );
  if (allEnabledClips.length === 0) {
    showToast("선택한 구간이 없습니다.", "error");
    return;
  }
  if (allEnabledClips.length > MAX_CAPTION_AGENT_CLIPS_PER_RUN) {
    showToast(
      `한 번에 자막을 만들 수 있는 활성 컷은 최대 ${MAX_CAPTION_AGENT_CLIPS_PER_RUN}개입니다.`,
      "error",
      0
    );
    return;
  }
  if (activeJobController || projectMutationLockCount > 0) {
    return;
  }
  const selectedModel = elements.caption_model.value;
  const resumeEligible = ["running", "error", "canceled"].includes(
    project.ai?.status
  );
  const resumePlan = captionAgentResumePlan(
    allEnabledClips,
    project.ai?.captionCheckpoints,
    selectedModel,
    { resume: resumeEligible }
  );
  const enabledClips = resumePlan.clips;
  if (enabledClips.length === 0 && resumePlan.skippedClipIds.length > 0) {
    project = {
      ...project,
      ai: {
        ...project.ai,
        status: "done",
        progress: 1,
        lastRunAt: new Date().toISOString(),
        error: null
      }
    };
    await saveProject(project);
    renderAll({ keepScroll: true });
    showToast(
      "저장된 컷별 자막 체크포인트를 확인했습니다. 다시 과금할 컷이 없습니다.",
      "success",
      6500
    );
    return;
  }
  if (!confirmCaptionAgentRun(enabledClips, {
    skippedClipCount: resumePlan.skippedClipIds.length
  })) {
    showToast("Solar 자막 초벌을 시작하지 않았습니다.", "info");
    return;
  }
  const returnFocus = document.activeElement;
  const controller = new AbortController();
  activeJobController = controller;
  elements.generate_captions.disabled = true;
  let config;
  try {
    config = await prepareCaptionAgentConfig();
  } catch (error) {
    elements.caption_advanced_settings.open = true;
    showToast(`자막 에이전트 설정을 확인해 주세요: ${error.message}`, "error", 0);
    setCaptionLocalStatus(
      "로컬 자막 엔진 연결 필요 · 세부설정에서 실행 상태를 확인하세요",
      "error"
    );
    activeJobController = null;
    elements.generate_captions.disabled = false;
    if (returnFocus?.isConnected) {
      returnFocus.focus();
    }
    return;
  }
  const { endpoint, token, model, providerConfig } = config;
  let activeCaptionSessionToken = token;
  const undoSnapshot = cloneProject(project);
  let undoRecorded = false;
  let reviewRequiredCount = 0;
  let captionWarnings = resumePlan.skippedClipIds.length > 0
    ? [...(project.ai?.warnings || [])]
    : [];
  let generatedCueCount = 0;
  showJob(
    "Solar 자막 초안을 만드는 중",
    resumePlan.skippedClipIds.length > 0
      ? `이미 저장된 ${resumePlan.skippedClipIds.length}개 컷은 건너뛰고 실패 지점부터 이어서 처리합니다.`
      : "활성화된 모든 선택 컷의 음성을 차례로 로컬 STT에 보내고, 전사문과 고지된 이름·메모 문맥은 Solar에 보냅니다.",
    0,
    { cancelable: true, returnFocus }
  );
  project = {
    ...project,
    ai: {
      ...project.ai,
      provider: "caption-agent",
      model,
      status: "running",
      progress: 0,
      error: null,
      warnings: captionWarnings,
      captionCheckpoints: resumeEligible
        ? project.ai?.captionCheckpoints
        : discardCaptionAgentCheckpointsForClips(
          project.ai?.captionCheckpoints,
          allEnabledClips
      )
    }
  };
  renderHeader();

  lockProjectMutations();
  try {
    await saveProject(project);
    const clips = enabledClips;
    for (let index = 0; index < clips.length; index += 1) {
      const clip = clips[index];
      const base = index / clips.length;
      const span = 1 / clips.length;
      captionAgentAudioFootprint(clipDurationMs(clip));
      setAiProgress(base, `${index + 1}/${clips.length} · 화면 안전 영역을 로컬 분석하는 중`);
      let placementHints;
      try {
        placementHints = await extractClipCaptionPlacementHints(
          mediaFile,
          clip,
          {
            signal: controller.signal,
            onProgress: (value) => {
              setAiProgress(
                base + span * value * 0.1,
                `${index + 1}/${clips.length} · 대표 프레임 안전 영역 분석 중`
              );
            }
          }
        );
      } catch (error) {
        if (controller.signal.aborted || error?.name === "AbortError") {
          throw error;
        }
        console.warn("대표 프레임 자막 위치 분석에 실패했습니다.", error);
        placementHints = fallbackCaptionPlacementHints(clipDurationMs(clip));
        captionWarnings = mergeAiWarnings(
          captionWarnings,
          [{
            code: "LOCAL_VISUAL_ANALYSIS_FAILED",
            cueIndex: 0
          }],
          clip.id
        );
      }
      setAiProgress(
        base + span * 0.1,
        `${index + 1}/${clips.length} · 선택 구간의 음성을 준비하는 중`
      );
      const pcm = await extractClipPcm16k(mediaFile, clip, {
        signal: controller.signal,
        onProgress: (value) => {
          setAiProgress(
            base + span * (0.1 + value * 0.16),
            `${index + 1}/${clips.length} · 전송할 음성 추출 중`
          );
        }
      });
      controller.signal.throwIfAborted();
      setAiProgress(base + span * 0.28, `${index + 1}/${clips.length} · WAV 요청 준비 중`);
      const request = createCaptionAgentRequest({
        project,
        clip,
        model,
        audioBase64: encodePcm16WavBase64(pcm),
        placementHints
      });
      const result = await requestCaptionAgentWithSessionRetry({
        endpoint,
        token: activeCaptionSessionToken,
        providerConfig,
        request,
        signal: controller.signal,
        onSessionToken: (nextToken) => {
          activeCaptionSessionToken = nextToken;
          elements.caption_agent_token.value = nextToken;
          setCaptionLocalStatus(
            "로컬 자막 엔진에 다시 연결됨 · 작업을 이어갑니다",
            "ready"
          );
        },
        onProgress: (progress, label) => {
          const local = 0.28 + Math.max(0, Math.min(1, progress)) * 0.7;
          setAiProgress(base + span * local, `${index + 1}/${clips.length} · ${label}`);
        }
      });
      const normalizedDrafts = normalizeCaptionAgentCues(
        result.cues,
        clipDurationMs(clip)
      );
      const speakerColors = captionSpeakerColorAssignments(
        normalizedDrafts.map((draft) => draft.remoteMeta?.speakerId),
        project.ai?.speakerColors
      );
      const drafts = normalizedDrafts.map((draft) => ({
        ...draft,
        color: speakerColors[
          String(draft.remoteMeta?.speakerId || "").trim().toLowerCase()
        ] || captionSpeakerColor(draft.remoteMeta?.speakerId)
      }));
      generatedCueCount += drafts.length;
      if (generatedCueCount > MAX_CAPTION_AGENT_CUES_PER_RUN) {
        throw new Error(
          `한 번에 만들 수 있는 AI 자막은 최대 ${MAX_CAPTION_AGENT_CUES_PER_RUN.toLocaleString("ko-KR")}개입니다. 활성 컷을 나눠서 실행해 주세요.`
        );
      }
      captionWarnings = mergeAiWarnings(
        captionWarnings,
        result.warnings,
        clip.id
      );
      reviewRequiredCount += drafts.filter((draft) => (
        draft.remoteMeta?.reviewRequired
      )).length;
      if (!undoRecorded) {
        pushUndo(undoSnapshot);
        undoRecorded = true;
      }
      project = {
        ...replaceAiSubtitleDraft(project, clip.id, drafts),
        ai: {
          ...project.ai,
          provider: String(result.provider || "caption-agent"),
          model,
          resolvedModel: String(result.resolvedModel || result.model || model),
          lastRequestId: String(result.requestId || ""),
          captionCheckpoints: upsertCaptionAgentCheckpoint(
            project.ai?.captionCheckpoints,
            createCaptionAgentCheckpoint(clip, model, {
              requestId: result.requestId
            })
          ),
          status: "running",
          progress: Math.min(0.99, (index + 1) / clips.length),
          error: null,
          warnings: captionWarnings,
          speakerColors
        }
      };
      await saveProject(project);
      renderAll({ keepScroll: true });
      setAiProgress(base + span, `${index + 1}/${clips.length} · 자막 초안 저장 완료`);
    }
    project = {
      ...project,
      ai: {
        ...project.ai,
        status: "done",
        progress: 1,
        lastRunAt: new Date().toISOString(),
        error: null
      }
    };
    await saveProject(project);
    setAiProgress(1, "선택 구간 자막 초안 완료");
    const reviewWarningCount = captionWarnings.filter(
      (warning) => CAPTION_REVIEW_WARNING_CODES.has(warning.code)
    ).length;
    showToast(
      reviewWarningCount > 0
        ? `Solar 자막과 로컬 하네스 처리를 마쳤습니다. 재확인이 필요한 품질 경고 ${reviewWarningCount}건을 확인해 주세요.`
        : reviewRequiredCount > 0
        ? `Solar 자막 초안을 만들었습니다. 재확인이 필요한 ${reviewRequiredCount}개 자막은 노란색으로 표시했습니다.`
        : captionWarnings.length > 0
          ? `Solar 초안을 만들고 키리누키 품질 하네스가 ${captionWarnings.length}건을 자동 정리했습니다.`
          : "Solar 자막 초안을 만들었습니다. 텍스트·시간을 한 번 검수해 주세요.",
      reviewWarningCount > 0 ? "error" : "success",
      reviewWarningCount > 0 ? 9000 : 6500
    );
  } catch (error) {
    const canceled = error.name === "AbortError";
    if (
      !canceled
      && /(?:STT|전사|companion|에이전트|API 키)/iu.test(error.message)
    ) {
      elements.caption_advanced_settings.open = true;
    }
    project = {
      ...project,
      ai: {
        ...project.ai,
        status: canceled ? "canceled" : "error",
        error: canceled ? null : error.message
      }
    };
    await saveProject(project);
    elements.ai_progress.hidden = true;
    showToast(canceled ? "AI 자막 작업을 취소했습니다." : `AI 자막 실패: ${error.message}`, canceled ? "info" : "error", 0);
  } finally {
    activeJobController = null;
    elements.generate_captions.disabled = false;
    hideJob();
    renderAll({ keepScroll: true });
    unlockProjectMutations();
  }
}

function cancelActiveJob() {
  if (!activeJobCancelable) {
    return;
  }
  activeJobController?.abort();
}

function setJobCancelable(cancelable) {
  activeJobCancelable = Boolean(cancelable);
  elements.cancel_job.hidden = !activeJobCancelable;
  elements.cancel_job.disabled = !activeJobCancelable;
  if (!activeJobCancelable && document.activeElement === elements.cancel_job) {
    elements.job_dialog.querySelector(".job-card")?.focus();
  }
}

function showJob(
  title,
  message,
  progress = 0,
  { cancelable = true, returnFocus = document.activeElement } = {}
) {
  focusBeforeJob = returnFocus;
  elements.job_title.textContent = title;
  elements.job_message.textContent = message;
  setJobCancelable(cancelable);
  updateJob(progress);
  elements.job_dialog.hidden = false;
  if (!elements.job_dialog.open) {
    elements.job_dialog.showModal();
  }
  const focusTarget = cancelable
    ? elements.cancel_job
    : elements.job_dialog.querySelector(".job-card");
  focusTarget.focus();
}

function updateJob(progress, message) {
  const value = Math.max(0, Math.min(1, Number(progress) || 0));
  elements.job_progress.style.width = `${Math.round(value * 100)}%`;
  elements.job_percent.textContent = `${Math.round(value * 100)}%`;
  if (message) {
    elements.job_message.textContent = message;
  }
}

function hideJob() {
  if (elements.job_dialog.open) {
    elements.job_dialog.close();
  }
  elements.job_dialog.hidden = true;
  activeJobCancelable = false;
  if (focusBeforeJob?.isConnected) {
    focusBeforeJob.focus();
  }
  focusBeforeJob = null;
}

function triggerDownload(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 2_000);
}

function createSidecars(baseName, projectSnapshot) {
  const sidecars = [{
    name: `${baseName}.kirinuki.json`,
    blob: new Blob([`${JSON.stringify(projectSnapshot, null, 2)}\n`], { type: "application/json" })
  }];
  const srt = serializeSrt(projectSnapshot);
  if (srt) {
    sidecars.push({
      name: `${baseName}.ko.srt`,
      blob: new Blob([srt], { type: "application/x-subrip;charset=utf-8" })
    });
  }
  return sidecars;
}

function downloadSidecars(sidecars) {
  sidecars.forEach(({ blob, name }) => triggerDownload(blob, name));
}

async function writeBlobToFileHandle(fileHandle, blob) {
  const writable = await fileHandle.createWritable();
  let closed = false;
  try {
    await writable.write(blob);
    await writable.close();
    closed = true;
  } catch (error) {
    if (!closed && typeof writable.abort === "function") {
      try {
        await writable.abort(error);
      } catch {
        // Preserve the original write failure.
      }
    }
    throw error;
  }
}

async function saveSidecarsToDirectory(directoryHandle, sidecars) {
  for (const { blob, name } of sidecars) {
    try {
      const fileHandle = await directoryHandle.getFileHandle(name, { create: true });
      await writeBlobToFileHandle(fileHandle, blob);
    } catch (error) {
      await directoryHandle.removeEntry(name).catch(() => {});
      throw error;
    }
  }
}

async function directoryFileExists(directoryHandle, name) {
  try {
    await directoryHandle.getFileHandle(name);
    return true;
  } catch (error) {
    if (error.name === "NotFoundError") {
      return false;
    }
    throw error;
  }
}

async function chooseUniqueExportBaseName(directoryHandle, requestedBaseName, extension) {
  for (let index = 1; index <= 999; index += 1) {
    const candidate = index === 1
      ? requestedBaseName
      : `${requestedBaseName} (${index})`;
    const names = [
      `${candidate}.${extension}`,
      `${candidate}.kirinuki.json`,
      `${candidate}.ko.srt`
    ];
    const conflicts = await Promise.all(
      names.map((name) => directoryFileExists(directoryHandle, name))
    );
    if (conflicts.every((exists) => !exists)) {
      return candidate;
    }
  }
  throw new Error("같은 이름의 내보내기가 너무 많습니다. 프로젝트명을 바꿔 주세요.");
}

async function exportVideo() {
  if (!mediaFile) {
    showToast("먼저 원본 영상을 연결해 주세요.", "error");
    return;
  }
  if (!project.clips.some((clip) => clip.enabled !== false)) {
    showToast("내보낼 사용자 선택 구간이 없습니다.", "error");
    return;
  }
  if (findSubtitleOverlaps(project).length > 0) {
    showToast("같은 레인 안에서 겹치는 자막이 있습니다. 자막 시각을 먼저 조정해 주세요.", "error", 0);
    return;
  }
  if (findAudioRegionOverlaps(project).length > 0) {
    showToast("서로 겹치는 음성 설정 구간이 있습니다. 구간 시각을 먼저 조정해 주세요.", "error", 0);
    return;
  }
  if (activeJobController || projectMutationLockCount > 0) {
    showToast("다른 미디어 작업이 끝난 뒤 다시 시도해 주세요.", "error");
    return;
  }

  lockProjectMutations();
  try {
    if (document.fonts?.load) {
      try {
        const family = String(
          project.subtitleDefaults?.fontFamily || "Pretendard"
        ).replace(/["\\]/gu, "");
        const weight = Math.round(
          Number(project.subtitleDefaults?.fontWeight) || 800
        );
        await document.fonts.load(`${weight} 48px "${family}"`);
      } catch (error) {
        showToast(`자막 폰트를 준비하지 못했습니다: ${error.message}`, "error", 0);
        return;
      }
    }
    const exportProject = cloneProject(project);
    let profile;
    try {
      profile = await getPreferredOutputProfile(mediaFile, exportProject);
    } catch (error) {
      showToast(`이 브라우저에서 영상 인코더를 준비하지 못했습니다: ${error.message}`, "error", 0);
      return;
    }

    let baseName = sanitizeFileName(exportProject.name);
    let videoName = `${baseName}.${profile.extension}`;
    let directoryHandle = null;
    let handle = null;
    let directoryVideoCreated = false;
    if (typeof window.showDirectoryPicker === "function") {
      try {
        directoryHandle = await window.showDirectoryPicker({
          id: "chzzk-kirinuki-export",
          mode: "readwrite"
        });
        baseName = await chooseUniqueExportBaseName(
          directoryHandle,
          baseName,
          profile.extension
        );
        videoName = `${baseName}.${profile.extension}`;
        handle = await directoryHandle.getFileHandle(videoName, { create: true });
        directoryVideoCreated = true;
      } catch (error) {
        if (error.name === "AbortError") {
          return;
        }
        showToast(`저장 폴더를 열지 못했습니다: ${error.message}`, "error", 0);
        return;
      }
    } else if (typeof window.showSaveFilePicker === "function") {
      try {
        handle = await window.showSaveFilePicker({
          id: "chzzk-kirinuki-export",
          suggestedName: videoName,
          types: [{
            description: profile.extension === "mp4" ? "MP4 영상" : "WebM 영상",
            accept: { [profile.mimeType]: [`.${profile.extension}`] }
          }]
        });
      } catch (error) {
        if (error.name === "AbortError") {
          return;
        }
        showToast(`저장 위치를 열지 못했습니다: ${error.message}`, "error", 0);
        return;
      }
    }

    const sidecars = createSidecars(baseName, exportProject);
    const controller = new AbortController();
    activeJobController = controller;
    elements.export_video.disabled = true;
    let renderCompleted = false;
    try {
      showJob(
        "컷과 자막을 영상으로 만드는 중",
        "선택한 구간만 원본에서 읽고 있습니다.",
        0,
        { cancelable: true }
      );
      const result = await renderProjectVideo(mediaFile, exportProject, {
        fileHandle: handle,
        signal: controller.signal,
        resolveImageAsset: (source) => loadImageAssetBlob(exportProject.id, source.value),
        onProgress: (progress, stage) => {
          const label = stage === "finalize"
            ? "파일을 마무리하는 중 · 이 단계는 취소할 수 없습니다"
            : "컷 연결과 자막 합성 중";
          if (stage === "finalize") {
            setJobCancelable(false);
          }
          updateJob(progress, label);
        }
      });
      renderCompleted = true;
      if (result.blob) {
        triggerDownload(result.blob, `${baseName}.${result.extension}`);
      }
      if (directoryHandle) {
        await saveSidecarsToDirectory(directoryHandle, sidecars);
      } else {
        downloadSidecars(sidecars);
      }
      hideJob();
      showToast(
        `영상과 편집 프로젝트${sidecars.length > 1 ? "·SRT" : ""}를 ${directoryHandle ? "선택한 폴더에 " : ""}저장했습니다.`,
        "success",
        6000
      );
    } catch (error) {
      let cleanupFailed = false;
      if (directoryHandle && directoryVideoCreated && !renderCompleted) {
        try {
          await directoryHandle.removeEntry(videoName);
          directoryVideoCreated = false;
        } catch {
          cleanupFailed = true;
        }
      }
      hideJob();
      const canceled = error.name === "AbortError";
      const cleanupMessage = cleanupFailed
        ? " 생성된 빈 영상 파일은 지우지 못했습니다."
        : "";
      showToast(
        canceled
          ? `영상 내보내기를 취소했습니다.${cleanupMessage}`
          : renderCompleted
            ? `영상은 저장했지만 프로젝트·SRT 저장에 실패했습니다: ${error.message}`
            : `영상 내보내기 실패: ${error.message}${cleanupMessage}`,
        canceled && !cleanupFailed ? "info" : "error",
        0
      );
    } finally {
      activeJobController = null;
      elements.export_video.disabled = false;
      renderHeader();
    }
  } finally {
    unlockProjectMutations();
  }
}

async function exportVideoWithLock() {
  if (exportRequestPending) {
    showToast("영상 내보내기 요청이 이미 진행 중입니다.", "error");
    return;
  }
  exportRequestPending = true;
  try {
    if (!navigator.locks?.request) {
      return await exportVideo();
    }
    return await navigator.locks.request(
      EXPORT_LOCK_NAME,
      { mode: "exclusive" },
      () => exportVideo()
    );
  } finally {
    exportRequestPending = false;
  }
}

async function focusSourceTab({ seek = false } = {}) {
  try {
    const mapping = mapTimelineToSource(project, project.playheadMs);
    const response = await chrome.runtime.sendMessage({
      type: "KIRINUKI_EDITOR_SOURCE_ACTION",
      projectId: project.id,
      action: seek ? "seek-and-focus" : "focus",
      sourceSeconds: mapping
        ? (mapping.sourceMs - (project.broadcastSession?.alignmentOffsetMs || 0)) / 1000
        : null
    });
    if (!response?.ok) {
      throw new Error(response?.error || "원래 영상 탭을 찾지 못했습니다.");
    }
    sourceBindingConnected = true;
    renderHeader();
  } catch (error) {
    sourceBindingConnected = false;
    renderHeader();
    showToast(error.message, "error");
  }
}

function bindOverlayDrag() {
  elements.subtitle_overlays.addEventListener("pointerdown", (event) => {
    const overlay = event.target.closest(".subtitle-overlay");
    const cueId = overlay?.dataset.cueId;
    if (!cueId) {
      return;
    }
    event.preventDefault();
    const cue = project.subtitles.find((candidate) => candidate.id === cueId);
    project = {
      ...project,
      selectedCueId: cueId,
      selectedClipId: cue.clipId
    };
    propertyInspectorMode = "caption";
    inspectorMode = "selected";
    elements.subtitle_overlays.querySelectorAll(".subtitle-overlay").forEach((candidate) => {
      candidate.classList.toggle("selected", candidate === overlay);
    });
    elements.caption_tracks.querySelectorAll(".cue-block").forEach((candidate) => {
      candidate.classList.toggle("selected", candidate.dataset.id === cueId);
    });
    renderPropertyInspector();
    beginPointerHistory();
    const pointerId = event.pointerId;
    overlay.setPointerCapture(pointerId);
    elements.stage.classList.add("dragging-subtitle");
    const move = (moveEvent) => {
      if (moveEvent.pointerId !== pointerId) {
        return;
      }
      const rect = elements.stage.getBoundingClientRect();
      const content = videoContentRect();
      const x = Math.max(0.05, Math.min(0.95, (moveEvent.clientX - rect.left - content.left) / content.width));
      const y = Math.max(0.05, Math.min(0.95, (moveEvent.clientY - rect.top - content.top) / content.height));
      project = updateSubtitleCue(project, cueId, { x, y });
      renderCueInspector();
      overlay.style.left = `${content.left + content.width * x}px`;
      overlay.style.top = `${content.top + content.height * y}px`;
    };
    const finish = (finishEvent) => {
      if (finishEvent?.pointerId !== undefined && finishEvent.pointerId !== pointerId) {
        return;
      }
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      if (overlay.hasPointerCapture(pointerId)) {
        overlay.releasePointerCapture(pointerId);
      }
      elements.stage.classList.remove("dragging-subtitle");
      endPointerHistory();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  });
}

function bindImageAssetOverlayDrag() {
  elements.image_asset_overlays.addEventListener("pointerdown", (event) => {
    const overlay = event.target.closest(".image-asset-overlay");
    const assetId = overlay?.dataset.assetId;
    const asset = project.imageAssets.find((candidate) => candidate.id === assetId);
    if (!overlay || !asset) {
      return;
    }
    event.preventDefault();
    project = {
      ...project,
      selectedImageAssetId: asset.id,
      selectedClipId: asset.clipId
    };
    propertyInspectorMode = "asset";
    elements.image_asset_overlays.querySelectorAll(".image-asset-overlay").forEach((candidate) => {
      candidate.classList.toggle("selected", candidate === overlay);
    });
    elements.asset_track.querySelectorAll(".asset-block").forEach((candidate) => {
      candidate.classList.toggle("selected", candidate.dataset.id === asset.id);
    });
    renderPropertyInspector();
    beginPointerHistory();
    const pointerId = event.pointerId;
    overlay.setPointerCapture(pointerId);
    elements.stage.classList.add("dragging-asset");
    const move = (moveEvent) => {
      if (moveEvent.pointerId !== pointerId) {
        return;
      }
      const rect = elements.stage.getBoundingClientRect();
      const content = videoContentRect();
      const x = Math.max(0, Math.min(1, (moveEvent.clientX - rect.left - content.left) / content.width));
      const y = Math.max(0, Math.min(1, (moveEvent.clientY - rect.top - content.top) / content.height));
      project = updateImageAsset(project, asset.id, { x, y });
      renderImageAssetInspector();
      overlay.style.left = `${content.left + content.width * x}px`;
      overlay.style.top = `${content.top + content.height * y}px`;
    };
    const finish = (finishEvent) => {
      if (finishEvent?.pointerId !== undefined && finishEvent.pointerId !== pointerId) {
        return;
      }
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      if (overlay.hasPointerCapture(pointerId)) {
        overlay.releasePointerCapture(pointerId);
      }
      elements.stage.classList.remove("dragging-asset");
      endPointerHistory();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  });
}

function closeTimelineContextMenu() {
  elements.timeline_context_menu.hidden = true;
  timelineContext = null;
}

function openTimelineContextMenu(event) {
  const clipBlock = event.target.closest(".clip-block");
  const cueBlock = event.target.closest(".cue-block");
  const assetBlock = event.target.closest(".asset-block");
  const audioBlock = event.target.closest(".audio-block");
  const captionRow = event.target.closest(".caption-track-row");
  const inVideoTrack = Boolean(event.target.closest("#video-track"));
  const inAssetTrack = Boolean(event.target.closest("#asset-track"));
  const inAudioTrack = Boolean(event.target.closest("#audio-track"));
  if (!clipBlock && !cueBlock && !assetBlock && !audioBlock && !captionRow && !inVideoTrack && !inAssetTrack && !inAudioTrack) {
    return;
  }
  event.preventDefault();
  const timelineRect = elements.timeline_content.getBoundingClientRect();
  const rawTimelineMs = (event.clientX - timelineRect.left) / pixelsPerSecond * 1000;
  const timelineMs = Math.max(0, Math.min(projectDurationMs(project), Math.round(rawTimelineMs)));
  const laneValue = cueBlock?.dataset.lane ?? captionRow?.dataset.lane;
  timelineContext = {
    timelineMs,
    lane: laneValue === undefined ? null : Number(laneValue),
    cueId: cueBlock?.dataset.id || null,
    imageAssetId: assetBlock?.dataset.id || null,
    audioRegionId: audioBlock?.dataset.id || null,
    kind: clipBlock || inVideoTrack
      ? "video"
      : cueBlock || captionRow
      ? "caption"
      : assetBlock || inAssetTrack
        ? "asset"
        : "audio"
  };
  const videoContext = timelineContext.kind === "video";
  const captionContext = timelineContext.kind === "caption";
  const assetContext = timelineContext.kind === "asset";
  elements.context_set_range_start.hidden = !videoContext;
  elements.context_set_range_end.hidden = !videoContext;
  elements.context_delete_range.hidden = !videoContext || !selectedTimelineRange();
  elements.context_add_cue.hidden = !captionContext;
  elements.context_delete_cue.hidden = !timelineContext.cueId;
  elements.context_add_lane.hidden = !captionContext || project.subtitleLaneCount >= MAX_SUBTITLE_LANES;
  elements.context_paste_asset.hidden = !assetContext;
  elements.context_pick_asset.hidden = !assetContext;
  elements.context_delete_asset.hidden = !timelineContext.imageAssetId;
  elements.context_add_audio.hidden = timelineContext.kind !== "audio";
  elements.context_delete_audio.hidden = !timelineContext.audioRegionId;
  elements.timeline_context_menu.hidden = false;
  elements.timeline_context_menu.style.left = `${event.clientX}px`;
  elements.timeline_context_menu.style.top = `${event.clientY}px`;
  const menuRect = elements.timeline_context_menu.getBoundingClientRect();
  elements.timeline_context_menu.style.left = `${Math.max(
    8,
    Math.min(event.clientX, window.innerWidth - menuRect.width - 8)
  )}px`;
  elements.timeline_context_menu.style.top = `${Math.max(
    8,
    Math.min(event.clientY, window.innerHeight - menuRect.height - 8)
  )}px`;
  elements.timeline_context_menu.querySelector("button:not([hidden])")?.focus({ preventScroll: true });
}

function bindTimelineSeeking() {
  const seekFromEvent = (event) => {
    const rect = elements.timeline_content.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, event.clientX - rect.left));
    void seekTimeline(x / pixelsPerSecond * 1000);
  };
  elements.timeline_ruler.addEventListener("pointerdown", (event) => {
    seekFromEvent(event);
    elements.timeline_ruler.setPointerCapture(event.pointerId);
    const move = (moveEvent) => seekFromEvent(moveEvent);
    const finish = () => {
      elements.timeline_ruler.removeEventListener("pointermove", move);
      elements.timeline_ruler.removeEventListener("pointerup", finish);
      scheduleSave();
    };
    elements.timeline_ruler.addEventListener("pointermove", move);
    elements.timeline_ruler.addEventListener("pointerup", finish);
  });
  elements.playhead.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    elements.playhead.setPointerCapture(event.pointerId);
    const move = (moveEvent) => seekFromEvent(moveEvent);
    const finish = () => {
      elements.playhead.removeEventListener("pointermove", move);
      elements.playhead.removeEventListener("pointerup", finish);
      scheduleSave();
    };
    elements.playhead.addEventListener("pointermove", move);
    elements.playhead.addEventListener("pointerup", finish);
  });
  elements.playhead.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const delta = event.shiftKey ? 1_000 : 100;
    void seekTimeline(project.playheadMs + (event.key === "ArrowLeft" ? -delta : delta));
  });
}

function bindActions() {
  elements.project_name.addEventListener("input", () => {
    applyFieldProject({ ...project, name: elements.project_name.value }, "project-name");
  });
  elements.project_name.addEventListener("blur", () => endFieldEdit("project-name"));
  elements.undo.addEventListener("click", undo);
  elements.redo.addEventListener("click", redo);
  elements.create_local_draft.addEventListener("click", createManualLocalDraft);
  elements.open_local_drafts.addEventListener("click", () => {
    void openLocalDraftDialog();
  });
  elements.restore_local_draft.addEventListener("click", () => {
    void restoreSelectedLocalDraft();
  });
  elements.close_local_draft_dialog.addEventListener(
    "click",
    closeLocalDraftDialog
  );
  elements.local_draft_dialog.addEventListener("cancel", (event) => {
    if (localDraftOperationActive) {
      event.preventDefault();
    }
  });
  elements.local_draft_dialog.addEventListener("close", () => {
    elements.local_draft_dialog.hidden = true;
    if (focusBeforeLocalDraftDialog?.isConnected) {
      focusBeforeLocalDraftDialog.focus();
    }
    focusBeforeLocalDraftDialog = null;
  });
  elements.pick_media.addEventListener("click", () => void chooseMediaFile());
  elements.pick_media_empty.addEventListener("click", () => void chooseMediaFile());
  elements.media_input.addEventListener("change", () => {
    const [file] = elements.media_input.files;
    if (file) {
      mediaHandle = null;
      void attachMediaFile(file).then(async (attached) => {
        if (attached) {
          await deleteMediaHandle(project.id);
        }
      });
    }
    elements.media_input.value = "";
  });
  elements.asset_input.addEventListener("change", () => {
    const [file] = elements.asset_input.files;
    const timelineMs = pendingAssetTimelineMs ?? project.playheadMs;
    pendingAssetTimelineMs = null;
    elements.asset_input.value = "";
    if (file) {
      void addImageAssetFromBlob(file, {
        timelineMs,
        name: file.name || pastedImageName(file.type)
      });
    }
  });
  const pasteAtPlayhead = () => void pasteImageFromSystemClipboard(project.playheadMs);
  elements.asset_paste.addEventListener("click", pasteAtPlayhead);
  elements.paste_image_asset.addEventListener("click", pasteAtPlayhead);
  elements.asset_pick_file.addEventListener("click", () => openImageAssetFilePicker(project.playheadMs));
  document.addEventListener("paste", (event) => {
    const blob = imageBlobFromPasteEvent(event);
    if (!blob) {
      return;
    }
    event.preventDefault();
    void addImageAssetFromBlob(blob, {
      timelineMs: project.playheadMs,
      name: pastedImageName(blob.type)
    });
  });
  elements.export_video.addEventListener("click", () => void exportVideoWithLock());
  elements.apply_source_offset.addEventListener("click", () => {
    const seconds = Number(elements.source_offset.value);
    if (!Number.isFinite(seconds)) {
      showToast("정렬 오프셋을 초 단위 숫자로 입력해 주세요.", "error");
      return;
    }
    try {
      const next = applyMediaAlignmentOffset(project, Math.round(seconds * 1000));
      clearTimelineRangeSelection();
      applyProject(next);
      void syncPreviewToPlayhead();
      const overrun = mediaFile && clipOutsideMedia(next);
      showToast(
        overrun
          ? "오프셋을 적용했지만 일부 컷이 원본 길이 밖입니다."
          : "라이브와 로컬 VOD 정렬 오프셋을 적용했습니다.",
        overrun ? "error" : "success",
        overrun ? 7000 : 3600
      );
    } catch (error) {
      showToast(error.message, "error", 0);
      renderMediaCard();
    }
  });
  elements.focus_source.addEventListener("click", () => void focusSourceTab());
  elements.preview_source_tab.addEventListener("click", () => void focusSourceTab({ seek: true }));
  elements.set_range_start.addEventListener("click", () => {
    setTimelineRangeBoundary("start", project.playheadMs);
  });
  elements.set_range_end.addEventListener("click", () => {
    setTimelineRangeBoundary("end", project.playheadMs);
  });
  elements.clear_range.addEventListener("click", () => {
    clearTimelineRangeSelection();
  });
  elements.delete_range.addEventListener("click", deleteSelectedTimelineRange);
  for (const [handle, side] of [
    [elements.range_start_handle, "start"],
    [elements.range_end_handle, "end"]
  ]) {
    handle.title = "드래그 또는 ←/→ 0.1초 · Shift+←/→ 1초";
    handle.addEventListener("pointerdown", (event) => {
      bindTimelineRangeHandle(handle, side, event);
    });
    handle.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const deltaMs = event.shiftKey ? 1_000 : 100;
      nudgeTimelineRangeBoundary(
        side,
        event.key === "ArrowLeft" ? -deltaMs : deltaMs
      );
    });
  }

  elements.move_selected_clips_up.addEventListener("click", () => {
    moveSelectedClipGroup(-1, { focusControl: true });
  });
  elements.move_selected_clips_down.addEventListener("click", () => {
    moveSelectedClipGroup(1, { focusControl: true });
  });
  elements.clear_clip_group_selection.addEventListener("click", () => {
    clipGroupSelection.clear();
    renderClipGroupControls({ announcement: "컷 체크를 모두 해제함" });
  });
  elements.clip_list.addEventListener("change", (event) => {
    const checkbox = event.target.closest(".clip-group-checkbox");
    if (!checkbox || checkbox.disabled) {
      return;
    }
    if (checkbox.checked) {
      clipGroupSelection.add(checkbox.dataset.clipId);
    } else {
      clipGroupSelection.delete(checkbox.dataset.clipId);
    }
    renderClipGroupControls();
  });
  elements.clip_list.addEventListener("keydown", (event) => {
    if (
      !event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      (event.key !== "ArrowUp" && event.key !== "ArrowDown")
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const focusedClipId = event.target.closest(".clip-item")?.dataset.id || null;
    moveSelectedClipGroup(event.key === "ArrowUp" ? -1 : 1, {
      restoreCheckboxClipId: focusedClipId
    });
  });
  elements.clip_group_toolbar.addEventListener("keydown", (event) => {
    if (
      !event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      (event.key !== "ArrowUp" && event.key !== "ArrowDown")
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    moveSelectedClipGroup(event.key === "ArrowUp" ? -1 : 1, {
      focusControl: true
    });
  });
  elements.clip_list.addEventListener("click", (event) => {
    const item = event.target.closest(".clip-item");
    if (!item) {
      return;
    }
    if (event.target.closest(".clip-group-check")) {
      return;
    }
    const clip = project.clips.find((candidate) => candidate.id === item.dataset.id);
    if (!clip) {
      return;
    }
    const action = event.target.closest("[data-action]")?.dataset.action;
    if (action) {
      const index = project.clips.findIndex((candidate) => candidate.id === clip.id);
      clearTimelineRangeSelection({ render: false });
      applyProject(anchorPlayheadAfterClipReorder(
        reorderClip(project, clip.id, action === "up" ? index - 1 : index + 1)
      ));
      const nextItem = [...elements.clip_list.querySelectorAll(".clip-item")]
        .find((candidate) => candidate.dataset.id === clip.id);
      const nextAction = nextItem?.querySelector(`[data-action="${action}"]`);
      (nextAction && !nextAction.disabled ? nextAction : nextItem?.querySelector(".clip-select"))
        ?.focus({ preventScroll: true });
      void syncPreviewToPlayhead();
      return;
    }
    project.selectedClipId = clip.id;
    void seekTimeline(clip.timelineStartMs);
    renderAll({ keepScroll: true });
    const nextItem = [...elements.clip_list.querySelectorAll(".clip-item")]
      .find((candidate) => candidate.dataset.id === clip.id);
    nextItem?.querySelector(".clip-select")?.focus({ preventScroll: true });
    scheduleSave();
  });

  configurePreviewVideoLayer(elements.preview_video, { active: true });
  bindPreviewVideoEvents(elements.preview_video);
  ensureStandbyPreviewVideo();
  elements.play_toggle.addEventListener("click", () => void togglePlayback());
  elements.previous_clip.addEventListener("click", () => adjacentClip(-1));
  elements.next_clip.addEventListener("click", () => adjacentClip(1));
  elements.toggle_mute.addEventListener("click", () => {
    previewMuted = !previewMuted;
    applyPreviewAudioSettings();
    showToast(previewMuted ? "미리보기 음소거" : "미리보기 음소거 해제");
  });
  elements.volume.addEventListener("input", () => {
    previewVolume = Number(elements.volume.value);
    applyPreviewAudioSettings();
  });

  elements.caption_mode_tab.addEventListener("click", () => {
    propertyInspectorMode = "caption";
    renderPropertyInspector();
  });
  elements.asset_mode_tab.addEventListener("click", () => {
    propertyInspectorMode = "asset";
    renderPropertyInspector();
  });
  elements.audio_mode_tab.addEventListener("click", () => {
    propertyInspectorMode = "audio";
    renderPropertyInspector();
  });
  const propertyTabs = [
    elements.caption_mode_tab,
    elements.asset_mode_tab,
    elements.audio_mode_tab
  ];
  for (const [tabIndex, tab] of propertyTabs.entries()) {
    tab.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
        return;
      }
      event.preventDefault();
      const nextIndex = event.key === "Home"
        ? 0
        : event.key === "End"
          ? propertyTabs.length - 1
          : (tabIndex + (event.key === "ArrowLeft" ? -1 : 1) + propertyTabs.length) % propertyTabs.length;
      const next = propertyTabs[nextIndex];
      next.click();
      next.focus();
    });
  }

  elements.add_cue.addEventListener("click", () => addCueAtPlayhead());
  elements.add_cue_top.addEventListener("click", () => addCueAtPlayhead());
  elements.add_audio_region.addEventListener("click", () => addAudioRegionAtTimeline());
  elements.add_subtitle_lane.addEventListener("click", () => {
    const next = addSubtitleLane(project);
    if (next === project) {
      showToast(`자막 레인은 최대 ${MAX_SUBTITLE_LANES}개까지 만들 수 있습니다.`);
      return;
    }
    applyProject(next);
    showToast(`${next.subtitleLaneCount}번째 자막 레인을 추가했습니다.`, "success");
  });
  elements.cue_text.addEventListener("input", () => {
    const cue = selectedCue();
    if (cue) {
      applyFieldProject(
        updateSubtitleCue(project, cue.id, { text: elements.cue_text.value }),
        "cue-text"
      );
    }
  });
  elements.cue_text.addEventListener("blur", () => endFieldEdit("cue-text"));
  elements.cue_start.addEventListener("change", () => {
    const cue = selectedCue();
    const clip = project.clips.find((candidate) => candidate.id === cue?.clipId);
    const timelineMs = parseTime(elements.cue_start.value);
    if (!cue || !clip || timelineMs === null) {
      if (cue) {
        const range = cueTimelineRange(project, cue);
        elements.cue_start.value = formatTime(range.startMs, { compact: true });
      }
      showToast("자막 시작 시각 형식을 확인해 주세요.", "error");
      return;
    }
    updateSelectedCue({ startOffsetMs: timelineMs - clip.timelineStartMs });
    const updated = selectedCue();
    elements.cue_start.value = formatTime(cueTimelineRange(project, updated).startMs, { compact: true });
  });
  elements.cue_end.addEventListener("change", () => {
    const cue = selectedCue();
    const clip = project.clips.find((candidate) => candidate.id === cue?.clipId);
    const timelineMs = parseTime(elements.cue_end.value);
    if (!cue || !clip || timelineMs === null) {
      if (cue) {
        const range = cueTimelineRange(project, cue);
        elements.cue_end.value = formatTime(range.endMs, { compact: true });
      }
      showToast("자막 종료 시각 형식을 확인해 주세요.", "error");
      return;
    }
    updateSelectedCue({ endOffsetMs: timelineMs - clip.timelineStartMs });
    const updated = selectedCue();
    elements.cue_end.value = formatTime(cueTimelineRange(project, updated).endMs, { compact: true });
  });
  elements.cue_x.addEventListener("input", () => {
    const cue = selectedCue();
    if (cue) {
      applyFieldProject(
        updateSubtitleCue(project, cue.id, { x: Number(elements.cue_x.value) / 100 }),
        "cue-x"
      );
    }
  });
  elements.cue_y.addEventListener("input", () => {
    const cue = selectedCue();
    if (cue) {
      applyFieldProject(
        updateSubtitleCue(project, cue.id, { y: Number(elements.cue_y.value) / 100 }),
        "cue-y"
      );
    }
  });
  elements.cue_x.addEventListener("change", () => endFieldEdit("cue-x"));
  elements.cue_y.addEventListener("change", () => endFieldEdit("cue-y"));
  positionButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const y = button.dataset.position === "top" ? 0.18 : button.dataset.position === "center" ? 0.5 : 0.84;
      updateSelectedCue({ y });
    });
  });
  elements.font_size.addEventListener("input", () => {
    applyFieldProject({
      ...project,
      subtitleDefaults: {
        ...project.subtitleDefaults,
        fontScale: Number(elements.font_size.value) / 100
      }
    }, "font-size");
  });
  elements.font_color.addEventListener("input", () => {
    const cue = selectedCue();
    if (cue) {
      applyFieldProject(
        updateSubtitleCue(project, cue.id, { color: elements.font_color.value }),
        "font-color"
      );
    }
  });
  elements.font_size.addEventListener("change", () => endFieldEdit("font-size"));
  elements.font_color.addEventListener("change", () => endFieldEdit("font-color"));
  elements.reset_font_color.addEventListener("click", () => {
    const cue = selectedCue();
    if (cue) {
      updateSelectedCue({ color: project.subtitleDefaults.color || "#ffffff" });
    }
  });
  elements.delete_cue.addEventListener("click", () => {
    const cue = selectedCue();
    if (cue) {
      applyProject(deleteSubtitleCue(project, cue.id));
    }
  });
  elements.cue_list.addEventListener("click", (event) => {
    const item = event.target.closest(".cue-list-item");
    if (item) {
      selectCue(item.dataset.id, { seek: true });
      elements.cue_text.focus({ preventScroll: true });
    }
  });
  captionInspectorTab.addEventListener("click", () => {
    inspectorMode = "selected";
    renderCueInspector();
  });
  elements.cue_list_tab.addEventListener("click", () => {
    inspectorMode = "list";
    renderCueInspector();
  });
  for (const tab of [captionInspectorTab, elements.cue_list_tab]) {
    tab.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
        return;
      }
      event.preventDefault();
      const next = event.key === "ArrowLeft" || event.key === "Home"
        ? captionInspectorTab
        : elements.cue_list_tab;
      next.click();
      next.focus();
    });
  }

  const restoreAssetTimeFields = () => {
    const asset = selectedImageAsset();
    const range = asset ? imageAssetTimelineRange(project, asset) : null;
    if (!range) {
      renderImageAssetInspector();
      return;
    }
    elements.asset_start.value = formatTime(range.startMs, { compact: true });
    elements.asset_end.value = formatTime(range.endMs, { compact: true });
  };
  elements.asset_start.addEventListener("change", () => {
    const asset = selectedImageAsset();
    const clip = project.clips.find((candidate) => candidate.id === asset?.clipId);
    const timelineMs = parseTime(elements.asset_start.value);
    if (!asset || !clip || timelineMs === null) {
      restoreAssetTimeFields();
      showToast("에셋 시작 시각 형식을 확인해 주세요.", "error");
      return;
    }
    updateSelectedImageAsset({ startOffsetMs: timelineMs - clip.timelineStartMs });
    restoreAssetTimeFields();
  });
  elements.asset_end.addEventListener("change", () => {
    const asset = selectedImageAsset();
    const clip = project.clips.find((candidate) => candidate.id === asset?.clipId);
    const timelineMs = parseTime(elements.asset_end.value);
    if (!asset || !clip || timelineMs === null) {
      restoreAssetTimeFields();
      showToast("에셋 종료 시각 형식을 확인해 주세요.", "error");
      return;
    }
    updateSelectedImageAsset({ endOffsetMs: timelineMs - clip.timelineStartMs });
    restoreAssetTimeFields();
  });
  elements.asset_x.addEventListener("input", () => {
    updateSelectedImageAsset(
      { x: Number(elements.asset_x.value) / 100 },
      { fieldKey: "asset-x" }
    );
  });
  elements.asset_y.addEventListener("input", () => {
    updateSelectedImageAsset(
      { y: Number(elements.asset_y.value) / 100 },
      { fieldKey: "asset-y" }
    );
  });
  elements.asset_scale.addEventListener("input", () => {
    updateSelectedImageAsset(
      { scale: Number(elements.asset_scale.value) / 100 },
      { fieldKey: "asset-scale" }
    );
  });
  elements.asset_opacity.addEventListener("input", () => {
    updateSelectedImageAsset(
      { opacity: Number(elements.asset_opacity.value) / 100 },
      { fieldKey: "asset-opacity" }
    );
  });
  elements.asset_x.addEventListener("change", () => endFieldEdit("asset-x"));
  elements.asset_y.addEventListener("change", () => endFieldEdit("asset-y"));
  elements.asset_scale.addEventListener("change", () => endFieldEdit("asset-scale"));
  elements.asset_opacity.addEventListener("change", () => endFieldEdit("asset-opacity"));
  elements.delete_asset.addEventListener("click", () => deleteSelectedImageAsset());

  const restoreAudioTimeFields = () => {
    const region = selectedAudioRegion();
    const range = region ? audioRegionTimelineRange(project, region) : null;
    if (!range) {
      renderAudioInspector();
      return;
    }
    elements.audio_start.value = formatTime(range.startMs, { compact: true });
    elements.audio_end.value = formatTime(range.endMs, { compact: true });
  };
  elements.audio_start.addEventListener("change", () => {
    const region = selectedAudioRegion();
    const clip = project.clips.find((candidate) => candidate.id === region?.clipId);
    const timelineMs = parseTime(elements.audio_start.value);
    if (!region || !clip || timelineMs === null) {
      restoreAudioTimeFields();
      showToast("음성 구간 시작 시각 형식을 확인해 주세요.", "error");
      return;
    }
    updateSelectedAudioRegion({ startOffsetMs: timelineMs - clip.timelineStartMs });
    restoreAudioTimeFields();
  });
  elements.audio_end.addEventListener("change", () => {
    const region = selectedAudioRegion();
    const clip = project.clips.find((candidate) => candidate.id === region?.clipId);
    const timelineMs = parseTime(elements.audio_end.value);
    if (!region || !clip || timelineMs === null) {
      restoreAudioTimeFields();
      showToast("음성 구간 종료 시각 형식을 확인해 주세요.", "error");
      return;
    }
    updateSelectedAudioRegion({ endOffsetMs: timelineMs - clip.timelineStartMs });
    restoreAudioTimeFields();
  });
  elements.audio_volume.addEventListener("input", () => {
    const region = selectedAudioRegion();
    if (!region) {
      return;
    }
    applyFieldProject(
      updateAudioRegion(project, region.id, { gain: Number(elements.audio_volume.value) / 100 }),
      "audio-volume"
    );
    applyPreviewAudioSettings();
  });
  elements.audio_volume.addEventListener("change", () => endFieldEdit("audio-volume"));
  elements.audio_mute.addEventListener("click", () => {
    const region = selectedAudioRegion();
    if (region) {
      updateSelectedAudioRegion({ muted: !region.muted });
    }
  });
  elements.audio_fade_in.addEventListener("input", () => {
    const region = selectedAudioRegion();
    if (!region) {
      return;
    }
    applyFieldProject(
      updateAudioRegion(project, region.id, { fadeInMs: Number(elements.audio_fade_in.value) }),
      "audio-fade-in"
    );
    applyPreviewAudioSettings();
  });
  elements.audio_fade_out.addEventListener("input", () => {
    const region = selectedAudioRegion();
    if (!region) {
      return;
    }
    applyFieldProject(
      updateAudioRegion(project, region.id, { fadeOutMs: Number(elements.audio_fade_out.value) }),
      "audio-fade-out"
    );
    applyPreviewAudioSettings();
  });
  elements.audio_fade_in.addEventListener("change", () => endFieldEdit("audio-fade-in"));
  elements.audio_fade_out.addEventListener("change", () => endFieldEdit("audio-fade-out"));
  elements.reset_audio_region.addEventListener("click", () => {
    updateSelectedAudioRegion({ gain: 1, muted: false, fadeInMs: 0, fadeOutMs: 0 });
  });
  elements.delete_audio_region.addEventListener("click", () => {
    const region = selectedAudioRegion();
    if (region) {
      applyProject(deleteAudioRegion(project, region.id));
    }
  });

  elements.generate_captions.addEventListener("click", () => void generateCaptions());
  elements.test_caption_agent.addEventListener("click", () => void testCaptionAgentConnection());
  elements.caption_style_preset.addEventListener("change", () => {
    const preset = captionStylePreset(elements.caption_style_preset.value);
    applyProject(applyCaptionStylePreset(project, preset.id));
    if (document.fonts?.load) {
      void document.fonts
        .load(
          `${preset.typography.fontWeight} 48px "${preset.typography.fontFamily}"`
        )
        .then(renderSubtitleOverlay)
        .catch((error) => {
          showToast(`자막 폰트를 준비하지 못했습니다: ${error.message}`, "error", 0);
        });
    }
    showToast(`${preset.displayName} 스타일을 적용했습니다.`, "success", 3600);
  });
  elements.caption_model.addEventListener("change", () => {
    applyProject({
      ...project,
      ai: {
        ...project.ai,
        provider: "caption-agent",
        model: elements.caption_model.value
      }
    });
    void saveCaptionAgentSettings({
      endpoint: elements.caption_agent_endpoint.value,
      model: elements.caption_model.value,
      sttEndpoint: elements.caption_stt_endpoint.value,
      sttModel: elements.caption_stt_model.value
    }).catch((error) => {
      showToast(`자막 에이전트 설정 저장 실패: ${error.message}`, "error", 0);
    });
  });
  elements.caption_agent_endpoint.addEventListener("change", () => {
    try {
      elements.caption_agent_endpoint.value = normalizeCaptionAgentEndpoint(
        elements.caption_agent_endpoint.value
      );
    } catch (error) {
      showToast(error.message, "error", 0);
      elements.caption_agent_endpoint.value = captionAgentSettings.endpoint;
      return;
    }
    void saveCaptionAgentSettings({
      endpoint: elements.caption_agent_endpoint.value,
      model: elements.caption_model.value,
      sttEndpoint: elements.caption_stt_endpoint.value,
      sttModel: elements.caption_stt_model.value
    }).then((settings) => {
      captionAgentSettings = settings;
    }).catch((error) => {
      showToast(`자막 에이전트 설정 저장 실패: ${error.message}`, "error", 0);
    });
  });
  const persistProviderSettings = () => {
    void saveCaptionAgentSettings({
      endpoint: elements.caption_agent_endpoint.value,
      model: elements.caption_model.value,
      sttEndpoint: elements.caption_stt_endpoint.value,
      sttModel: elements.caption_stt_model.value
    }).then((settings) => {
      captionAgentSettings = settings;
      elements.caption_stt_endpoint.value = settings.sttEndpoint;
      elements.caption_stt_model.value = settings.sttModel;
    }).catch((error) => {
      showToast(`STT 설정 저장 실패: ${error.message}`, "error", 0);
      elements.caption_stt_endpoint.value = captionAgentSettings.sttEndpoint;
      elements.caption_stt_model.value = captionAgentSettings.sttModel;
    });
  };
  elements.caption_stt_endpoint.addEventListener("change", persistProviderSettings);
  elements.caption_stt_model.addEventListener("change", persistProviderSettings);
  elements.clear_caption_provider_keys.addEventListener("click", () => {
    elements.caption_stt_api_key.value = "";
    elements.caption_upstage_api_key.value = "";
    showToast("현재 편집기 탭에 입력한 API 키를 지웠습니다.", "success");
  });
  elements.cancel_job.addEventListener("click", cancelActiveJob);
  elements.job_dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    if (activeJobController && activeJobCancelable) {
      cancelActiveJob();
    }
  });
  elements.job_dialog.addEventListener("keydown", (event) => {
    if (event.key !== "Tab") {
      return;
    }
    event.preventDefault();
    const target = elements.cancel_job.hidden
      ? elements.job_dialog.querySelector(".job-card")
      : elements.cancel_job;
    target.focus();
  });
  elements.timeline_zoom.addEventListener("input", () => {
    pixelsPerSecond = Number(elements.timeline_zoom.value);
    renderTimeline();
  });
  elements.fit_timeline.addEventListener("click", () => {
    const durationSeconds = Math.max(1, projectDurationMs(project) / 1000);
    pixelsPerSecond = Math.max(20, Math.min(240, (elements.timeline_scroll.clientWidth - 20) / durationSeconds));
    elements.timeline_zoom.value = String(Math.round(pixelsPerSecond));
    renderTimeline();
  });

  elements.video_track.addEventListener("contextmenu", openTimelineContextMenu);
  elements.caption_tracks.addEventListener("contextmenu", openTimelineContextMenu);
  elements.asset_track.addEventListener("contextmenu", openTimelineContextMenu);
  elements.audio_track.addEventListener("contextmenu", openTimelineContextMenu);
  elements.context_set_range_start.addEventListener("click", () => {
    const context = timelineContext;
    closeTimelineContextMenu();
    if (context) {
      setTimelineRangeBoundary("start", context.timelineMs);
    }
  });
  elements.context_set_range_end.addEventListener("click", () => {
    const context = timelineContext;
    closeTimelineContextMenu();
    if (context) {
      setTimelineRangeBoundary("end", context.timelineMs);
    }
  });
  elements.context_delete_range.addEventListener("click", () => {
    closeTimelineContextMenu();
    deleteSelectedTimelineRange();
  });
  elements.context_add_cue.addEventListener("click", () => {
    const context = timelineContext;
    closeTimelineContextMenu();
    if (context) {
      addCueAtPlayhead({ timelineMs: context.timelineMs, lane: context.lane });
    }
  });
  elements.context_paste_asset.addEventListener("click", () => {
    const context = timelineContext;
    closeTimelineContextMenu();
    if (context) {
      void pasteImageFromSystemClipboard(context.timelineMs);
    }
  });
  elements.context_pick_asset.addEventListener("click", () => {
    const context = timelineContext;
    closeTimelineContextMenu();
    if (context) {
      openImageAssetFilePicker(context.timelineMs);
    }
  });
  elements.context_add_audio.addEventListener("click", () => {
    const context = timelineContext;
    closeTimelineContextMenu();
    if (context) {
      addAudioRegionAtTimeline(context.timelineMs);
    }
  });
  elements.context_delete_cue.addEventListener("click", () => {
    const context = timelineContext;
    closeTimelineContextMenu();
    if (context?.cueId) {
      applyProject(deleteSubtitleCue(project, context.cueId));
    }
  });
  elements.context_delete_asset.addEventListener("click", () => {
    const context = timelineContext;
    closeTimelineContextMenu();
    if (context?.imageAssetId) {
      deleteSelectedImageAsset(context.imageAssetId);
    }
  });
  elements.context_delete_audio.addEventListener("click", () => {
    const context = timelineContext;
    closeTimelineContextMenu();
    if (context?.audioRegionId) {
      applyProject(deleteAudioRegion(project, context.audioRegionId));
    }
  });
  elements.context_add_lane.addEventListener("click", () => {
    closeTimelineContextMenu();
    const next = addSubtitleLane(project);
    if (next !== project) {
      applyProject(next);
    }
  });
  document.addEventListener("pointerdown", (event) => {
    if (!elements.timeline_context_menu.hidden && !event.target.closest("#timeline-context-menu")) {
      closeTimelineContextMenu();
    }
  });
  elements.timeline_scroll.addEventListener("scroll", closeTimelineContextMenu, { passive: true });
  window.addEventListener("blur", closeTimelineContextMenu);

  bindOverlayDrag();
  bindImageAssetOverlayDrag();
  bindTimelineSeeking();
  window.addEventListener("resize", () => {
    renderTimeline({ keepScroll: true });
    void renderImageAssetOverlays();
    renderSubtitleOverlay();
  });
  window.addEventListener("keydown", (event) => {
    const editingText = event.target.matches("input, textarea, select, [contenteditable='true']");
    const interactive = Boolean(event.target.closest(
      "button, a, input, textarea, select, [contenteditable='true'], [role='slider'], [role='tab']"
    ));
    if (elements.local_draft_dialog.open) {
      if (event.key === "Escape" && !localDraftOperationActive) {
        event.preventDefault();
        closeLocalDraftDialog();
      }
      return;
    }
    if (event.key === "Escape" && !elements.timeline_context_menu.hidden) {
      event.preventDefault();
      closeTimelineContextMenu();
      return;
    }
    if (!elements.job_dialog.hidden) {
      if (event.key === "Escape") {
        event.preventDefault();
        if (activeJobController) {
          cancelActiveJob();
        }
      }
      return;
    }
    if (!editingText && event.key === "Escape" && (Number.isFinite(rangeStartMs) || Number.isFinite(rangeEndMs))) {
      event.preventDefault();
      clearTimelineRangeSelection();
      return;
    }
    if (!editingText && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
      event.preventDefault();
      event.shiftKey ? redo() : undo();
    } else if (!editingText && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") {
      event.preventDefault();
      redo();
    } else if (!interactive && event.code === "Space") {
      event.preventDefault();
      void togglePlayback();
    } else if (!editingText && !event.ctrlKey && !event.metaKey && !event.altKey && (event.code === "KeyI" || event.key.toLowerCase() === "i")) {
      event.preventDefault();
      setTimelineRangeBoundary("start", project.playheadMs);
    } else if (!editingText && !event.ctrlKey && !event.metaKey && !event.altKey && (event.code === "KeyO" || event.key.toLowerCase() === "o")) {
      event.preventDefault();
      setTimelineRangeBoundary("end", project.playheadMs);
    } else if (!editingText && (event.key === "Delete" || event.key === "Backspace") && selectedTimelineRange()) {
      event.preventDefault();
      deleteSelectedTimelineRange();
    } else if (!interactive && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      event.preventDefault();
      const delta = event.shiftKey ? 1_000 : 100;
      void seekTimeline(project.playheadMs + (event.key === "ArrowLeft" ? -delta : delta));
    }
  });
}

async function loadSeed() {
  const params = new URLSearchParams(location.search);
  const requestedProjectId = params.get("project");
  if (requestedProjectId) {
    const key = `${EDITOR_SEED_PREFIX}${requestedProjectId}`;
    const stored = await chrome.storage.local.get(key);
    if (stored[key]?.captureState) {
      return {
        projectId: requestedProjectId,
        captureState: stored[key].captureState
      };
    }
  }
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const captureState = stored[STORAGE_KEY] || {};
  return {
    projectId: requestedProjectId || captureProjectId(captureState),
    captureState
  };
}

async function restoreMedia() {
  if (project.mediaAsset?.fileHandleStored === false) {
    showToast("이 원본의 파일 권한은 저장되지 않았습니다. ‘원본 연결’에서 파일을 다시 선택해 주세요.");
    return;
  }
  const restored = await getFileFromStoredHandle(project.id);
  if (restored?.file) {
    mediaHandle = restored.handle;
    await attachMediaFile(restored.file, { fileHandleStored: true });
  } else if (restored?.handle && restored.permission !== "granted") {
    showToast("저장된 원본 파일을 다시 쓰려면 ‘원본 연결’을 눌러 권한을 확인해 주세요.");
  } else if (restored?.error) {
    showToast("저장된 원본 파일 연결이 만료되었습니다. ‘원본 연결’에서 다시 선택해 주세요.", "error");
  }
}

async function initializeSourceBinding() {
  try {
    const response = await chrome.runtime.sendMessage({
      type: "KIRINUKI_EDITOR_READY",
      projectId: project.id
    });
    sourceBindingConnected = Boolean(response?.ok && response?.connected);
  } catch {
    sourceBindingConnected = false;
  }
}

async function initialize() {
  bindActions();
  try {
    captionAgentSettings = await loadCaptionAgentSettings();
  } catch (error) {
    console.warn("자막 에이전트 설정을 불러오지 못했습니다.", error);
    captionAgentSettings = { ...DEFAULT_CAPTION_AGENT_SETTINGS };
  }
  elements.caption_agent_endpoint.value = captionAgentSettings.endpoint;
  elements.caption_model.value = captionAgentSettings.model;
  elements.caption_stt_endpoint.value = captionAgentSettings.sttEndpoint;
  elements.caption_stt_model.value = captionAgentSettings.sttModel;
  if (isLoopbackCaptionAgentEndpoint(captionAgentSettings.endpoint)) {
    void ensureCaptionAgentPermission(captionAgentSettings.endpoint)
      .then((granted) => {
        if (!granted) {
          throw new Error("로컬 companion 접근 권한이 없습니다.");
        }
        return ensureLocalCaptionSession(readCaptionAgentConfig());
      })
      .catch(() => {
        setCaptionLocalStatus(
          "로컬 자막 엔진이 꺼져 있습니다 · 세부설정의 실행 안내를 확인하세요",
          "offline"
        );
      });
  }
  const { projectId, captureState } = await loadSeed();
  const storedProject = normalizeEditorProject(await loadProject(projectId));
  let seedMergeError = null;
  if (storedProject) {
    try {
      project = mergeCaptureIntoEditorProject(storedProject, captureState);
    } catch (error) {
      project = storedProject;
      seedMergeError = error;
    }
  } else {
    project = createEditorProjectFromCapture(captureState, { id: projectId });
  }
  if (!project.selectedClipId && project.clips[0]) {
    project.selectedClipId = project.clips[0].id;
  }
  await saveProject(project);
  scheduleImageAssetBlobPrune();
  await initializeSourceBinding();
  renderAll();
  if (document.fonts?.load) {
    const family = String(
      project.subtitleDefaults?.fontFamily || "Pretendard"
    ).replace(/["\\]/gu, "");
    const weight = Math.round(
      Number(project.subtitleDefaults?.fontWeight) || 800
    );
    void document.fonts
      .load(`${weight} 48px "${family}"`)
      .then(renderSubtitleOverlay)
      .catch((error) => {
        console.warn("자막 폰트를 미리 불러오지 못했습니다.", error);
      });
  }
  if (seedMergeError) {
    showToast(`최신 선택 구간을 반영하지 못했습니다: ${seedMergeError.message}`, "error", 0);
  }
  await restoreMedia();
  if (findSubtitleOverlaps(project).length > 0) {
    showToast(
      "이 프로젝트에는 같은 레인 안에서 겹치는 자막이 있습니다. 자막 시각을 조정해 주세요.",
      "error",
      0
    );
  }
  if (findAudioRegionOverlaps(project).length > 0) {
    showToast(
      "이 프로젝트에는 서로 겹치는 음성 설정 구간이 있습니다. 구간 시각을 조정해 주세요.",
      "error",
      0
    );
  }
  try {
    const drafts = await listLocalDrafts(project.id, { limit: 5 });
    lastAutomaticDraftAtMs = Number(
      drafts.find((draft) => draft.reason === "auto")?.createdAtMs
    ) || 0;
    updateLocalDraftStatus(drafts);
  } catch (error) {
    console.warn("로컬 임시저장 목록을 준비하지 못했습니다.", error);
    elements.local_draft_status.textContent = "임시저장 목록 확인 실패";
  }
  startLocalDraftAutosave();
}

function applyCaptureSeedUpdate(captureState) {
  try {
    const next = mergeCaptureIntoEditorProject(project, captureState);
    clearTimelineRangeSelection({ render: false });
    applyProject(next);
    sourceBindingConnected = true;
    void syncPreviewToPlayhead();
    const overrun = mediaFile && clipOutsideMedia(next);
    showToast(
      overrun
        ? "최신 선택 구간을 반영했지만 일부 컷이 현재 원본 길이 밖입니다. 정렬값을 확인해 주세요."
        : "사이드패널의 최신 선택 구간을 반영했습니다.",
      overrun ? "error" : "success",
      overrun ? 7000 : 3600
    );
  } catch (error) {
    showToast(`최신 선택 구간을 반영하지 못했습니다: ${error.message}`, "error", 0);
  }
}

function flushPendingCaptureSeed() {
  if (projectMutationLockCount > 0 || !pendingCaptureSeed) {
    return;
  }
  const captureState = pendingCaptureSeed;
  pendingCaptureSeed = null;
  applyCaptureSeedUpdate(captureState);
}

function normalizeLocalCaptionFirstPass(detail) {
  const runId = String(detail?.runId || "").trim();
  if (!runId || runId.length > 160) {
    throw new TypeError("로컬 자막 초벌 실행 ID가 올바르지 않습니다.");
  }
  if (!Array.isArray(detail?.cues) || detail.cues.length === 0) {
    throw new TypeError("추가할 로컬 자막 초벌이 없습니다.");
  }
  if (detail.cues.length > MAX_CAPTION_AGENT_CUES_PER_RUN) {
    throw new TypeError(
      `한 번에 추가할 수 있는 로컬 자막은 최대 ${MAX_CAPTION_AGENT_CUES_PER_RUN.toLocaleString("ko-KR")}개입니다.`
    );
  }
  const clipsById = new Map(project.clips.map((clip) => [clip.id, clip]));
  const cues = detail.cues.map((rawCue, index) => {
    const clipId = String(rawCue?.clipId || "");
    const clip = clipsById.get(clipId);
    if (!clip) {
      throw new TypeError(`${index + 1}번 로컬 자막의 컷을 찾을 수 없습니다.`);
    }
    const startOffsetMs = Math.round(Number(rawCue.startOffsetMs));
    const endOffsetMs = Math.round(Number(rawCue.endOffsetMs));
    const durationMs = clipDurationMs(clip);
    if (
      !Number.isFinite(startOffsetMs)
      || !Number.isFinite(endOffsetMs)
      || startOffsetMs < 0
      || endOffsetMs > durationMs
      || endOffsetMs - startOffsetMs < MIN_TIMELINE_RANGE_MS
      || endOffsetMs - startOffsetMs > 5_000
    ) {
      throw new TypeError(
        `${index + 1}번 로컬 자막은 컷 안의 0.1~5초 구간이어야 합니다.`
      );
    }
    const text = String(rawCue.text || "")
      .replace(/\s+/gu, " ")
      .trim()
      .replace(/[.。]+$/u, "")
      .trim();
    if (!text || text.length > 500) {
      throw new TypeError(`${index + 1}번 로컬 자막 텍스트가 비었거나 너무 깁니다.`);
    }
    const placement = String(rawCue.remoteMeta?.placement || "bottom").toLowerCase();
    return {
      ...rawCue,
      id: String(rawCue.id || `cue-codex-${crypto.randomUUID()}`),
      clipId,
      startOffsetMs,
      endOffsetMs,
      text,
      origin: "ai",
      humanEdited: false,
      remoteMeta: {
        speakerId: String(
          rawCue.remoteMeta?.speakerId || "codex-local-first-pass"
        ).slice(0, 80),
        reviewRequired: rawCue.remoteMeta?.reviewRequired !== false,
        placement: ["top", "center", "bottom"].includes(placement)
          ? placement
          : "bottom"
      }
    };
  });
  return {
    runId,
    model: String(detail?.model || "Codex local first pass").slice(0, 120),
    cues
  };
}

async function applyLocalCaptionFirstPass(detail) {
  if (!project?.id || detail?.projectId !== project.id) {
    throw new TypeError("현재 프로젝트에 적용할 로컬 자막 초벌이 아닙니다.");
  }
  if (projectMutationLockCount > 0 || pointerEditActive || rangeHandleDragActive) {
    throw new Error("진행 중인 편집 동작이 끝난 뒤 로컬 자막 초벌을 적용해 주세요.");
  }
  const normalized = normalizeLocalCaptionFirstPass(detail);
  if (
    project.ai?.provider === "codex-local-first-pass"
    && project.ai?.lastRequestId === normalized.runId
  ) {
    return {
      ok: true,
      alreadyApplied: true,
      cueCount: project.subtitles.filter((cue) => (
        cue.remoteMeta?.speakerId === "codex-local-first-pass"
      )).length
    };
  }

  const before = cloneProject(project);
  const nextWithCues = appendAiSubtitleDrafts(project, normalized.cues);
  const next = {
    ...nextWithCues,
    ai: {
      ...nextWithCues.ai,
      provider: "codex-local-first-pass",
      model: normalized.model,
      resolvedModel: normalized.model,
      lastRequestId: normalized.runId,
      status: "done",
      progress: 1,
      lastRunAt: new Date().toISOString(),
      error: null
    }
  };
  const previousIds = new Set(before.subtitles.map((cue) => cue.id));
  const addedCount = next.subtitles.filter((cue) => !previousIds.has(cue.id)).length;
  if (addedCount === 0) {
    throw new Error("새로 추가할 로컬 자막 초벌이 없습니다.");
  }

  lockProjectMutations();
  try {
    await saveLocalDraft(next, {
      reason: "manual",
      now: Date.now(),
      id: crypto.randomUUID()
    });
    pushUndo(before);
    project = next;
    fieldEditSession = null;
    renderAll({ keepScroll: true });
    updateLocalDraftStatus(
      await listLocalDrafts(project.id, { limit: 5 })
    );
    showToast(
      `Codex 로컬 초벌 자막 ${addedCount}개를 기존 자막과 별도로 추가했습니다.`,
      "success",
      6500
    );
    return {
      ok: true,
      alreadyApplied: false,
      addedCount,
      totalSubtitleCount: project.subtitles.length,
      subtitleLaneCount: project.subtitleLaneCount
    };
  } finally {
    unlockProjectMutations();
  }
}

window.addEventListener("kirinuki:apply-local-caption-first-pass", (event) => {
  const detail = event.detail;
  const requestId = String(detail?.requestId || "");
  void queueLocalDraftOperation(() => applyLocalCaptionFirstPass(detail))
    .then((result) => {
      window.dispatchEvent(new CustomEvent(
        "kirinuki:local-caption-first-pass-result",
        { detail: { requestId, ...result } }
      ));
    })
    .catch((error) => {
      window.dispatchEvent(new CustomEvent(
        "kirinuki:local-caption-first-pass-result",
        { detail: { requestId, ok: false, error: error.message } }
      ));
      showToast(`Codex 로컬 자막 초벌을 적용하지 못했습니다: ${error.message}`, "error", 0);
    });
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "KIRINUKI_SOURCE_BINDING_STATUS" && message.projectId === project?.id) {
    sourceBindingConnected = Boolean(message.connected);
    renderHeader();
  } else if (
    message?.type === "KIRINUKI_CAPTURE_SEED_UPDATED" &&
    message.projectId === project?.id &&
    message.captureState
  ) {
    if (projectMutationLockCount > 0) {
      pendingCaptureSeed = message.captureState;
    } else {
      applyCaptureSeedUpdate(message.captureState);
    }
  }
});

window.addEventListener("beforeunload", () => {
  stopLocalDraftAutosave();
  stopPreviewPlaybackClock();
  stopPreviewAudioClock({ sync: false });
  cancelPreviewPreload({ clearSource: true });
  void flushSave();
  if (mediaUrl) {
    URL.revokeObjectURL(mediaUrl);
  }
  releaseAllImageAssetObjectUrls();
  cancelActiveJob();
});

window.addEventListener("pagehide", () => {
  stopLocalDraftAutosave();
  void flushSave();
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    void flushSave();
  } else if (localDraftAutosaveAnchorAtMs > 0) {
    const elapsed = Date.now() - localDraftAutosaveAnchorAtMs;
    if (elapsed >= LOCAL_DRAFT_AUTOSAVE_INTERVAL_MS) {
      clearTimeout(localDraftAutosaveTimer);
      localDraftAutosaveTimer = null;
      void runAutomaticLocalDraft();
    } else {
      scheduleLocalDraftAutosave(
        LOCAL_DRAFT_AUTOSAVE_INTERVAL_MS - elapsed
      );
    }
  }
});

window.addEventListener("pageshow", () => {
  if (project && !localDraftAutosaveTimer) {
    const elapsed = Math.max(
      0,
      Date.now() - localDraftAutosaveAnchorAtMs
    );
    scheduleLocalDraftAutosave(
      Math.max(0, LOCAL_DRAFT_AUTOSAVE_INTERVAL_MS - elapsed)
    );
  }
});

void initialize().catch((error) => {
  console.error(error);
  showToast(`편집기를 열지 못했습니다: ${error.message}`, "error", 0);
});
