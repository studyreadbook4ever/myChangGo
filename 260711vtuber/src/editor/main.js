import {
  EDITOR_SEED_PREFIX,
  MAX_SUBTITLE_LANES,
  addSubtitleLane,
  applyMediaAlignmentOffset,
  audioRegionAtTimeline,
  audioRegionTimelineRange,
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
  mapTimelineToSource,
  mergeCaptureIntoEditorProject,
  normalizeEditorProject,
  projectDurationMs,
  reorderClip,
  replaceAiSubtitleDraft,
  serializeSrt,
  transcriptChunksToCueDrafts,
  updateAudioRegion,
  updateClipTrim,
  updateImageAsset,
  updateSubtitleCue
} from "../../extension/lib/editor-core.js";
import { STORAGE_KEY } from "../../extension/lib/core.js";
import {
  extractClipPcm16k,
  getPreferredOutputProfile,
  inspectMediaFile,
  renderProjectVideo
} from "./media-engine.js";
import {
  deleteMediaHandle,
  getFileFromStoredHandle,
  loadImageAssetBlob,
  loadProject,
  pruneImageAssetBlobs,
  saveMediaHandle,
  saveProjectWithImageAssetBlob,
  saveProject
} from "./project-store.js";

const elements = Object.fromEntries([
  "project-name",
  "source-kind",
  "source-title",
  "source-link-state",
  "undo",
  "redo",
  "pick-media",
  "export-video",
  "clip-count",
  "media-card",
  "media-name",
  "media-meta",
  "source-offset",
  "apply-source-offset",
  "clip-list",
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
  "asr-model",
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
  "playhead",
  "timeline-context-menu",
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
let asrWorker = null;
let currentAsrJob = null;
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
let pendingAssetTimelineMs = null;
let imageAssetRenderSequence = 0;
const imageAssetObjectUrls = new Map();

const EXPORT_LOCK_NAME = "chzzk-kirinuki-export";
const MAX_IMAGE_ASSET_BYTES = 25 * 1024 * 1024;
const MAX_IMAGE_ASSET_DIMENSION = 8192;
const MAX_IMAGE_ASSET_PIXELS = 40_000_000;
const ASSET_TRACK_BASE_HEIGHT_PX = 54;
const ASSET_SUBROW_STRIDE_PX = 47;
const ASSET_BLOCK_TOP_PX = 7;
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
}

function unlockProjectMutations() {
  projectMutationLockCount = Math.max(0, projectMutationLockCount - 1);
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
  const sourceType = String(project.source?.contentType || "CHZZK").toUpperCase();
  elements.source_kind.textContent = sourceType === "UNKNOWN" ? "CHZZK" : sourceType;
  elements.source_title.textContent = [
    project.source?.streamerName,
    project.source?.broadcastTitle
  ].filter(Boolean).join(" · ") || "치지직 프로젝트";
  elements.source_link_state.classList.toggle("connected", sourceBindingConnected);
  elements.source_link_state.title = sourceBindingConnected
    ? "원래 치지직 탭과 연결됨"
    : "원래 치지직 탭을 찾지 못함";
  elements.undo.disabled = undoStack.length === 0;
  elements.redo.disabled = redoStack.length === 0;
  elements.export_video.disabled = !mediaFile || !project.clips.some((clip) => clip.enabled !== false);
  if (
    !activeJobController &&
    document.activeElement !== elements.asr_model &&
    [...elements.asr_model.options].some((option) => option.value === project.ai?.model)
  ) {
    elements.asr_model.value = project.ai.model;
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

function renderClipList() {
  elements.clip_count.textContent = String(project.clips.length);
  elements.clip_list.replaceChildren();
  project.clips.forEach((clip, index) => {
    const fragment = elements.clip_template.content.cloneNode(true);
    const item = fragment.querySelector(".clip-item");
    item.dataset.id = clip.id;
    item.classList.toggle("selected", project.selectedClipId === clip.id);
    fragment.querySelector(".clip-index").textContent = String(index + 1);
    fragment.querySelector(".clip-title").textContent = clip.note || `선택 구간 ${index + 1}`;
    fragment.querySelector(".clip-time").textContent = `${formatTime(clip.sourceStartMs)} → ${formatTime(clip.sourceEndMs)}`;
    fragment.querySelector(".clip-duration").textContent = formatDuration(clipDurationMs(clip));
    const up = fragment.querySelector("[data-action='up']");
    const down = fragment.querySelector("[data-action='down']");
    up.disabled = index === 0;
    down.disabled = index === project.clips.length - 1;
    elements.clip_list.append(fragment);
  });
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
  elements.font_size.value = String((project.subtitleDefaults.fontScale || 0.052) * 100);
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
  }
}

function endPointerHistory() {
  pointerEditActive = false;
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
    text.textContent = cue.text || " ";
    const indicator = document.createElement("i");
    indicator.className = "drag-indicator";
    indicator.setAttribute("aria-hidden", "true");
    overlay.append(text, indicator);
    overlay.style.left = `${contentRect.left + contentRect.width * cue.x}px`;
    overlay.style.top = `${contentRect.top + contentRect.height * cue.y}px`;
    overlay.style.maxWidth = `${contentRect.width * (project.subtitleDefaults.maxWidth || 0.86)}px`;
    const fontSize = Math.max(14, contentRect.height * (project.subtitleDefaults.fontScale || 0.052));
    overlay.style.fontSize = `${fontSize}px`;
    overlay.style.color = cue.color || project.subtitleDefaults.color || "#ffffff";
    overlay.style.background = "transparent";
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

function applyPreviewAudioSettings() {
  const video = elements.preview_video;
  if (!video || !project) {
    return;
  }
  const region = audioRegionAtTimeline(project, project.playheadMs);
  const targetGain = region?.muted ? 0 : (region?.gain ?? 1);
  let blend = region ? 1 : 0;
  if (region) {
    const range = audioRegionTimelineRange(project, region);
    const elapsedMs = Math.max(0, project.playheadMs - range.startMs);
    const remainingMs = Math.max(0, range.endMs - project.playheadMs);
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

function handleVideoTimeUpdate() {
  if (pendingPreviewSeek) {
    return;
  }
  const clip = project.clips.find((candidate) => candidate.id === activeClipId);
  if (!clip) {
    return;
  }
  const sourceMs = previewSecondsToSourceMs(elements.preview_video.currentTime);
  if (sourceMs >= clip.sourceEndMs - 35) {
    const enabled = project.clips.filter((candidate) => candidate.enabled !== false);
    const index = enabled.findIndex((candidate) => candidate.id === clip.id);
    const next = enabled[index + 1];
    if (next && !elements.preview_video.paused) {
      activeClipId = next.id;
      project.selectedClipId = next.id;
      project.playheadMs = next.timelineStartMs;
      updatePlayhead();
      void seekPreviewToSourceMs(next.sourceStartMs)
        .then(() => elements.preview_video.play())
        .catch((error) => console.warn("다음 컷 미리보기를 시작하지 못했습니다.", error));
      return;
    }
    project.playheadMs = clip.timelineStartMs + clipDurationMs(clip);
    elements.preview_video.pause();
    updatePlayhead();
    return;
  }
  project.playheadMs = Math.max(
    clip.timelineStartMs,
    Math.min(clip.timelineStartMs + clipDurationMs(clip), clip.timelineStartMs + sourceMs - clip.sourceStartMs)
  );
  updatePlayhead();
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
    const nextProject = {
      ...project,
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
      showToast("선택 구간 일부가 연결한 원본 길이 밖에 있습니다. 라이브↔VOD 정렬값을 확인해 주세요.", "error", 7000);
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
    } else if (!previousMediaUrl && !mediaUrl) {
      elements.preview_video.removeAttribute("src");
      elements.preview_video.load();
    }
    hideJob();
    showToast(error.message, "error", 0);
    return false;
  } finally {
    unlockProjectMutations();
  }
}

function ensureAsrWorker() {
  if (asrWorker) {
    return asrWorker;
  }
  asrWorker = new Worker(chrome.runtime.getURL("editor/asr-worker.js"), { type: "module" });
  const worker = asrWorker;
  worker.addEventListener("message", (event) => {
    const message = event.data || {};
    if (!currentAsrJob || message.jobId !== currentAsrJob.id) {
      return;
    }
    if (message.type === "progress") {
      currentAsrJob.onProgress(message);
    } else if (message.type === "result") {
      currentAsrJob.resolve(message);
      currentAsrJob = null;
    } else if (message.type === "error") {
      currentAsrJob.reject(new Error(message.error));
      currentAsrJob = null;
    }
  });
  const discardWorker = () => {
    if (asrWorker === worker) {
      asrWorker = null;
    }
    worker.terminate();
  };
  worker.addEventListener("error", (event) => {
    if (currentAsrJob) {
      currentAsrJob.reject(new Error(event.message || "AI 자막 worker가 중단되었습니다."));
      currentAsrJob = null;
    }
    discardWorker();
  });
  worker.addEventListener("messageerror", () => {
    if (currentAsrJob) {
      currentAsrJob.reject(new Error("AI 자막 worker 응답을 읽지 못했습니다."));
      currentAsrJob = null;
    }
    discardWorker();
  });
  return worker;
}

function transcribePcm(audio, model, onProgress) {
  if (currentAsrJob) {
    throw new Error("이미 음성인식 작업이 실행 중입니다.");
  }
  const worker = ensureAsrWorker();
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    currentAsrJob = { id, resolve, reject, onProgress };
    try {
      worker.postMessage({ type: "transcribe", jobId: id, model, audio }, [audio.buffer]);
    } catch (error) {
      currentAsrJob = null;
      if (asrWorker === worker) {
        asrWorker = null;
      }
      worker.terminate();
      reject(error);
    }
  });
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
  if (!project.clips.some((clip) => clip.enabled !== false)) {
    showToast("선택한 구간이 없습니다.", "error");
    return;
  }
  if (activeJobController || projectMutationLockCount > 0) {
    return;
  }
  const controller = new AbortController();
  activeJobController = controller;
  const model = elements.asr_model.value;
  const undoSnapshot = cloneProject(project);
  let undoRecorded = false;
  showJob(
    "AI 자막 초안을 만드는 중",
    "첫 실행은 선택한 Whisper 모델 데이터를 받은 뒤 브라우저에 캐시합니다.",
    0,
    { cancelable: true }
  );
  elements.generate_captions.disabled = true;
  project = {
    ...project,
    ai: {
      ...project.ai,
      model,
      status: "running",
      progress: 0,
      error: null
    }
  };
  renderHeader();

  lockProjectMutations();
  try {
    const clips = project.clips.filter((clip) => clip.enabled !== false);
    for (let index = 0; index < clips.length; index += 1) {
      const clip = clips[index];
      const base = index / clips.length;
      const span = 1 / clips.length;
      setAiProgress(base, `${index + 1}/${clips.length} · 선택 구간의 음성을 준비하는 중`);
      const pcm = await extractClipPcm16k(mediaFile, clip, {
        signal: controller.signal,
        onProgress: (value) => {
          setAiProgress(base + span * value * 0.18, `${index + 1}/${clips.length} · 음성 추출 중`);
        }
      });
      const result = await transcribePcm(pcm, model, (message) => {
        const local = 0.18 + (message.progress || 0) * 0.8;
        setAiProgress(base + span * local, `${index + 1}/${clips.length} · ${message.label}`);
      });
      const drafts = transcriptChunksToCueDrafts(
        result.chunks,
        clipDurationMs(clip)
      );
      if (drafts.length === 0 && result.text) {
        drafts.push({
          startOffsetMs: 0,
          endOffsetMs: Math.min(clipDurationMs(clip), 4_500),
          text: result.text
        });
      }
      if (!undoRecorded) {
        pushUndo(undoSnapshot);
        undoRecorded = true;
      }
      project = replaceAiSubtitleDraft(project, clip.id, drafts);
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
    showToast("AI 자막 초안을 만들었습니다. 텍스트·시간·위치를 검수해 주세요.", "success", 6500);
  } catch (error) {
    const canceled = error.name === "AbortError";
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
  if (currentAsrJob) {
    currentAsrJob.reject(new DOMException("작업이 취소되었습니다.", "AbortError"));
    currentAsrJob = null;
  }
  if (asrWorker) {
    asrWorker.terminate();
    asrWorker = null;
  }
}

function setJobCancelable(cancelable) {
  activeJobCancelable = Boolean(cancelable);
  elements.cancel_job.hidden = !activeJobCancelable;
  elements.cancel_job.disabled = !activeJobCancelable;
  if (!activeJobCancelable && document.activeElement === elements.cancel_job) {
    elements.job_dialog.querySelector(".job-card")?.focus();
  }
}

function showJob(title, message, progress = 0, { cancelable = true } = {}) {
  focusBeforeJob = document.activeElement;
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
        await document.fonts.load('800 48px "Pretendard"');
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
      throw new Error(response?.error || "원래 치지직 탭을 찾지 못했습니다.");
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
  const cueBlock = event.target.closest(".cue-block");
  const assetBlock = event.target.closest(".asset-block");
  const audioBlock = event.target.closest(".audio-block");
  const captionRow = event.target.closest(".caption-track-row");
  const inAssetTrack = Boolean(event.target.closest("#asset-track"));
  const inAudioTrack = Boolean(event.target.closest("#audio-track"));
  if (!cueBlock && !assetBlock && !audioBlock && !captionRow && !inAssetTrack && !inAudioTrack) {
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
    kind: cueBlock || captionRow
      ? "caption"
      : assetBlock || inAssetTrack
        ? "asset"
        : "audio"
  };
  const captionContext = timelineContext.kind === "caption";
  const assetContext = timelineContext.kind === "asset";
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

  elements.clip_list.addEventListener("click", (event) => {
    const item = event.target.closest(".clip-item");
    if (!item) {
      return;
    }
    const clip = project.clips.find((candidate) => candidate.id === item.dataset.id);
    if (!clip) {
      return;
    }
    const action = event.target.closest("[data-action]")?.dataset.action;
    if (action) {
      const index = project.clips.findIndex((candidate) => candidate.id === clip.id);
      applyProject(reorderClip(project, clip.id, action === "up" ? index - 1 : index + 1));
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

  elements.play_toggle.addEventListener("click", () => void togglePlayback());
  elements.previous_clip.addEventListener("click", () => adjacentClip(-1));
  elements.next_clip.addEventListener("click", () => adjacentClip(1));
  elements.preview_video.addEventListener("timeupdate", handleVideoTimeUpdate);
  elements.preview_video.addEventListener("play", () => elements.play_toggle.classList.add("playing"));
  elements.preview_video.addEventListener("pause", () => elements.play_toggle.classList.remove("playing"));
  elements.preview_video.addEventListener("loadedmetadata", () => {
    void renderImageAssetOverlays();
    renderSubtitleOverlay();
  });
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
  elements.asr_model.addEventListener("change", () => {
    applyProject({
      ...project,
      ai: {
        ...project.ai,
        model: elements.asr_model.value
      }
    });
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

  elements.caption_tracks.addEventListener("contextmenu", openTimelineContextMenu);
  elements.asset_track.addEventListener("contextmenu", openTimelineContextMenu);
  elements.audio_track.addEventListener("contextmenu", openTimelineContextMenu);
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
    if (!editingText && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
      event.preventDefault();
      event.shiftKey ? redo() : undo();
    } else if (!editingText && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") {
      event.preventDefault();
      redo();
    } else if (!interactive && event.code === "Space") {
      event.preventDefault();
      void togglePlayback();
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
    void document.fonts
      .load('800 48px "Pretendard"')
      .then(renderSubtitleOverlay)
      .catch((error) => {
        console.warn("Pretendard 폰트를 미리 불러오지 못했습니다.", error);
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
}

function applyCaptureSeedUpdate(captureState) {
  try {
    const next = mergeCaptureIntoEditorProject(project, captureState);
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
  void flushSave();
  if (mediaUrl) {
    URL.revokeObjectURL(mediaUrl);
  }
  releaseAllImageAssetObjectUrls();
  cancelActiveJob();
});

window.addEventListener("pagehide", () => {
  void flushSave();
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    void flushSave();
  }
});

void initialize().catch((error) => {
  console.error(error);
  showToast(`편집기를 열지 못했습니다: ${error.message}`, "error", 0);
});
