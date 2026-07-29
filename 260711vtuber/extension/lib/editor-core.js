import {
  CAPTION_STYLE_PRESETS,
  DEFAULT_CAPTION_STYLE_PRESET_ID,
  LEGACY_CAPTION_STYLE_PRESET_ID,
  captionStyleDefaults,
  normalizeCaptionStylePresetId
} from "./caption-style.js";

export const EDITOR_SCHEMA = "chzzk-kirinuki-editor/v3";
export const EDITOR_PROJECTS_STORE_KEY = "chzzkKirinukiEditorProjectsV1";
export const EDITOR_SEED_PREFIX = "chzzkKirinukiEditorSeed:";
export const EDITOR_DATABASE_NAME = "chzzk-kirinuki-studio";
export const MIN_SUBTITLE_LANES = 2;
export const MAX_SUBTITLE_LANES = 8;
export const MAX_AI_WARNINGS = 4_000;
export const MAX_AI_CAPTION_CHECKPOINTS = 500;
export const DEFAULT_SUBTITLE_COLOR = "#ffffff";
export const MAX_RECENT_SUBTITLE_COLORS = 5;
export const SUPPORTED_IMAGE_ASSET_MIME_TYPES = Object.freeze([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif"
]);

const MIN_CLIP_DURATION_MS = 100;
const MIN_CUE_DURATION_MS = 100;
const LEGACY_EDITOR_SCHEMA_V1 = "chzzk-kirinuki-editor/v1";
const LEGACY_EDITOR_SCHEMA_V2 = "chzzk-kirinuki-editor/v2";
const ACCEPTED_EDITOR_SCHEMAS = new Set([
  EDITOR_SCHEMA,
  LEGACY_EDITOR_SCHEMA_V1,
  LEGACY_EDITOR_SCHEMA_V2
]);
const AUTOMATIC_CAPTION_POSITION = Object.freeze({
  x: 0.5,
  y: 0.84,
  placement: "bottom"
});

const nowIso = () => new Date().toISOString();
const makeId = (prefix) => `${prefix}-${crypto.randomUUID()}`;

const finiteNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const secondsToMilliseconds = (seconds) => Math.max(0, Math.round(finiteNumber(seconds) * 1000));
export const millisecondsToSeconds = (milliseconds) => Math.max(0, finiteNumber(milliseconds) / 1000);
export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function normalizeAiWarning(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const code = String(value.code || "").trim().slice(0, 128);
  const cueIndex = Number(value.cueIndex);
  if (!code || !Number.isInteger(cueIndex) || cueIndex < 0) {
    return null;
  }
  const clipId = String(value.clipId || "").trim().slice(0, 256);
  return {
    ...(clipId ? { clipId } : {}),
    code,
    cueIndex
  };
}

export function normalizeAiWarnings(value) {
  const source = Array.isArray(value) ? value : [];
  const warnings = [];
  let truncated = source.length > MAX_AI_WARNINGS;
  for (
    let index = 0;
    index < Math.min(source.length, MAX_AI_WARNINGS + 1);
    index += 1
  ) {
    const warning = normalizeAiWarning(source[index]);
    if (!warning) {
      continue;
    }
    if (warnings.length >= MAX_AI_WARNINGS) {
      truncated = true;
      break;
    }
    warnings.push(warning);
  }
  if (truncated) {
    const marker = {
      code: "TRIMMED_WARNING_COUNT",
      cueIndex: 0
    };
    if (warnings.length >= MAX_AI_WARNINGS) {
      warnings[MAX_AI_WARNINGS - 1] = marker;
    } else {
      warnings.push(marker);
    }
  }
  return warnings;
}

export function mergeAiWarnings(existing, incoming, clipId) {
  const normalizedExisting = normalizeAiWarnings(existing);
  if (
    normalizedExisting.at(-1)?.code === "TRIMMED_WARNING_COUNT"
  ) {
    return normalizedExisting;
  }
  const boundedIncoming = (Array.isArray(incoming) ? incoming : [])
    .slice(0, MAX_AI_WARNINGS + 1)
    .map((warning) => ({
      ...warning,
      clipId: String(clipId || warning?.clipId || "")
    }));
  return normalizeAiWarnings([
    ...normalizedExisting,
    ...boundedIncoming
  ]);
}

export function normalizeAiCaptionCheckpoints(value, clips = []) {
  const clipIds = new Set(
    (Array.isArray(clips) ? clips : [])
      .map((clip) => String(clip?.id || ""))
      .filter(Boolean)
  );
  const byKey = new Map();
  for (const raw of (Array.isArray(value) ? value : []).slice(
    -MAX_AI_CAPTION_CHECKPOINTS
  )) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      continue;
    }
    const clipId = String(raw.clipId || "").trim().slice(0, 256);
    const sourceStartMs = Math.round(finiteNumber(raw.sourceStartMs, -1));
    const sourceEndMs = Math.round(finiteNumber(raw.sourceEndMs, -1));
    const model = String(raw.model || "").trim();
    const qualityProfile = String(
      raw.qualityProfile || "legacy-unharnessed-v0"
    ).trim().slice(0, 128);
    const harnessFingerprint = String(
      raw.harnessFingerprint || "legacy-harness-fingerprint-v0"
    ).trim().slice(0, 128);
    const editorialContextFingerprint = String(
      raw.editorialContextFingerprint || "legacy-context-v0"
    ).trim().slice(0, 128);
    const pipelineFingerprint = String(
      raw.pipelineFingerprint || "legacy-caption-pipeline-v0"
    ).trim().slice(0, 128);
    if (
      !clipId
      || !clipIds.has(clipId)
      || sourceStartMs < 0
      || sourceEndMs <= sourceStartMs
      || !["whisper-tiny", "solar-pro3", "solar-mini"].includes(model)
    ) {
      continue;
    }
    const requestId = String(raw.requestId || "").trim().slice(0, 128);
    const completedAt = String(raw.completedAt || "").trim().slice(0, 64);
    const checkpoint = {
      clipId,
      sourceStartMs,
      sourceEndMs,
      model,
      qualityProfile,
      harnessFingerprint,
      editorialContextFingerprint,
      pipelineFingerprint,
      ...(requestId ? { requestId } : {}),
      ...(completedAt ? { completedAt } : {})
    };
    byKey.set(
      [
        clipId,
        sourceStartMs,
        sourceEndMs,
        model,
        qualityProfile,
        harnessFingerprint,
        editorialContextFingerprint,
        pipelineFingerprint
      ].join("\u0000"),
      checkpoint
    );
  }
  return [...byKey.values()].slice(-MAX_AI_CAPTION_CHECKPOINTS);
}

export function normalizeHexColor(value, fallback = "#ffffff") {
  const candidate = String(value || "").trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/u.test(candidate)) {
    return candidate;
  }
  if (/^#[0-9a-f]{3}$/u.test(candidate)) {
    return `#${[...candidate.slice(1)].map((character) => character.repeat(2)).join("")}`;
  }
  return fallback;
}

export function normalizeRecentSubtitleColors(value) {
  const normalized = [];
  for (const rawColor of Array.isArray(value) ? value : []) {
    const color = normalizeHexColor(rawColor, "");
    if (
      !color
      || color === DEFAULT_SUBTITLE_COLOR
      || normalized.includes(color)
    ) {
      continue;
    }
    normalized.push(color);
    if (normalized.length >= MAX_RECENT_SUBTITLE_COLORS) {
      break;
    }
  }
  return normalized;
}

export function rememberSubtitleColor(project, rawColor) {
  if (!project || typeof project !== "object") {
    return project;
  }
  const color = normalizeHexColor(rawColor, "");
  const current = normalizeRecentSubtitleColors(project.recentSubtitleColors);
  if (!color || color === DEFAULT_SUBTITLE_COLOR) {
    return Array.isArray(project.recentSubtitleColors)
      && project.recentSubtitleColors.length === current.length
      && project.recentSubtitleColors.every((entry, index) => entry === current[index])
      ? project
      : { ...project, recentSubtitleColors: current };
  }
  const next = [
    color,
    ...current.filter((candidate) => candidate !== color)
  ].slice(0, MAX_RECENT_SUBTITLE_COLORS);
  if (
    Array.isArray(project.recentSubtitleColors)
    && project.recentSubtitleColors.length === next.length
    && project.recentSubtitleColors.every((entry, index) => entry === next[index])
  ) {
    return project;
  }
  return {
    ...project,
    recentSubtitleColors: next,
    updatedAt: nowIso()
  };
}

export function normalizeAiSpeakerColors(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const assignments = {};
  for (const [rawSpeakerId, rawColor] of Object.entries(value).slice(0, 64)) {
    const speakerId = String(rawSpeakerId || "")
      .trim()
      .toLowerCase()
      .slice(0, 80);
    const color = String(rawColor || "").trim().toLowerCase();
    if (!speakerId || !/^#[0-9a-f]{6}$/u.test(color)) {
      continue;
    }
    assignments[speakerId] = color;
  }
  return assignments;
}

function normalizeImageMimeType(value) {
  const candidate = String(value || "").trim().toLowerCase();
  const normalized = candidate === "image/jpg" ? "image/jpeg" : candidate;
  return SUPPORTED_IMAGE_ASSET_MIME_TYPES.includes(normalized) ? normalized : "";
}

function imageMimeTypeFromDataUrl(value) {
  const match = /^data:([^;,]+)(?:;[^,]*)?,/iu.exec(String(value || "").trim());
  return normalizeImageMimeType(match?.[1]);
}

export function normalizeImageAssetSource(raw, mimeType = "") {
  const candidate = raw && typeof raw === "object"
    ? raw
    : typeof raw === "string"
      ? { kind: raw.startsWith("data:") ? "data-url" : "blob-key", value: raw }
      : null;
  if (!candidate) {
    return null;
  }
  const kind = candidate.kind === "blob-key" ? "blob-key" : "data-url";
  const value = String(
    candidate.value
      ?? candidate.dataUrl
      ?? candidate.blobKey
      ?? ""
  ).trim();
  if (!value) {
    return null;
  }
  if (kind === "blob-key") {
    return { kind, value };
  }
  const dataMimeType = imageMimeTypeFromDataUrl(value);
  if (
    !dataMimeType
    || !value.startsWith(`data:${dataMimeType}`)
    || !value.includes(",")
  ) {
    return null;
  }
  const requestedMimeType = normalizeImageMimeType(mimeType);
  if (requestedMimeType && requestedMimeType !== dataMimeType) {
    return null;
  }
  return { kind, value };
}

export function normalizeMediaAsset(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const durationMs = Math.max(0, Math.round(finiteNumber(raw.durationMs)));
  const mediaOriginMs = Math.max(0, Math.round(finiteNumber(raw.mediaOriginMs)));
  const providedEndMs = Number(raw.mediaEndTimestampMs);
  const mediaEndTimestampMs = Number.isFinite(providedEndMs) && providedEndMs >= mediaOriginMs
    ? Math.round(providedEndMs)
    : mediaOriginMs + durationMs;
  const frameRate = Number(raw.frameRate);
  return {
    ...raw,
    durationMs,
    mediaOriginMs,
    mediaEndTimestampMs,
    frameRate: Number.isFinite(frameRate) && frameRate > 0 ? frameRate : null,
    hasVideo: Boolean(raw.hasVideo),
    hasAudio: Boolean(raw.hasAudio),
    videoDecodable: raw.videoDecodable == null ? null : Boolean(raw.videoDecodable),
    audioDecodable: raw.audioDecodable == null ? null : Boolean(raw.audioDecodable)
  };
}

export function sourceSessionIdentity(source = {}) {
  const platform = String(source.platform ?? "CHZZK")
    .trim()
    .toUpperCase() || "CHZZK";
  const platformPrefix = platform === "CHZZK"
    ? ""
    : `${platform.toLowerCase()}:`;
  const channelId = String(source.channelId ?? "").trim();
  const startedAt = String(source.broadcastStartedAt ?? "").trim();
  const contentId = String(source.contentId ?? "").trim();
  const contentType = String(source.contentType ?? "unknown").trim();

  if (platform !== "CHZZK" && contentId) {
    return `${platformPrefix}${contentType}:${contentId}`;
  }
  if (channelId && startedAt) {
    return `${platformPrefix}broadcast:${channelId}:${startedAt}`;
  }
  if (contentId) {
    return `${platformPrefix}${contentType}:${contentId}`;
  }
  if (channelId) {
    return `${platformPrefix}${contentType}:${channelId}`;
  }
  return String(source.canonicalUrl || source.url || "").trim();
}

export function sameSourceSession(leftSource = {}, rightSource = {}) {
  const leftPlatform = String(leftSource.platform ?? "CHZZK")
    .trim()
    .toUpperCase() || "CHZZK";
  const rightPlatform = String(rightSource.platform ?? "CHZZK")
    .trim()
    .toUpperCase() || "CHZZK";
  if (leftPlatform !== rightPlatform) {
    return false;
  }

  const leftContentType = String(leftSource.contentType ?? "unknown")
    .trim()
    .toLowerCase() || "unknown";
  const rightContentType = String(rightSource.contentType ?? "unknown")
    .trim()
    .toLowerCase() || "unknown";
  const sameContentType = leftContentType === rightContentType;
  const chzzkLiveVodPair = (
    leftPlatform === "CHZZK"
    && new Set([leftContentType, rightContentType]).size === 2
    && [leftContentType, rightContentType].every((type) => (
      type === "live" || type === "vod"
    ))
  );
  if (!sameContentType && !chzzkLiveVodPair) {
    return false;
  }

  const leftContentId = String(leftSource.contentId ?? "").trim();
  const rightContentId = String(rightSource.contentId ?? "").trim();
  const involvesChzzkLive = (
    leftPlatform === "CHZZK"
    && (leftContentType === "live" || rightContentType === "live")
  );
  if (leftContentId && rightContentId && !involvesChzzkLive) {
    return leftContentId === rightContentId;
  }

  if (leftPlatform === "CHZZK") {
    const leftChannelId = String(leftSource.channelId ?? "").trim();
    const rightChannelId = String(rightSource.channelId ?? "").trim();
    const leftStartedAt = String(
      leftSource.broadcastStartedAt ?? ""
    ).trim();
    const rightStartedAt = String(
      rightSource.broadcastStartedAt ?? ""
    ).trim();
    if (
      leftChannelId
      && rightChannelId
      && leftStartedAt
      && rightStartedAt
    ) {
      return (
        leftChannelId === rightChannelId
        && leftStartedAt === rightStartedAt
      );
    }
    if (chzzkLiveVodPair) {
      return false;
    }
    if (leftContentType === "live") {
      return Boolean(
        leftChannelId
        && rightChannelId
        && leftChannelId === rightChannelId
        && !leftStartedAt
        && !rightStartedAt
      );
    }
  }

  const leftIdentity = sourceSessionIdentity(leftSource);
  const rightIdentity = sourceSessionIdentity(rightSource);
  return Boolean(leftIdentity && leftIdentity === rightIdentity);
}

export function captureStateSourceConflict(captureState = {}, nextSource = {}) {
  const previousIdentity = sourceSessionIdentity(captureState.source);
  const nextIdentity = sourceSessionIdentity(nextSource);
  const draft = captureState.draft || {};
  const hasRange = Boolean(
    (Array.isArray(captureState.segments) && captureState.segments.length > 0) ||
    draft.startCapture ||
    draft.endCapture ||
    String(draft.startText || "").trim() ||
    String(draft.endText || "").trim()
  );
  return Boolean(
    hasRange &&
    previousIdentity &&
    nextIdentity &&
    !sameSourceSession(captureState.source, nextSource)
  );
}

export function captureProjectId(captureState = {}) {
  const sourceIdentity = sourceSessionIdentity(captureState.source);
  const base = sourceIdentity || captureState.projectName || "untitled";
  let hash = 2166136261;
  for (const character of String(base)) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `project-${(hash >>> 0).toString(36)}`;
}

function createBroadcastSession(source = {}) {
  const contentType = source.contentType || "unknown";
  const isLive = contentType === "live";
  const isVod = contentType === "vod";
  return {
    id: sourceSessionIdentity(source),
    channelId: source.channelId || "",
    broadcastStartedAt: source.broadcastStartedAt || "",
    liveUrl: isLive ? (source.canonicalUrl || source.url || "") : "",
    vodUrl: isVod ? (source.canonicalUrl || source.url || "") : "",
    vodContentId: isVod ? (source.contentId || "") : "",
    alignmentOffsetMs: 0,
    alignmentConfirmed: isVod
  };
}

function segmentToClip(segment, index) {
  const sourceStartMs = secondsToMilliseconds(segment.startSeconds);
  const sourceEndMs = Math.max(
    sourceStartMs + MIN_CLIP_DURATION_MS,
    secondsToMilliseconds(segment.endSeconds)
  );
  return {
    id: `clip-${segment.id || index + 1}`,
    selectionId: segment.id || `selection-${index + 1}`,
    authority: "USER",
    sourceStartMs,
    sourceEndMs,
    selectionStartMs: sourceStartMs,
    selectionEndMs: sourceEndMs,
    timelineStartMs: 0,
    enabled: true,
    note: String(segment.description || ""),
    capture: {
      start: segment.startCapture || null,
      end: segment.endCapture || null
    },
    createdAt: segment.createdAt || nowIso(),
    updatedAt: segment.updatedAt || segment.createdAt || nowIso()
  };
}

export function reflowClips(clips = []) {
  let cursor = 0;
  return clips.map((clip) => {
    const sourceStartMs = Math.max(0, Math.round(finiteNumber(clip.sourceStartMs)));
    const sourceEndMs = Math.max(
      sourceStartMs + MIN_CLIP_DURATION_MS,
      Math.round(finiteNumber(clip.sourceEndMs, sourceStartMs + MIN_CLIP_DURATION_MS))
    );
    const normalized = {
      ...clip,
      sourceStartMs,
      sourceEndMs,
      timelineStartMs: cursor,
      enabled: clip.enabled !== false
    };
    if (normalized.enabled) {
      cursor += sourceEndMs - sourceStartMs;
    }
    return normalized;
  });
}

function normalizeSuppressedSelection(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const selectionId = String(raw.selectionId || "").trim();
  const requestedStartMs = Number(raw.selectionStartMs);
  const requestedEndMs = Number(raw.selectionEndMs);
  if (
    !selectionId ||
    !Number.isFinite(requestedStartMs) ||
    !Number.isFinite(requestedEndMs)
  ) {
    return null;
  }
  const selectionStartMs = Math.max(0, Math.round(requestedStartMs));
  const selectionEndMs = Math.round(requestedEndMs);
  if (selectionEndMs - selectionStartMs < MIN_CLIP_DURATION_MS) {
    return null;
  }
  return {
    ...raw,
    selectionId,
    selectionStartMs,
    selectionEndMs,
    createdAt: raw.createdAt || nowIso(),
    updatedAt: raw.updatedAt || raw.createdAt || nowIso()
  };
}

export function createEditorProjectFromCapture(captureState = {}, {
  id = captureProjectId(captureState),
  createdAt = nowIso()
} = {}) {
  const source = { ...(captureState.source || {}) };
  const clips = reflowClips((captureState.segments || []).map(segmentToClip));
  return {
    schema: EDITOR_SCHEMA,
    id,
    name: String(captureState.projectName || source.broadcastTitle || "새 키리누키 프로젝트"),
    source,
    broadcastSession: createBroadcastSession(source),
    mediaAsset: null,
    clips,
    suppressedSelections: [],
    imageAssets: [],
    subtitles: [],
    subtitleLaneCount: MIN_SUBTITLE_LANES,
    recentSubtitleColors: [],
    audioRegions: [],
    selectedClipId: clips[0]?.id || null,
    selectedImageAssetId: null,
    selectedCueId: null,
    selectedAudioRegionId: null,
    playheadMs: 0,
    subtitleDefaults: captionStyleDefaults(
      DEFAULT_CAPTION_STYLE_PRESET_ID
    ),
    ai: {
      provider: "caption-agent",
      model: "whisper-tiny",
      language: "korean",
      status: "idle",
      progress: 0,
      lastRunAt: null,
      error: null,
      warnings: [],
      captionCheckpoints: [],
      speakerColors: {}
    },
    history: {
      undo: [],
      redo: []
    },
    createdAt,
    updatedAt: createdAt
  };
}

export function normalizeEditorProject(raw) {
  if (!raw || !ACCEPTED_EDITOR_SCHEMAS.has(raw.schema)) {
    return null;
  }
  const migratingLegacyProject = raw.schema === LEGACY_EDITOR_SCHEMA_V1;
  const clips = reflowClips(Array.isArray(raw.clips) ? raw.clips : []);
  const defaults = createEditorProjectFromCapture({}, {
    id: raw.id || makeId("project"),
    createdAt: raw.createdAt || nowIso()
  });
  const clipIds = new Set(clips.map((clip) => clip.id));
  const clipSelectionIds = new Set(clips.map((clip) => clip.selectionId));
  const suppressedBySelectionId = new Map();
  (Array.isArray(raw.suppressedSelections) ? raw.suppressedSelections : [])
    .forEach((entry) => {
      const suppressed = normalizeSuppressedSelection(entry);
      if (suppressed && !clipSelectionIds.has(suppressed.selectionId)) {
        suppressedBySelectionId.set(suppressed.selectionId, suppressed);
      }
    });
  const suppressedSelections = [...suppressedBySelectionId.values()];
  const rawSubtitles = (Array.isArray(raw.subtitles) ? raw.subtitles : [])
    .filter((cue) => cue && clipIds.has(cue.clipId));
  const subtitleColor = normalizeHexColor(
    raw.subtitleDefaults?.color,
    defaults.subtitleDefaults.color
  );
  const requestedLaneCount = clamp(
    Math.max(
      Math.round(finiteNumber(raw.subtitleLaneCount, MIN_SUBTITLE_LANES)),
      ...rawSubtitles.map((cue) => Math.round(finiteNumber(cue?.lane)) + 1),
      MIN_SUBTITLE_LANES
    ),
    MIN_SUBTITLE_LANES,
    MAX_SUBTITLE_LANES
  );
  const subtitles = rawSubtitles.map((cue) => normalizeSubtitleCue(
    {
      ...cue,
      color: cue.color ?? subtitleColor
    },
    clips.find((clip) => clip.id === cue.clipId),
    requestedLaneCount
  ));
  const subtitleLaneCount = clamp(
    Math.max(
      requestedLaneCount,
      ...subtitles.map((cue) => cue.lane + 1),
      MIN_SUBTITLE_LANES
    ),
    MIN_SUBTITLE_LANES,
    MAX_SUBTITLE_LANES
  );
  const audioRegions = (Array.isArray(raw.audioRegions) ? raw.audioRegions : [])
    .filter((region) => region && clipIds.has(region.clipId))
    .map((region) => normalizeAudioRegion(
      region,
      clips.find((clip) => clip.id === region.clipId)
    ));
  const imageAssets = (Array.isArray(raw.imageAssets) ? raw.imageAssets : [])
    .filter((asset) => asset && clipIds.has(asset.clipId))
    .flatMap((asset) => {
      const normalized = normalizeImageAsset(
        asset,
        clips.find((clip) => clip.id === asset.clipId)
      );
      return normalized ? [normalized] : [];
    });
  const rawSubtitleDefaults = raw.subtitleDefaults || {};
  const cleanDefaults = captionStyleDefaults(
    DEFAULT_CAPTION_STYLE_PRESET_ID
  );
  const hasKnownStylePreset = Object.hasOwn(
    CAPTION_STYLE_PRESETS,
    String(rawSubtitleDefaults.stylePresetId || "")
  );
  const appearsToUseMeasuredCleanStyle = (
    (!rawSubtitleDefaults.fontFamily || rawSubtitleDefaults.fontFamily === "Pretendard")
    && (!Number.isFinite(Number(rawSubtitleDefaults.fontScale))
      || Number(rawSubtitleDefaults.fontScale) === cleanDefaults.fontScale)
    && (!rawSubtitleDefaults.outlineColor
      || normalizeHexColor(rawSubtitleDefaults.outlineColor) === cleanDefaults.outlineColor)
    && (!Number.isFinite(Number(rawSubtitleDefaults.outlineWidth))
      || Number(rawSubtitleDefaults.outlineWidth) === cleanDefaults.outlineWidth)
    && (!rawSubtitleDefaults.backgroundColor
      || rawSubtitleDefaults.backgroundColor === "transparent")
  );
  const stylePresetId = hasKnownStylePreset
    ? normalizeCaptionStylePresetId(rawSubtitleDefaults.stylePresetId)
    : appearsToUseMeasuredCleanStyle
      ? DEFAULT_CAPTION_STYLE_PRESET_ID
      : LEGACY_CAPTION_STYLE_PRESET_ID;
  const selectedStyleDefaults = captionStyleDefaults(stylePresetId);
  const subtitleDefaults = {
    ...selectedStyleDefaults,
    ...rawSubtitleDefaults,
    stylePresetId,
    fontId: selectedStyleDefaults.fontId,
    fontFamily: selectedStyleDefaults.fontFamily,
    fontWeight: 800,
    fontScale: clamp(
      finiteNumber(rawSubtitleDefaults.fontScale, selectedStyleDefaults.fontScale),
      0.025,
      0.12
    ),
    lineHeight: clamp(
      finiteNumber(rawSubtitleDefaults.lineHeight, selectedStyleDefaults.lineHeight),
      1,
      1.6
    ),
    maxLines: clamp(
      Math.round(finiteNumber(
        rawSubtitleDefaults.maxLines,
        selectedStyleDefaults.maxLines
      )),
      1,
      2
    ),
    maxWidth: clamp(
      finiteNumber(rawSubtitleDefaults.maxWidth, selectedStyleDefaults.maxWidth),
      0.4,
      0.95
    ),
    color: subtitleColor,
    outlineColor: normalizeHexColor(
      rawSubtitleDefaults.outlineColor,
      selectedStyleDefaults.outlineColor
    ),
    outlineWidth: clamp(
      finiteNumber(
        rawSubtitleDefaults.outlineWidth,
        selectedStyleDefaults.outlineWidth
      ),
      0,
      0.02
    ),
    backgroundColor: migratingLegacyProject
      ? "transparent"
      : String(
        rawSubtitleDefaults.backgroundColor
        || selectedStyleDefaults.backgroundColor
      ),
    shadowColor: String(
      rawSubtitleDefaults.shadowColor || selectedStyleDefaults.shadowColor
    ),
    shadowOffsetXEm: clamp(
      finiteNumber(
        rawSubtitleDefaults.shadowOffsetXEm,
        selectedStyleDefaults.shadowOffsetXEm
      ),
      -1,
      1
    ),
    shadowOffsetYEm: clamp(
      finiteNumber(
        rawSubtitleDefaults.shadowOffsetYEm,
        selectedStyleDefaults.shadowOffsetYEm
      ),
      -1,
      1
    ),
    shadowBlurEm: clamp(
      finiteNumber(
        rawSubtitleDefaults.shadowBlurEm,
        selectedStyleDefaults.shadowBlurEm
      ),
      0,
      1
    )
  };
  const rawAi = raw.ai || {};
  const legacyBrowserWhisperMetadata = rawAi.provider === "transformers.js";
  const ai = {
    ...defaults.ai,
    ...rawAi,
    ...(legacyBrowserWhisperMetadata
      ? {
        provider: defaults.ai.provider,
        model: defaults.ai.model,
        status: "idle",
        progress: 0,
        error: null
      }
      : {}),
    warnings: normalizeAiWarnings(rawAi.warnings),
    speakerColors: normalizeAiSpeakerColors(rawAi.speakerColors),
    captionCheckpoints: normalizeAiCaptionCheckpoints(
      rawAi.captionCheckpoints,
      clips
    )
  };

  return {
    ...defaults,
    ...raw,
    schema: EDITOR_SCHEMA,
    source: { ...defaults.source, ...(raw.source || {}) },
    broadcastSession: { ...defaults.broadcastSession, ...(raw.broadcastSession || {}) },
    mediaAsset: normalizeMediaAsset(raw.mediaAsset),
    subtitleDefaults,
    ai,
    history: {
      undo: Array.isArray(raw.history?.undo) ? raw.history.undo : [],
      redo: Array.isArray(raw.history?.redo) ? raw.history.redo : []
    },
    clips,
    suppressedSelections,
    subtitles,
    subtitleLaneCount,
    recentSubtitleColors: normalizeRecentSubtitleColors(raw.recentSubtitleColors),
    audioRegions,
    imageAssets,
    selectedImageAssetId: imageAssets.some((asset) => asset.id === raw.selectedImageAssetId)
      ? raw.selectedImageAssetId
      : null,
    selectedAudioRegionId: audioRegions.some((region) => region.id === raw.selectedAudioRegionId)
      ? raw.selectedAudioRegionId
      : null
  };
}

export function applyCaptionStylePreset(project, presetId) {
  if (!project || typeof project !== "object") {
    return project;
  }
  const normalizedPresetId = normalizeCaptionStylePresetId(presetId);
  return {
    ...project,
    subtitleDefaults: {
      ...(project.subtitleDefaults || {}),
      ...captionStyleDefaults(normalizedPresetId)
    },
    updatedAt: nowIso()
  };
}

export function mergeCaptureIntoEditorProject(project, captureState = {}) {
  const normalized = normalizeEditorProject(project) || createEditorProjectFromCapture(captureState);
  const alignmentOffsetMs = Math.round(finiteNumber(normalized.broadcastSession?.alignmentOffsetMs));
  const capturedIncomingClips = (captureState.segments || []).map(segmentToClip);
  const capturedIncomingBySelection = new Map(
    capturedIncomingClips.map((clip) => [clip.selectionId, clip])
  );
  const suppressedSelections = (normalized.suppressedSelections || []).filter((suppressed) => {
    const incoming = capturedIncomingBySelection.get(suppressed.selectionId);
    return Boolean(
      incoming &&
      incoming.selectionStartMs === suppressed.selectionStartMs &&
      incoming.selectionEndMs === suppressed.selectionEndMs
    );
  });
  const suppressedSelectionIds = new Set(
    suppressedSelections.map((suppressed) => suppressed.selectionId)
  );
  const incomingClips = capturedIncomingClips
    .filter((clip) => !suppressedSelectionIds.has(clip.selectionId))
    .map((clip) => {
      const sourceStartMs = clip.selectionStartMs + alignmentOffsetMs;
      const sourceEndMs = clip.selectionEndMs + alignmentOffsetMs;
      if (sourceStartMs < 0 || sourceEndMs <= sourceStartMs) {
        throw new Error(
          `‘${clip.note || clip.selectionId}’ 선택 구간은 현재 정렬값에서 로컬 원본 시작보다 앞에 있습니다. 정렬값이나 선택 구간을 확인해 주세요.`
        );
      }
      return {
        ...clip,
        sourceStartMs,
        sourceEndMs
      };
    });
  const incomingBySelection = new Map(incomingClips.map((clip) => [clip.selectionId, clip]));
  const existingSelectionIds = new Set(normalized.clips.map((clip) => clip.selectionId));
  const existingBySelection = new Map();
  normalized.clips.forEach((clip) => {
    const group = existingBySelection.get(clip.selectionId) || [];
    group.push(clip);
    existingBySelection.set(clip.selectionId, group);
  });
  const retainedByClipId = new Map();
  const replacementBySelection = new Map();
  existingBySelection.forEach((existingGroup, selectionId) => {
    const incoming = incomingBySelection.get(selectionId);
    if (!incoming) {
      return;
    }
    const capturedBoundaryUnchanged = existingGroup.every((existing) => {
      const previousSelectionStartMs = Math.round(finiteNumber(
        existing.selectionStartMs,
        existing.sourceStartMs - alignmentOffsetMs
      ));
      const previousSelectionEndMs = Math.round(finiteNumber(
        existing.selectionEndMs,
        existing.sourceEndMs - alignmentOffsetMs
      ));
      return (
        previousSelectionStartMs === incoming.selectionStartMs &&
        previousSelectionEndMs === incoming.selectionEndMs
      );
    });
    const retainedGroup = existingGroup.flatMap((existing) => {
      const previousSelectionStartMs = Math.round(finiteNumber(
        existing.selectionStartMs,
        existing.sourceStartMs - alignmentOffsetMs
      ));
      const previousSelectionEndMs = Math.round(finiteNumber(
        existing.selectionEndMs,
        existing.sourceEndMs - alignmentOffsetMs
      ));
      const stillAtCapturedBoundary = (
        existing.sourceStartMs === previousSelectionStartMs + alignmentOffsetMs &&
        existing.sourceEndMs === previousSelectionEndMs + alignmentOffsetMs
      );
      const overlapStartMs = Math.max(existing.sourceStartMs, incoming.sourceStartMs);
      const overlapEndMs = Math.min(existing.sourceEndMs, incoming.sourceEndMs);
      const canPreserveTrim = (
        overlapEndMs - overlapStartMs >= MIN_CLIP_DURATION_MS &&
        (existingGroup.length > 1 || !stillAtCapturedBoundary)
      );
      if (!capturedBoundaryUnchanged && !canPreserveTrim) {
        return [];
      }
      return [{
        ...incoming,
        ...existing,
        sourceStartMs: capturedBoundaryUnchanged
          ? existing.sourceStartMs
          : overlapStartMs,
        sourceEndMs: capturedBoundaryUnchanged
          ? existing.sourceEndMs
          : overlapEndMs,
        selectionStartMs: incoming.selectionStartMs,
        selectionEndMs: incoming.selectionEndMs,
        note: incoming.note,
        capture: incoming.capture,
        updatedAt: nowIso()
      }];
    });
    if (retainedGroup.length > 0) {
      retainedGroup.forEach((clip) => retainedByClipId.set(clip.id, clip));
      return;
    }
    const [firstExisting] = existingGroup;
    replacementBySelection.set(selectionId, {
      ...incoming,
      ...firstExisting,
      sourceStartMs: incoming.sourceStartMs,
      sourceEndMs: incoming.sourceEndMs,
      selectionStartMs: incoming.selectionStartMs,
      selectionEndMs: incoming.selectionEndMs,
      note: incoming.note,
      capture: incoming.capture,
      updatedAt: nowIso()
    });
  });
  const emittedReplacements = new Set();
  const retainedClips = normalized.clips.flatMap((existing) => {
    const incoming = incomingBySelection.get(existing.selectionId);
    if (!incoming) {
      return [];
    }
    const retained = retainedByClipId.get(existing.id);
    if (retained) {
      return [retained];
    }
    const replacement = replacementBySelection.get(existing.selectionId);
    if (!replacement || emittedReplacements.has(existing.selectionId)) {
      return [];
    }
    emittedReplacements.add(existing.selectionId);
    return [replacement];
  });
  const nextClips = [
    ...retainedClips,
    ...incomingClips.filter((clip) => !existingSelectionIds.has(clip.selectionId))
  ];
  const nextClipIds = new Set(nextClips.map((clip) => clip.id));
  const reflowedClips = reflowClips(nextClips);
  const previousClipsById = new Map(normalized.clips.map((clip) => [clip.id, clip]));
  const nextClipsById = new Map(reflowedClips.map((clip) => [clip.id, clip]));
  const subtitles = normalized.subtitles.flatMap((cue) => {
    const previousClip = previousClipsById.get(cue.clipId);
    const nextClip = nextClipsById.get(cue.clipId);
    if (!previousClip || !nextClip) {
      return [];
    }
    const cueSourceStartMs = previousClip.sourceStartMs + cue.startOffsetMs;
    const cueSourceEndMs = previousClip.sourceStartMs + cue.endOffsetMs;
    const overlapStartMs = Math.max(nextClip.sourceStartMs, cueSourceStartMs);
    const overlapEndMs = Math.min(nextClip.sourceEndMs, cueSourceEndMs);
    if (overlapEndMs - overlapStartMs < MIN_CUE_DURATION_MS) {
      return [];
    }
    return [normalizeSubtitleCue({
      ...cue,
      startOffsetMs: overlapStartMs - nextClip.sourceStartMs,
      endOffsetMs: overlapEndMs - nextClip.sourceStartMs
    }, nextClip, normalized.subtitleLaneCount)];
  });
  const audioRegions = normalized.audioRegions.flatMap((region) => {
    const previousClip = previousClipsById.get(region.clipId);
    const nextClip = nextClipsById.get(region.clipId);
    if (!previousClip || !nextClip) {
      return [];
    }
    const regionSourceStartMs = previousClip.sourceStartMs + region.startOffsetMs;
    const regionSourceEndMs = previousClip.sourceStartMs + region.endOffsetMs;
    const overlapStartMs = Math.max(nextClip.sourceStartMs, regionSourceStartMs);
    const overlapEndMs = Math.min(nextClip.sourceEndMs, regionSourceEndMs);
    if (overlapEndMs - overlapStartMs < MIN_CUE_DURATION_MS) {
      return [];
    }
    return [normalizeAudioRegion({
      ...region,
      startOffsetMs: overlapStartMs - nextClip.sourceStartMs,
      endOffsetMs: overlapEndMs - nextClip.sourceStartMs
    }, nextClip)];
  });
  const imageAssets = normalized.imageAssets.flatMap((asset) => {
    const previousClip = previousClipsById.get(asset.clipId);
    const nextClip = nextClipsById.get(asset.clipId);
    if (!previousClip || !nextClip) {
      return [];
    }
    const assetSourceStartMs = previousClip.sourceStartMs + asset.startOffsetMs;
    const assetSourceEndMs = previousClip.sourceStartMs + asset.endOffsetMs;
    const overlapStartMs = Math.max(nextClip.sourceStartMs, assetSourceStartMs);
    const overlapEndMs = Math.min(nextClip.sourceEndMs, assetSourceEndMs);
    if (overlapEndMs - overlapStartMs < MIN_CUE_DURATION_MS) {
      return [];
    }
    const next = normalizeImageAsset({
      ...asset,
      startOffsetMs: overlapStartMs - nextClip.sourceStartMs,
      endOffsetMs: overlapEndMs - nextClip.sourceStartMs
    }, nextClip);
    return next ? [next] : [];
  });
  const source = { ...normalized.source, ...(captureState.source || {}) };
  const incomingSession = createBroadcastSession(source);
  const previouslySelectedClip = normalized.clips.find((clip) => (
    clip.id === normalized.selectedClipId
  ));
  const nextSelectedClipId = nextClipIds.has(normalized.selectedClipId)
    ? normalized.selectedClipId
    : nextClips.find((clip) => (
      clip.selectionId === previouslySelectedClip?.selectionId
    ))?.id || nextClips[0]?.id || null;

  return {
    ...normalized,
    name: captureState.projectName || normalized.name,
    source,
    broadcastSession: {
      ...normalized.broadcastSession,
      ...incomingSession,
      liveUrl: incomingSession.liveUrl || normalized.broadcastSession?.liveUrl || "",
      vodUrl: incomingSession.vodUrl || normalized.broadcastSession?.vodUrl || "",
      vodContentId: incomingSession.vodContentId || normalized.broadcastSession?.vodContentId || "",
      alignmentOffsetMs: normalized.broadcastSession?.alignmentOffsetMs || 0,
      alignmentConfirmed: (
        normalized.broadcastSession?.alignmentConfirmed
        || source.contentType === "vod"
      )
    },
    clips: reflowedClips,
    suppressedSelections,
    subtitles,
    audioRegions,
    imageAssets,
    selectedClipId: nextSelectedClipId,
    selectedCueId: subtitles.some((cue) => cue.id === normalized.selectedCueId)
      ? normalized.selectedCueId
      : null,
    selectedImageAssetId: imageAssets.some((asset) => (
      asset.id === normalized.selectedImageAssetId
    ))
      ? normalized.selectedImageAssetId
      : null,
    selectedAudioRegionId: audioRegions.some((region) => (
      region.id === normalized.selectedAudioRegionId
    ))
      ? normalized.selectedAudioRegionId
      : null,
    updatedAt: nowIso()
  };
}

export function projectDurationMs(project) {
  return (project?.clips || []).reduce((total, clip) => (
    clip.enabled === false ? total : total + Math.max(0, clip.sourceEndMs - clip.sourceStartMs)
  ), 0);
}

export function clipDurationMs(clip) {
  return Math.max(0, finiteNumber(clip?.sourceEndMs) - finiteNumber(clip?.sourceStartMs));
}

export function mapTimelineToSource(project, timelineMs) {
  const enabled = (project?.clips || []).filter((clip) => clip.enabled !== false);
  if (enabled.length === 0) {
    return null;
  }
  const duration = projectDurationMs(project);
  const target = clamp(Math.round(finiteNumber(timelineMs)), 0, Math.max(0, duration));
  const clip = enabled.find((candidate, index) => {
    const end = candidate.timelineStartMs + clipDurationMs(candidate);
    return target < end || (index === enabled.length - 1 && target === end);
  }) || enabled.at(-1);
  const offsetMs = clamp(target - clip.timelineStartMs, 0, clipDurationMs(clip));
  return {
    clipId: clip.id,
    timelineMs: target,
    clipOffsetMs: offsetMs,
    sourceMs: clip.sourceStartMs + offsetMs
  };
}

export function mapSourceToTimeline(project, clipId, sourceMs) {
  const clip = project?.clips?.find((candidate) => candidate.id === clipId && candidate.enabled !== false);
  if (!clip) {
    return null;
  }
  const boundedSourceMs = clamp(
    Math.round(finiteNumber(sourceMs)),
    clip.sourceStartMs,
    clip.sourceEndMs
  );
  return clip.timelineStartMs + boundedSourceMs - clip.sourceStartMs;
}

function normalizeSubtitleCue(cue, clip, laneCount = MAX_SUBTITLE_LANES) {
  const duration = Math.max(MIN_CUE_DURATION_MS, clipDurationMs(clip));
  const startOffsetMs = clamp(Math.round(finiteNumber(cue.startOffsetMs)), 0, Math.max(0, duration - MIN_CUE_DURATION_MS));
  const endOffsetMs = clamp(
    Math.round(finiteNumber(cue.endOffsetMs, startOffsetMs + 1500)),
    startOffsetMs + MIN_CUE_DURATION_MS,
    duration
  );
  const remotePlacement = String(cue.remoteMeta?.placement || "")
    .trim()
    .toLowerCase();
  const origin = cue.origin === "ai" ? "ai" : "human";
  const humanEdited = Boolean(cue.humanEdited);
  const automaticAiCue = origin === "ai" && !humanEdited;
  const remoteMeta = cue.remoteMeta && typeof cue.remoteMeta === "object"
    ? {
      speakerId: String(cue.remoteMeta.speakerId || "unknown")
        .replace(/\s+/gu, " ")
        .trim()
        .slice(0, 80) || "unknown",
      reviewRequired: Boolean(cue.remoteMeta.reviewRequired),
      placement: automaticAiCue
        ? AUTOMATIC_CAPTION_POSITION.placement
        : ["top", "center", "bottom"].includes(remotePlacement)
          ? remotePlacement
          : AUTOMATIC_CAPTION_POSITION.placement,
      ...(cue.remoteMeta.qualityStatus != null
        || Array.isArray(cue.remoteMeta.qualityCodes)
        ? {
          qualityStatus: cue.remoteMeta.qualityStatus === "review-required"
            ? "review-required"
            : "accepted",
          qualityCodes: [...new Set(
            (Array.isArray(cue.remoteMeta.qualityCodes)
              ? cue.remoteMeta.qualityCodes
              : [])
              .map((code) => String(code || "").trim().slice(0, 128))
              .filter(Boolean)
          )].slice(0, 32)
        }
        : {})
    }
    : null;
  return {
    id: cue.id || makeId("cue"),
    clipId: clip.id,
    startOffsetMs,
    endOffsetMs,
    text: String(cue.text || "").trim(),
    lane: clamp(
      Math.round(finiteNumber(cue.lane)),
      0,
      Math.max(0, Math.min(MAX_SUBTITLE_LANES, laneCount) - 1)
    ),
    color: normalizeHexColor(cue.color, "#ffffff"),
    x: automaticAiCue
      ? AUTOMATIC_CAPTION_POSITION.x
      : clamp(finiteNumber(cue.x, AUTOMATIC_CAPTION_POSITION.x), 0.05, 0.95),
    y: automaticAiCue
      ? AUTOMATIC_CAPTION_POSITION.y
      : clamp(finiteNumber(cue.y, AUTOMATIC_CAPTION_POSITION.y), 0.05, 0.95),
    origin,
    humanEdited,
    confidence: Number.isFinite(cue.confidence) ? cue.confidence : null,
    ...(remoteMeta ? { remoteMeta } : {}),
    createdAt: cue.createdAt || nowIso(),
    updatedAt: cue.updatedAt || cue.createdAt || nowIso()
  };
}

export function resetAiSubtitlePositions(project, {
  includeHumanEdited = false,
  updatedAt = nowIso()
} = {}) {
  if (!project || !Array.isArray(project.subtitles)) {
    return project;
  }
  let changed = false;
  const subtitles = project.subtitles.map((cue) => {
    if (
      cue?.origin !== "ai"
      || (cue.humanEdited && !includeHumanEdited)
    ) {
      return cue;
    }
    const remoteMeta = cue.remoteMeta && typeof cue.remoteMeta === "object"
      ? {
        ...cue.remoteMeta,
        placement: AUTOMATIC_CAPTION_POSITION.placement
      }
      : cue.remoteMeta;
    if (
      cue.x === AUTOMATIC_CAPTION_POSITION.x
      && cue.y === AUTOMATIC_CAPTION_POSITION.y
      && (
        !remoteMeta
        || remoteMeta.placement === cue.remoteMeta?.placement
      )
    ) {
      return cue;
    }
    changed = true;
    return {
      ...cue,
      x: AUTOMATIC_CAPTION_POSITION.x,
      y: AUTOMATIC_CAPTION_POSITION.y,
      ...(remoteMeta ? { remoteMeta } : {}),
      updatedAt
    };
  });
  return changed
    ? {
      ...project,
      subtitles,
      updatedAt
    }
    : project;
}

export function createSubtitleCue(project, {
  id,
  clipId,
  startOffsetMs = 0,
  endOffsetMs = 2000,
  text = "",
  lane = 0,
  color,
  x,
  y,
  origin = "human",
  confidence = null,
  remoteMeta = null,
  createdAt = nowIso()
} = {}) {
  const clip = project?.clips?.find((candidate) => candidate.id === clipId) || project?.clips?.[0];
  if (!clip) {
    throw new Error("자막을 추가할 영상 구간이 없습니다.");
  }
  return normalizeSubtitleCue({
    id,
    clipId: clip.id,
    startOffsetMs,
    endOffsetMs,
    text,
    lane,
    color: color ?? project.subtitleDefaults?.color,
    x: x ?? project.subtitleDefaults?.x,
    y: y ?? project.subtitleDefaults?.y,
    origin,
    confidence,
    remoteMeta,
    createdAt,
    updatedAt: createdAt
  }, clip, project.subtitleLaneCount ?? MIN_SUBTITLE_LANES);
}

export function normalizeImageAsset(asset, clip) {
  if (!asset || !clip) {
    return null;
  }
  const duration = Math.max(MIN_CUE_DURATION_MS, clipDurationMs(clip));
  const startOffsetMs = clamp(
    Math.round(finiteNumber(asset.startOffsetMs)),
    0,
    Math.max(0, duration - MIN_CUE_DURATION_MS)
  );
  const endOffsetMs = clamp(
    Math.round(finiteNumber(asset.endOffsetMs, startOffsetMs + 2000)),
    startOffsetMs + MIN_CUE_DURATION_MS,
    duration
  );
  const requestedSource = asset.source
    ?? (asset.dataUrl ? { kind: "data-url", value: asset.dataUrl } : null)
    ?? (asset.blobKey ? { kind: "blob-key", value: asset.blobKey } : null);
  const source = normalizeImageAssetSource(requestedSource, asset.mimeType);
  const mimeType = source?.kind === "data-url"
    ? imageMimeTypeFromDataUrl(source.value)
    : normalizeImageMimeType(asset.mimeType);
  if (!source || !mimeType) {
    return null;
  }
  const naturalWidth = Math.round(finiteNumber(asset.naturalWidth));
  const naturalHeight = Math.round(finiteNumber(asset.naturalHeight));
  return {
    id: asset.id || makeId("asset"),
    clipId: clip.id,
    startOffsetMs,
    endOffsetMs,
    name: String(asset.name || "이미지 에셋").trim() || "이미지 에셋",
    mimeType,
    source,
    sourceUrl: String(asset.sourceUrl || "").trim(),
    x: clamp(finiteNumber(asset.x, 0.5), 0, 1),
    y: clamp(finiteNumber(asset.y, 0.5), 0, 1),
    scale: clamp(finiteNumber(asset.scale, 1), 0.05, 5),
    opacity: clamp(finiteNumber(asset.opacity, 1), 0, 1),
    naturalWidth: naturalWidth > 0 ? naturalWidth : null,
    naturalHeight: naturalHeight > 0 ? naturalHeight : null,
    createdAt: asset.createdAt || nowIso(),
    updatedAt: asset.updatedAt || asset.createdAt || nowIso()
  };
}

export function createImageAsset(project, {
  id,
  clipId,
  startOffsetMs = 0,
  endOffsetMs = 2000,
  name = "이미지 에셋",
  mimeType = "",
  source = null,
  dataUrl = "",
  blobKey = "",
  sourceUrl = "",
  x = 0.5,
  y = 0.5,
  scale = 1,
  opacity = 1,
  naturalWidth = null,
  naturalHeight = null,
  createdAt = nowIso()
} = {}) {
  const clip = project?.clips?.find((candidate) => candidate.id === clipId) || project?.clips?.[0];
  if (!clip) {
    throw new Error("에셋을 추가할 영상 구간이 없습니다.");
  }
  const normalized = normalizeImageAsset({
    id,
    clipId: clip.id,
    startOffsetMs,
    endOffsetMs,
    name,
    mimeType,
    source: source
      ?? (dataUrl ? { kind: "data-url", value: dataUrl } : null)
      ?? (blobKey ? { kind: "blob-key", value: blobKey } : null),
    sourceUrl,
    x,
    y,
    scale,
    opacity,
    naturalWidth,
    naturalHeight,
    createdAt,
    updatedAt: createdAt
  }, clip);
  if (!normalized) {
    throw new Error("PNG, JPEG, WebP 또는 GIF 이미지 데이터가 필요합니다.");
  }
  return normalized;
}

export function updateImageAsset(project, assetId, patch = {}) {
  const index = (project.imageAssets || []).findIndex((asset) => asset.id === assetId);
  if (index < 0) {
    return project;
  }
  const current = project.imageAssets[index];
  const clip = project.clips.find((candidate) => candidate.id === current.clipId);
  const next = normalizeImageAsset({
    ...current,
    ...patch,
    updatedAt: nowIso()
  }, clip);
  if (!next) {
    throw new Error("PNG, JPEG, WebP 또는 GIF 이미지 데이터가 필요합니다.");
  }
  const imageAssets = [...project.imageAssets];
  imageAssets[index] = next;
  return {
    ...project,
    imageAssets,
    selectedImageAssetId: assetId,
    updatedAt: nowIso()
  };
}

export function deleteImageAsset(project, assetId) {
  return {
    ...project,
    imageAssets: (project.imageAssets || []).filter((asset) => asset.id !== assetId),
    selectedImageAssetId: project.selectedImageAssetId === assetId
      ? null
      : project.selectedImageAssetId,
    updatedAt: nowIso()
  };
}

function normalizeAudioRegion(region, clip) {
  const duration = Math.max(MIN_CUE_DURATION_MS, clipDurationMs(clip));
  const startOffsetMs = clamp(
    Math.round(finiteNumber(region.startOffsetMs)),
    0,
    Math.max(0, duration - MIN_CUE_DURATION_MS)
  );
  const endOffsetMs = clamp(
    Math.round(finiteNumber(region.endOffsetMs, startOffsetMs + 2000)),
    startOffsetMs + MIN_CUE_DURATION_MS,
    duration
  );
  const maximumFadeMs = Math.max(0, endOffsetMs - startOffsetMs);
  return {
    id: region.id || makeId("audio"),
    clipId: clip.id,
    startOffsetMs,
    endOffsetMs,
    gain: clamp(finiteNumber(region.gain, 1), 0, 1),
    muted: Boolean(region.muted),
    fadeInMs: clamp(
      Math.round(finiteNumber(region.fadeInMs)),
      0,
      maximumFadeMs
    ),
    fadeOutMs: clamp(
      Math.round(finiteNumber(region.fadeOutMs)),
      0,
      maximumFadeMs
    ),
    createdAt: region.createdAt || nowIso(),
    updatedAt: region.updatedAt || region.createdAt || nowIso()
  };
}

export function createAudioRegion(project, {
  id,
  clipId,
  startOffsetMs = 0,
  endOffsetMs = 2000,
  gain = 1,
  muted = false,
  fadeInMs = 0,
  fadeOutMs = 0,
  createdAt = nowIso()
} = {}) {
  const clip = project?.clips?.find((candidate) => candidate.id === clipId) || project?.clips?.[0];
  if (!clip) {
    throw new Error("음성을 조절할 영상 구간이 없습니다.");
  }
  return normalizeAudioRegion({
    id,
    clipId: clip.id,
    startOffsetMs,
    endOffsetMs,
    gain,
    muted,
    fadeInMs,
    fadeOutMs,
    createdAt,
    updatedAt: createdAt
  }, clip);
}

export function updateAudioRegion(project, regionId, patch = {}) {
  const index = project.audioRegions.findIndex((region) => region.id === regionId);
  if (index < 0) {
    return project;
  }
  const current = project.audioRegions[index];
  const clip = project.clips.find((candidate) => candidate.id === current.clipId);
  const next = normalizeAudioRegion({
    ...current,
    ...patch,
    updatedAt: nowIso()
  }, clip);
  const audioRegions = [...project.audioRegions];
  audioRegions[index] = next;
  return {
    ...project,
    audioRegions,
    selectedAudioRegionId: regionId,
    updatedAt: nowIso()
  };
}

export function deleteAudioRegion(project, regionId) {
  return {
    ...project,
    audioRegions: project.audioRegions.filter((region) => region.id !== regionId),
    selectedAudioRegionId: project.selectedAudioRegionId === regionId
      ? null
      : project.selectedAudioRegionId,
    updatedAt: nowIso()
  };
}

export function cueTimelineRange(project, cue) {
  const clip = project?.clips?.find((candidate) => candidate.id === cue?.clipId);
  if (!clip || clip.enabled === false) {
    return null;
  }
  return {
    startMs: clip.timelineStartMs + cue.startOffsetMs,
    endMs: clip.timelineStartMs + cue.endOffsetMs
  };
}

export function imageAssetTimelineRange(project, asset) {
  const clip = project?.clips?.find((candidate) => candidate.id === asset?.clipId);
  if (!clip || clip.enabled === false) {
    return null;
  }
  return {
    startMs: clip.timelineStartMs + asset.startOffsetMs,
    endMs: clip.timelineStartMs + asset.endOffsetMs
  };
}

export function audioRegionTimelineRange(project, region) {
  const clip = project?.clips?.find((candidate) => candidate.id === region?.clipId);
  if (!clip || clip.enabled === false) {
    return null;
  }
  return {
    startMs: clip.timelineStartMs + region.startOffsetMs,
    endMs: clip.timelineStartMs + region.endOffsetMs
  };
}

export function timelineSnapThresholdMs(pixelsPerSecond, {
  thresholdPx = 8,
  minimumMs = 25,
  maximumMs = 400
} = {}) {
  const pixels = Math.max(1, finiteNumber(pixelsPerSecond, 70));
  const requested = Math.round(
    Math.max(0, finiteNumber(thresholdPx, 8)) / pixels * 1000
  );
  return clamp(
    requested,
    Math.max(0, Math.round(finiteNumber(minimumMs, 25))),
    Math.max(0, Math.round(finiteNumber(maximumMs, 400)))
  );
}

export function timelineSnapCandidates(project, {
  clipId,
  excludeCueId = null,
  excludeImageAssetId = null,
  preferredKind = null,
  includePlayhead = true
} = {}) {
  const clip = project?.clips?.find((candidate) => candidate.id === clipId);
  if (!clip || clip.enabled === false) {
    return [];
  }
  const clipStartMs = clip.timelineStartMs;
  const clipEndMs = clip.timelineStartMs + clipDurationMs(clip);
  const candidates = [];
  const priorityFor = (kind) => {
    if (kind === preferredKind) {
      return 0;
    }
    if (kind === "subtitle" || kind === "asset") {
      return 1;
    }
    return kind === "playhead" ? 2 : 3;
  };
  const add = ({ timeMs, kind, edge, itemId = null, label }) => {
    const normalizedTimeMs = Math.round(finiteNumber(timeMs, -1));
    if (normalizedTimeMs < clipStartMs || normalizedTimeMs > clipEndMs) {
      return;
    }
    candidates.push({
      timeMs: normalizedTimeMs,
      kind,
      edge,
      itemId,
      label,
      priority: priorityFor(kind)
    });
  };

  add({
    timeMs: clipStartMs,
    kind: "clip",
    edge: "start",
    itemId: clip.id,
    label: "컷 시작"
  });
  add({
    timeMs: clipEndMs,
    kind: "clip",
    edge: "end",
    itemId: clip.id,
    label: "컷 끝"
  });
  if (includePlayhead) {
    add({
      timeMs: project.playheadMs,
      kind: "playhead",
      edge: "point",
      label: "재생 헤드"
    });
  }
  for (const cue of project.subtitles || []) {
    if (cue.clipId !== clip.id || cue.id === excludeCueId) {
      continue;
    }
    const range = cueTimelineRange(project, cue);
    if (!range) {
      continue;
    }
    add({
      timeMs: range.startMs,
      kind: "subtitle",
      edge: "start",
      itemId: cue.id,
      label: "자막 시작"
    });
    add({
      timeMs: range.endMs,
      kind: "subtitle",
      edge: "end",
      itemId: cue.id,
      label: "자막 끝"
    });
  }
  for (const asset of project.imageAssets || []) {
    if (asset.clipId !== clip.id || asset.id === excludeImageAssetId) {
      continue;
    }
    const range = imageAssetTimelineRange(project, asset);
    if (!range) {
      continue;
    }
    add({
      timeMs: range.startMs,
      kind: "asset",
      edge: "start",
      itemId: asset.id,
      label: "에셋 시작"
    });
    add({
      timeMs: range.endMs,
      kind: "asset",
      edge: "end",
      itemId: asset.id,
      label: "에셋 끝"
    });
  }
  return candidates;
}

export function resolveTimelineSnap(rawTimelineMs, candidates, {
  thresholdMs = 0
} = {}) {
  const targetMs = Math.round(finiteNumber(rawTimelineMs));
  const limitMs = Math.max(0, Math.round(finiteNumber(thresholdMs)));
  const matches = (Array.isArray(candidates) ? candidates : [])
    .filter((candidate) => (
      candidate
      && Number.isFinite(Number(candidate.timeMs))
    ))
    .map((candidate) => ({
      ...candidate,
      timeMs: Math.round(Number(candidate.timeMs)),
      deltaMs: Math.round(Number(candidate.timeMs)) - targetMs,
      distanceMs: Math.abs(Math.round(Number(candidate.timeMs)) - targetMs),
      priority: Math.round(finiteNumber(candidate.priority, 100))
    }))
    .filter((candidate) => candidate.distanceMs <= limitMs)
    .sort((first, second) => (
      first.distanceMs - second.distanceMs
      || first.priority - second.priority
      || first.timeMs - second.timeMs
      || String(first.kind || "").localeCompare(String(second.kind || ""))
      || String(first.itemId || "").localeCompare(String(second.itemId || ""))
      || String(first.edge || "").localeCompare(String(second.edge || ""))
    ));
  return matches[0] || null;
}

export function matchSubtitleCueToImageAsset(project, cueId, assetId) {
  const cue = project?.subtitles?.find((candidate) => candidate.id === cueId);
  const asset = project?.imageAssets?.find((candidate) => candidate.id === assetId);
  if (!cue || !asset || cue.clipId !== asset.clipId) {
    return project;
  }
  return updateSubtitleCue(project, cue.id, {
    startOffsetMs: asset.startOffsetMs,
    endOffsetMs: asset.endOffsetMs
  });
}

export function matchImageAssetToSubtitleCue(project, assetId, cueId) {
  const asset = project?.imageAssets?.find((candidate) => candidate.id === assetId);
  const cue = project?.subtitles?.find((candidate) => candidate.id === cueId);
  if (!asset || !cue || asset.clipId !== cue.clipId) {
    return project;
  }
  return updateImageAsset(project, asset.id, {
    startOffsetMs: cue.startOffsetMs,
    endOffsetMs: cue.endOffsetMs
  });
}

export function cueAtTimeline(project, timelineMs) {
  return cuesAtTimeline(project, timelineMs)[0] || null;
}

export function cuesAtTimeline(project, timelineMs) {
  const target = Math.round(finiteNumber(timelineMs));
  return (project?.subtitles || [])
    .map((cue) => ({ cue, range: cueTimelineRange(project, cue) }))
    .filter(({ range }) => range && target >= range.startMs && target < range.endMs)
    .sort((a, b) => (
      a.cue.lane - b.cue.lane ||
      a.range.startMs - b.range.startMs ||
      a.cue.id.localeCompare(b.cue.id)
    ))
    .map(({ cue }) => cue);
}

export function imageAssetsAtTimeline(project, timelineMs) {
  const target = Math.round(finiteNumber(timelineMs));
  // Array order is the stable z-order: earlier assets are behind later assets.
  return (project?.imageAssets || []).filter((asset) => {
    const range = imageAssetTimelineRange(project, asset);
    return range && target >= range.startMs && target < range.endMs;
  });
}

export function findImageAssetOverlaps(project) {
  const assets = (project?.imageAssets || [])
    .map((asset, order) => ({
      asset,
      order,
      range: imageAssetTimelineRange(project, asset)
    }))
    .filter(({ range }) => range)
    .sort((a, b) => a.range.startMs - b.range.startMs || a.order - b.order);
  const overlaps = [];
  for (let leftIndex = 0; leftIndex < assets.length; leftIndex += 1) {
    const left = assets[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < assets.length; rightIndex += 1) {
      const right = assets[rightIndex];
      if (right.range.startMs >= left.range.endMs) {
        break;
      }
      if (right.range.endMs > left.range.startMs) {
        overlaps.push({
          firstAssetId: left.asset.id,
          secondAssetId: right.asset.id,
          startMs: Math.max(left.range.startMs, right.range.startMs),
          endMs: Math.min(left.range.endMs, right.range.endMs)
        });
      }
    }
  }
  return overlaps;
}

export function findSubtitleOverlaps(project) {
  const cues = (project?.subtitles || [])
    .map((cue) => ({ cue, range: cueTimelineRange(project, cue) }))
    .filter(({ range }) => range)
    .sort((a, b) => a.range.startMs - b.range.startMs);
  const overlaps = [];
  for (let leftIndex = 0; leftIndex < cues.length; leftIndex += 1) {
    const left = cues[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < cues.length; rightIndex += 1) {
      const right = cues[rightIndex];
      if (right.range.startMs >= left.range.endMs) {
        break;
      }
      if (
        right.cue.lane === left.cue.lane &&
        right.range.endMs > left.range.startMs
      ) {
        overlaps.push({
          firstCueId: left.cue.id,
          secondCueId: right.cue.id,
          startMs: Math.max(left.range.startMs, right.range.startMs),
          endMs: Math.min(left.range.endMs, right.range.endMs)
        });
      }
    }
  }
  return overlaps;
}

export function audioRegionAtTimeline(project, timelineMs) {
  const target = Math.round(finiteNumber(timelineMs));
  return (project?.audioRegions || [])
    .map((region) => ({ region, range: audioRegionTimelineRange(project, region) }))
    .find(({ range }) => range && target >= range.startMs && target < range.endMs)
    ?.region || null;
}

export function findAudioRegionOverlaps(project) {
  const regions = (project?.audioRegions || [])
    .map((region) => ({ region, range: audioRegionTimelineRange(project, region) }))
    .filter(({ range }) => range)
    .sort((a, b) => a.range.startMs - b.range.startMs);
  const overlaps = [];
  for (let leftIndex = 0; leftIndex < regions.length; leftIndex += 1) {
    const left = regions[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < regions.length; rightIndex += 1) {
      const right = regions[rightIndex];
      if (right.range.startMs >= left.range.endMs) {
        break;
      }
      if (
        right.region.clipId === left.region.clipId &&
        right.range.endMs > left.range.startMs
      ) {
        overlaps.push({
          firstRegionId: left.region.id,
          secondRegionId: right.region.id,
          startMs: Math.max(left.range.startMs, right.range.startMs),
          endMs: Math.min(left.range.endMs, right.range.endMs)
        });
      }
    }
  }
  return overlaps;
}

export function addSubtitleLane(project) {
  const subtitleLaneCount = clamp(
    Math.round(finiteNumber(project?.subtitleLaneCount, MIN_SUBTITLE_LANES)) + 1,
    MIN_SUBTITLE_LANES,
    MAX_SUBTITLE_LANES
  );
  if (subtitleLaneCount === project.subtitleLaneCount) {
    return project;
  }
  return { ...project, subtitleLaneCount, updatedAt: nowIso() };
}

export function updateSubtitleCue(project, cueId, patch = {}, { markHuman = true } = {}) {
  const index = project.subtitles.findIndex((cue) => cue.id === cueId);
  if (index < 0) {
    return project;
  }
  const current = project.subtitles[index];
  const clip = project.clips.find((candidate) => candidate.id === current.clipId);
  const next = normalizeSubtitleCue({
    ...current,
    ...patch,
    humanEdited: markHuman ? true : current.humanEdited,
    updatedAt: nowIso()
  }, clip, project.subtitleLaneCount ?? MIN_SUBTITLE_LANES);
  const subtitles = [...project.subtitles];
  subtitles[index] = next;
  return { ...project, subtitles, selectedCueId: cueId, updatedAt: nowIso() };
}

export function deleteSubtitleCue(project, cueId) {
  return {
    ...project,
    subtitles: project.subtitles.filter((cue) => cue.id !== cueId),
    selectedCueId: project.selectedCueId === cueId ? null : project.selectedCueId,
    updatedAt: nowIso()
  };
}

const PRIMARY_AI_SPEAKER_IDS = new Set([
  "",
  "host",
  "main",
  "primary",
  "speaker",
  "speaker-0",
  "speaker_0",
  "streamer",
  "unknown",
  "화자0",
  "화자-0",
  "화자_0"
]);

function aiCaptionStackPriority(cue) {
  const speakerId = String(cue?.remoteMeta?.speakerId || "")
    .trim()
    .toLowerCase();
  return PRIMARY_AI_SPEAKER_IDS.has(speakerId) ? 0 : 1;
}

export function replaceAiSubtitleDraft(project, clipId, drafts = []) {
  const clip = project.clips.find((candidate) => candidate.id === clipId);
  if (!clip) {
    return project;
  }
  const preserved = project.subtitles.filter((cue) => (
    cue.clipId !== clipId || cue.origin !== "ai" || cue.humanEdited
  ));
  const protectedInClip = preserved.filter((cue) => cue.clipId === clipId);
  const normalizedDrafts = drafts
    .filter((draft) => String(draft?.text || "").trim())
    .map((draft) => createSubtitleCue(project, {
      ...draft,
      clipId,
      lane: 0,
      origin: "ai"
    }))
    .sort((a, b) => (
      a.startOffsetMs - b.startOffsetMs ||
      a.endOffsetMs - b.endOffsetMs ||
      aiCaptionStackPriority(a) - aiCaptionStackPriority(b) ||
      a.id.localeCompare(b.id)
    ));
  const overlaps = (first, second) => (
    Math.max(first.startOffsetMs, second.startOffsetMs) <
    Math.min(first.endOffsetMs, second.endOffsetMs)
  );
  let subtitleLaneCount = clamp(
    Math.round(finiteNumber(project.subtitleLaneCount, MIN_SUBTITLE_LANES)),
    MIN_SUBTITLE_LANES,
    MAX_SUBTITLE_LANES
  );
  const laneCues = Array.from(
    { length: MAX_SUBTITLE_LANES },
    () => []
  );
  const speakerLanes = new Map();
  for (const cue of protectedInClip) {
    laneCues[cue.lane]?.push(cue);
    const speakerId = String(cue.remoteMeta?.speakerId || "").trim();
    if (speakerId && speakerId !== "unknown" && !speakerLanes.has(speakerId)) {
      speakerLanes.set(speakerId, cue.lane);
    }
  }
  const aiCues = [];
  for (const candidate of normalizedDrafts) {
    const speakerId = String(candidate.remoteMeta?.speakerId || "").trim();
    const preferredLane = speakerLanes.get(speakerId);
    const candidateLanes = [
      ...(Number.isInteger(preferredLane) ? [preferredLane] : []),
      ...Array.from({ length: subtitleLaneCount }, (_, lane) => lane)
    ].filter((lane, index, lanes) => lanes.indexOf(lane) === index);
    let lane = candidateLanes.find((candidateLane) => (
      !laneCues[candidateLane].some((cue) => overlaps(cue, candidate))
    ));
    if (lane === undefined && subtitleLaneCount < MAX_SUBTITLE_LANES) {
      lane = subtitleLaneCount;
      subtitleLaneCount += 1;
    }
    if (lane === undefined) {
      throw new Error(
        `동시에 표시할 자막이 ${MAX_SUBTITLE_LANES}개 레인을 넘었습니다. 해당 구간을 먼저 검수해 주세요.`
      );
    }
    const assigned = { ...candidate, lane };
    aiCues.push(assigned);
    laneCues[lane].push(assigned);
    if (speakerId && speakerId !== "unknown" && !speakerLanes.has(speakerId)) {
      speakerLanes.set(speakerId, lane);
    }
  }
  const subtitles = [...preserved, ...aiCues].sort((a, b) => {
    const clipA = project.clips.find((candidate) => candidate.id === a.clipId);
    const clipB = project.clips.find((candidate) => candidate.id === b.clipId);
    return (clipA?.timelineStartMs || 0) + a.startOffsetMs - ((clipB?.timelineStartMs || 0) + b.startOffsetMs);
  });
  return {
    ...project,
    subtitleLaneCount,
    subtitles,
    selectedCueId: subtitles.some((cue) => cue.id === project.selectedCueId)
      ? project.selectedCueId
      : aiCues[0]?.id || protectedInClip[0]?.id || null,
    updatedAt: nowIso()
  };
}

export function appendAiSubtitleDrafts(project, drafts = []) {
  if (!project || !Array.isArray(project.clips) || !Array.isArray(project.subtitles)) {
    return project;
  }
  const clipsById = new Map(project.clips.map((clip) => [clip.id, clip]));
  const existingById = new Map(project.subtitles.map((cue) => [cue.id, cue]));
  const acceptedIds = new Set(existingById.keys());
  const draftsByClip = new Map();
  for (const draft of Array.isArray(drafts) ? drafts : []) {
    const clipId = String(draft?.clipId || "");
    if (!clipsById.has(clipId) || !String(draft?.text || "").trim()) {
      continue;
    }
    const requestedId = String(draft?.id || "").trim();
    if (requestedId && acceptedIds.has(requestedId)) {
      continue;
    }
    if (requestedId) {
      acceptedIds.add(requestedId);
    }
    const clipDrafts = draftsByClip.get(clipId) || [];
    clipDrafts.push(draft);
    draftsByClip.set(clipId, clipDrafts);
  }
  if (draftsByClip.size === 0) {
    return project;
  }

  const selectedCueId = project.selectedCueId;
  let next = {
    ...project,
    // Mark copies as protected only while assigning lanes. The originals are
    // restored below so a local first pass can never change user-owned cues.
    subtitles: project.subtitles.map((cue) => ({
      ...cue,
      humanEdited: true
    }))
  };
  for (const clip of project.clips) {
    const clipDrafts = draftsByClip.get(clip.id);
    if (clipDrafts?.length) {
      next = replaceAiSubtitleDraft(next, clip.id, clipDrafts);
    }
  }
  const subtitles = next.subtitles.map((cue) => (
    existingById.get(cue.id) || cue
  ));
  return {
    ...next,
    subtitles,
    selectedCueId: subtitles.some((cue) => cue.id === selectedCueId)
      ? selectedCueId
      : next.selectedCueId,
    updatedAt: nowIso()
  };
}

export function transcriptChunksToCueDrafts(chunks = [], clipDuration = 0, {
  maxCharacters = 26,
  maxDurationMs = 4_000,
  gapBreakMs = 800,
  minimumDurationMs = 650
} = {}) {
  const clipDurationMs = Math.max(MIN_CUE_DURATION_MS, Math.round(finiteNumber(clipDuration)));
  const boundedMaxDurationMs = Math.max(
    MIN_CUE_DURATION_MS,
    Math.round(finiteNumber(maxDurationMs, 4_000))
  );
  const words = chunks.flatMap((chunk) => {
    const text = String(chunk?.text || "").trim();
    if (!text) {
      return [];
    }
    const start = secondsToMilliseconds(chunk?.timestamp?.[0]);
    const rawEnd = chunk?.timestamp?.[1];
    const end = rawEnd === null || rawEnd === undefined
      ? Math.min(clipDurationMs, start + minimumDurationMs)
      : secondsToMilliseconds(rawEnd);
    const startMs = clamp(
      start,
      0,
      Math.max(0, clipDurationMs - MIN_CUE_DURATION_MS)
    );
    return [{
      text,
      startMs,
      endMs: clamp(
        Math.max(startMs + MIN_CUE_DURATION_MS, end),
        startMs + MIN_CUE_DURATION_MS,
        clipDurationMs
      )
    }];
  }).sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);

  const drafts = [];
  let group = [];
  const flush = () => {
    if (group.length === 0) {
      return;
    }
    const startOffsetMs = group[0].startMs;
    const naturalEnd = group.at(-1).endMs;
    const nextStart = words[words.indexOf(group.at(-1)) + 1]?.startMs;
    const paddedEnd = Math.min(
      clipDurationMs,
      Math.max(naturalEnd, startOffsetMs + minimumDurationMs),
      nextStart === undefined ? clipDurationMs : Math.max(naturalEnd, nextStart - 40)
    );
    drafts.push({
      startOffsetMs,
      endOffsetMs: Math.max(startOffsetMs + MIN_CUE_DURATION_MS, paddedEnd),
      text: group.map((word, index) => {
        if (index === 0) {
          return word.text;
        }
        const previous = group[index - 1].text;
        const noLeadingSpace = /^[,.:;!?%)\]}〉》」』…]/u.test(word.text);
        const noTrailingSpace = /[(\[{〈《「『]$/u.test(previous);
        return `${noLeadingSpace || noTrailingSpace ? "" : " "}${word.text}`;
      }).join("")
    });
    group = [];
  };

  words.forEach((word) => {
    if (group.length === 0) {
      group.push(word);
      return;
    }
    const first = group[0];
    const previous = group.at(-1);
    const proposedText = `${group.map((item) => item.text).join(" ")} ${word.text}`.trim();
    const shouldBreak = (
      word.startMs - previous.endMs >= gapBreakMs ||
      word.endMs - first.startMs > boundedMaxDurationMs ||
      proposedText.length > maxCharacters ||
      /[.!?。！？…]$/u.test(previous.text)
    );
    if (shouldBreak) {
      flush();
    }
    group.push(word);
  });
  flush();
  const splitTextIntoParts = (text, requestedParts) => {
    if (requestedParts <= 1) {
      return [text];
    }
    const wordsInText = text.split(/\s+/u).filter(Boolean);
    const units = wordsInText.length >= requestedParts
      ? wordsInText
      : Array.from(text);
    const separator = wordsInText.length >= requestedParts ? " " : "";
    const partCount = Math.max(1, Math.min(requestedParts, units.length));
    return Array.from({ length: partCount }, (_, index) => {
      const from = Math.floor(index * units.length / partCount);
      const to = Math.floor((index + 1) * units.length / partCount);
      return units.slice(from, to).join(separator).trim();
    }).filter(Boolean);
  };
  const durationBoundedDrafts = drafts.flatMap((draft) => {
    const durationMs = draft.endOffsetMs - draft.startOffsetMs;
    if (durationMs <= boundedMaxDurationMs) {
      return [draft];
    }
    const requestedParts = Math.ceil(durationMs / boundedMaxDurationMs);
    const textParts = splitTextIntoParts(draft.text, requestedParts);
    const slotDurationMs = Math.min(
      boundedMaxDurationMs,
      durationMs / textParts.length
    );
    const availableGapMs = Math.max(
      0,
      durationMs - slotDurationMs * textParts.length
    );
    return textParts.map((text, index) => {
      const gapBeforeMs = textParts.length <= 1
        ? 0
        : availableGapMs * index / (textParts.length - 1);
      const startOffsetMs = Math.round(
        draft.startOffsetMs + index * slotDurationMs + gapBeforeMs
      );
      return {
        ...draft,
        startOffsetMs,
        endOffsetMs: Math.min(
          draft.endOffsetMs,
          startOffsetMs + boundedMaxDurationMs
        ),
        text
      };
    });
  });
  const nonOverlapping = [];
  for (const draft of durationBoundedDrafts) {
    const previous = nonOverlapping.at(-1);
    if (!previous || draft.startOffsetMs >= previous.endOffsetMs) {
      nonOverlapping.push(draft);
      continue;
    }
    const availableDuration = draft.endOffsetMs - previous.endOffsetMs;
    if (availableDuration >= MIN_CUE_DURATION_MS) {
      nonOverlapping.push({
        ...draft,
        startOffsetMs: previous.endOffsetMs
      });
      continue;
    }
    previous.text = `${previous.text} ${draft.text}`.trim();
    previous.endOffsetMs = Math.min(
      previous.startOffsetMs + boundedMaxDurationMs,
      Math.max(previous.endOffsetMs, draft.endOffsetMs)
    );
  }
  return nonOverlapping;
}

export function updateClipTrim(project, clipId, {
  sourceStartMs,
  sourceEndMs
} = {}) {
  const index = project.clips.findIndex((clip) => clip.id === clipId);
  if (index < 0) {
    return project;
  }
  const current = project.clips[index];
  const start = Math.max(0, Math.round(finiteNumber(sourceStartMs, current.sourceStartMs)));
  const end = Math.max(start + MIN_CLIP_DURATION_MS, Math.round(finiteNumber(sourceEndMs, current.sourceEndMs)));
  const nextClips = [...project.clips];
  const nextClip = { ...current, sourceStartMs: start, sourceEndMs: end, updatedAt: nowIso() };
  nextClips[index] = nextClip;
  const clips = reflowClips(nextClips);
  const subtitles = project.subtitles.flatMap((cue) => {
    if (cue.clipId !== clipId) {
      return [cue];
    }
    const cueSourceStart = current.sourceStartMs + cue.startOffsetMs;
    const cueSourceEnd = current.sourceStartMs + cue.endOffsetMs;
    const overlapStart = Math.max(start, cueSourceStart);
    const overlapEnd = Math.min(end, cueSourceEnd);
    if (overlapEnd - overlapStart < MIN_CUE_DURATION_MS) {
      return [];
    }
    return [normalizeSubtitleCue({
      ...cue,
      startOffsetMs: overlapStart - start,
      endOffsetMs: overlapEnd - start
    }, nextClip, project.subtitleLaneCount ?? MIN_SUBTITLE_LANES)];
  });
  const audioRegions = project.audioRegions.flatMap((region) => {
    if (region.clipId !== clipId) {
      return [region];
    }
    const regionSourceStart = current.sourceStartMs + region.startOffsetMs;
    const regionSourceEnd = current.sourceStartMs + region.endOffsetMs;
    const overlapStart = Math.max(start, regionSourceStart);
    const overlapEnd = Math.min(end, regionSourceEnd);
    if (overlapEnd - overlapStart < MIN_CUE_DURATION_MS) {
      return [];
    }
    return [normalizeAudioRegion({
      ...region,
      startOffsetMs: overlapStart - start,
      endOffsetMs: overlapEnd - start
    }, nextClip)];
  });
  const imageAssets = (project.imageAssets || []).flatMap((asset) => {
    if (asset.clipId !== clipId) {
      return [asset];
    }
    const assetSourceStart = current.sourceStartMs + asset.startOffsetMs;
    const assetSourceEnd = current.sourceStartMs + asset.endOffsetMs;
    const overlapStart = Math.max(start, assetSourceStart);
    const overlapEnd = Math.min(end, assetSourceEnd);
    if (overlapEnd - overlapStart < MIN_CUE_DURATION_MS) {
      return [];
    }
    const next = normalizeImageAsset({
      ...asset,
      startOffsetMs: overlapStart - start,
      endOffsetMs: overlapEnd - start
    }, nextClip);
    return next ? [next] : [];
  });
  const selectedCueId = subtitles.some((cue) => cue.id === project.selectedCueId)
    ? project.selectedCueId
    : null;
  const selectedAudioRegionId = audioRegions.some((region) => (
    region.id === project.selectedAudioRegionId
  ))
    ? project.selectedAudioRegionId
    : null;
  const selectedImageAssetId = imageAssets.some((asset) => (
    asset.id === project.selectedImageAssetId
  ))
    ? project.selectedImageAssetId
    : null;
  return {
    ...project,
    clips,
    subtitles,
    audioRegions,
    imageAssets,
    selectedCueId,
    selectedAudioRegionId,
    selectedImageAssetId,
    updatedAt: nowIso()
  };
}

export function rippleDeleteTimelineRange(project, {
  startMs,
  endMs
} = {}) {
  const numericStartMs = Number(startMs);
  const numericEndMs = Number(endMs);
  if (!Number.isFinite(numericStartMs) || !Number.isFinite(numericEndMs)) {
    throw new TypeError("삭제할 타임라인 구간의 시작과 끝 시각이 필요합니다.");
  }
  const start = Math.round(numericStartMs);
  const end = Math.round(numericEndMs);
  const duration = projectDurationMs(project);
  if (start < 0 || end > duration || end - start < MIN_CLIP_DURATION_MS) {
    throw new RangeError(
      "삭제 구간은 타임라인 안에서 0.1초 이상이어야 합니다."
    );
  }

  const timestamp = nowIso();
  const usedClipIds = new Set((project.clips || []).map((clip) => clip.id));
  const makeUniqueClipId = () => {
    let id = makeId("clip");
    while (usedClipIds.has(id)) {
      id = makeId("clip");
    }
    usedClipIds.add(id);
    return id;
  };
  const slicesByClipId = new Map();
  const nextClips = [];

  for (const clip of project.clips || []) {
    const clipDuration = clipDurationMs(clip);
    const slices = [];
    const appendSlice = (oldStartOffsetMs, oldEndOffsetMs, {
      changed = true
    } = {}) => {
      const sliceIndex = slices.length;
      const id = sliceIndex === 0 ? clip.id : makeUniqueClipId();
      const nextClip = changed
        ? {
          ...clip,
          id,
          sourceStartMs: clip.sourceStartMs + oldStartOffsetMs,
          sourceEndMs: clip.sourceStartMs + oldEndOffsetMs,
          createdAt: id === clip.id ? clip.createdAt : timestamp,
          updatedAt: timestamp
        }
        : clip;
      slices.push({
        oldStartOffsetMs,
        oldEndOffsetMs,
        nextClip
      });
      nextClips.push(nextClip);
    };

    if (clip.enabled === false) {
      appendSlice(0, clipDuration, { changed: false });
      slicesByClipId.set(clip.id, slices);
      continue;
    }

    const clipTimelineStartMs = clip.timelineStartMs;
    const clipTimelineEndMs = clipTimelineStartMs + clipDuration;
    const overlapStartMs = Math.max(start, clipTimelineStartMs);
    const overlapEndMs = Math.min(end, clipTimelineEndMs);
    if (overlapEndMs <= overlapStartMs) {
      appendSlice(0, clipDuration, { changed: false });
      slicesByClipId.set(clip.id, slices);
      continue;
    }

    const localDeleteStartMs = overlapStartMs - clipTimelineStartMs;
    const localDeleteEndMs = overlapEndMs - clipTimelineStartMs;
    const keptRanges = [
      [0, localDeleteStartMs],
      [localDeleteEndMs, clipDuration]
    ].filter(([rangeStartMs, rangeEndMs]) => rangeEndMs > rangeStartMs);
    const tooShort = keptRanges.find(([rangeStartMs, rangeEndMs]) => (
      rangeEndMs - rangeStartMs < MIN_CLIP_DURATION_MS
    ));
    if (tooShort) {
      throw new RangeError(
        "삭제 뒤 남는 영상 조각은 각각 0.1초 이상이어야 합니다."
      );
    }
    keptRanges.forEach(([rangeStartMs, rangeEndMs]) => {
      appendSlice(rangeStartMs, rangeEndMs);
    });
    slicesByClipId.set(clip.id, slices);
  }

  const clips = reflowClips(nextClips);
  const reflowedByClipId = new Map(clips.map((clip) => [clip.id, clip]));
  slicesByClipId.forEach((slices) => {
    slices.forEach((slice) => {
      slice.nextClip = reflowedByClipId.get(slice.nextClip.id);
    });
  });

  const remapTimedItems = (items, {
    idPrefix,
    normalize,
    patchFragment = () => ({})
  }) => (items || []).flatMap((item) => {
    const slices = slicesByClipId.get(item.clipId) || [];
    const fragments = slices.flatMap((slice) => {
      const overlapStartMs = Math.max(item.startOffsetMs, slice.oldStartOffsetMs);
      const overlapEndMs = Math.min(item.endOffsetMs, slice.oldEndOffsetMs);
      if (overlapEndMs - overlapStartMs < MIN_CUE_DURATION_MS) {
        return [];
      }
      return [{
        slice,
        overlapStartMs,
        overlapEndMs,
        startOffsetMs: overlapStartMs - slice.oldStartOffsetMs,
        endOffsetMs: overlapEndMs - slice.oldStartOffsetMs
      }];
    });
    return fragments.flatMap((fragment, fragmentIndex) => {
      const preserveId = fragmentIndex === 0;
      const unchanged = (
        fragments.length === 1 &&
        fragment.slice.nextClip.id === item.clipId &&
        fragment.startOffsetMs === item.startOffsetMs &&
        fragment.endOffsetMs === item.endOffsetMs
      );
      if (unchanged) {
        return [item];
      }
      const raw = {
        ...item,
        ...patchFragment(item, fragment),
        id: preserveId ? item.id : makeId(idPrefix),
        clipId: fragment.slice.nextClip.id,
        startOffsetMs: fragment.startOffsetMs,
        endOffsetMs: fragment.endOffsetMs,
        createdAt: preserveId ? item.createdAt : timestamp,
        updatedAt: timestamp
      };
      const normalized = normalize(raw, fragment.slice.nextClip);
      return normalized ? [normalized] : [];
    });
  });

  const subtitles = remapTimedItems(project.subtitles, {
    idPrefix: "cue",
    normalize: (cue, clip) => normalizeSubtitleCue(
      cue,
      clip,
      project.subtitleLaneCount ?? MIN_SUBTITLE_LANES
    )
  });
  const imageAssets = remapTimedItems(project.imageAssets, {
    idPrefix: "asset",
    normalize: normalizeImageAsset
  });
  const audioRegions = remapTimedItems(project.audioRegions, {
    idPrefix: "audio",
    normalize: normalizeAudioRegion,
    patchFragment: (region, fragment) => ({
      fadeInMs: fragment.overlapStartMs === region.startOffsetMs
        ? region.fadeInMs
        : 0,
      fadeOutMs: fragment.overlapEndMs === region.endOffsetMs
        ? region.fadeOutMs
        : 0
    })
  });

  const previousPlayheadMs = clamp(
    Math.round(finiteNumber(project.playheadMs)),
    0,
    duration
  );
  const deletedDurationMs = end - start;
  const playheadMs = clamp(
    previousPlayheadMs <= start
      ? previousPlayheadMs
      : previousPlayheadMs < end
        ? start
        : previousPlayheadMs - deletedDurationMs,
    0,
    projectDurationMs({ clips })
  );
  const projectWithClips = { ...project, clips };
  const selectedClipId = clips.some((clip) => clip.id === project.selectedClipId)
    ? project.selectedClipId
    : mapTimelineToSource(projectWithClips, playheadMs)?.clipId
      || clips[0]?.id
      || null;
  const survivingSelectionIds = new Set(clips.map((clip) => clip.selectionId));
  const suppressedBySelectionId = new Map();
  for (const entry of project.suppressedSelections || []) {
    const suppressed = normalizeSuppressedSelection(entry);
    if (suppressed && !survivingSelectionIds.has(suppressed.selectionId)) {
      suppressedBySelectionId.set(suppressed.selectionId, suppressed);
    }
  }
  const previousClipsBySelection = new Map();
  for (const clip of project.clips || []) {
    const selectionId = String(clip.selectionId || "").trim();
    if (!selectionId) {
      continue;
    }
    const group = previousClipsBySelection.get(selectionId) || [];
    group.push(clip);
    previousClipsBySelection.set(selectionId, group);
  }
  const alignmentOffsetMs = Math.round(finiteNumber(
    project.broadcastSession?.alignmentOffsetMs
  ));
  previousClipsBySelection.forEach((previousClips, selectionId) => {
    if (survivingSelectionIds.has(selectionId)) {
      suppressedBySelectionId.delete(selectionId);
      return;
    }
    const [representative] = previousClips;
    const previous = suppressedBySelectionId.get(selectionId);
    const suppressed = normalizeSuppressedSelection({
      ...previous,
      selectionId,
      selectionStartMs: Math.round(finiteNumber(
        representative.selectionStartMs,
        representative.sourceStartMs - alignmentOffsetMs
      )),
      selectionEndMs: Math.round(finiteNumber(
        representative.selectionEndMs,
        representative.sourceEndMs - alignmentOffsetMs
      )),
      note: representative.note,
      createdAt: previous?.createdAt || timestamp,
      updatedAt: timestamp
    });
    if (suppressed) {
      suppressedBySelectionId.set(selectionId, suppressed);
    }
  });
  const suppressedSelections = [...suppressedBySelectionId.values()];

  return {
    ...project,
    clips,
    suppressedSelections,
    subtitles,
    imageAssets,
    audioRegions,
    selectedClipId,
    selectedCueId: subtitles.some((cue) => cue.id === project.selectedCueId)
      ? project.selectedCueId
      : null,
    selectedImageAssetId: imageAssets.some((asset) => (
      asset.id === project.selectedImageAssetId
    ))
      ? project.selectedImageAssetId
      : null,
    selectedAudioRegionId: audioRegions.some((region) => (
      region.id === project.selectedAudioRegionId
    ))
      ? project.selectedAudioRegionId
      : null,
    playheadMs,
    updatedAt: timestamp
  };
}

export function reorderClip(project, clipId, toIndex) {
  const fromIndex = project.clips.findIndex((clip) => clip.id === clipId);
  const target = clamp(Math.round(finiteNumber(toIndex)), 0, Math.max(0, project.clips.length - 1));
  if (fromIndex < 0 || fromIndex === target) {
    return project;
  }
  const clips = [...project.clips];
  const [moved] = clips.splice(fromIndex, 1);
  clips.splice(target, 0, moved);
  return { ...project, clips: reflowClips(clips), updatedAt: nowIso() };
}

function movableClipIdSet(clips, selectedClipIds) {
  const requested = selectedClipIds instanceof Set
    ? selectedClipIds
    : new Set(Array.isArray(selectedClipIds) ? selectedClipIds : []);
  return new Set(
    clips
      .filter((clip) => requested.has(clip.id))
      .map((clip) => clip.id)
  );
}

export function canReorderClipGroup(clips = [], selectedClipIds = [], direction = 0) {
  const selected = movableClipIdSet(clips, selectedClipIds);
  if (selected.size === 0 || (direction !== -1 && direction !== 1)) {
    return false;
  }
  if (direction < 0) {
    return clips.some((clip, index) => (
      index > 0 &&
      selected.has(clip.id) &&
      !selected.has(clips[index - 1].id)
    ));
  }
  return clips.some((clip, index) => (
    index < clips.length - 1 &&
    selected.has(clip.id) &&
    !selected.has(clips[index + 1].id)
  ));
}

export function reorderClipGroup(project, selectedClipIds = [], direction = 0) {
  const clips = [...(project?.clips || [])];
  const selected = movableClipIdSet(clips, selectedClipIds);
  if (!canReorderClipGroup(clips, selected, direction)) {
    return project;
  }
  if (direction < 0) {
    for (let index = 1; index < clips.length; index += 1) {
      if (
        selected.has(clips[index].id) &&
        !selected.has(clips[index - 1].id)
      ) {
        [clips[index - 1], clips[index]] = [clips[index], clips[index - 1]];
      }
    }
  } else {
    for (let index = clips.length - 2; index >= 0; index -= 1) {
      if (
        selected.has(clips[index].id) &&
        !selected.has(clips[index + 1].id)
      ) {
        [clips[index], clips[index + 1]] = [clips[index + 1], clips[index]];
      }
    }
  }
  return {
    ...project,
    clips: reflowClips(clips),
    updatedAt: nowIso()
  };
}

export function applyMediaAlignmentOffset(project, alignmentOffsetMs) {
  const nextOffset = Math.round(finiteNumber(alignmentOffsetMs));
  const currentOffset = Math.round(finiteNumber(project?.broadcastSession?.alignmentOffsetMs));
  const delta = nextOffset - currentOffset;
  if (delta === 0 && project.broadcastSession?.alignmentConfirmed) {
    return project;
  }
  const clips = project.clips.map((clip) => {
    const sourceStartMs = clip.sourceStartMs + delta;
    const sourceEndMs = clip.sourceEndMs + delta;
    if (sourceStartMs < 0 || sourceEndMs <= sourceStartMs) {
      throw new Error("정렬 오프셋을 적용하면 선택 구간이 원본 시작보다 앞으로 넘어갑니다.");
    }
    return {
      ...clip,
      sourceStartMs,
      sourceEndMs,
      updatedAt: nowIso()
    };
  });
  return {
    ...project,
    broadcastSession: {
      ...project.broadcastSession,
      alignmentOffsetMs: nextOffset,
      alignmentConfirmed: true
    },
    clips: reflowClips(clips),
    updatedAt: nowIso()
  };
}

export function serializeSrt(project) {
  const cues = (project?.subtitles || [])
    .map((cue) => ({ cue, range: cueTimelineRange(project, cue) }))
    .filter(({ cue, range }) => range && cue.text.trim())
    .sort((a, b) => a.range.startMs - b.range.startMs);
  const formatSrtTime = (milliseconds) => {
    const value = Math.max(0, Math.round(milliseconds));
    const hours = Math.floor(value / 3_600_000);
    const minutes = Math.floor((value % 3_600_000) / 60_000);
    const seconds = Math.floor((value % 60_000) / 1000);
    const millis = value % 1000;
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")},${String(millis).padStart(3, "0")}`;
  };
  return cues.map(({ cue, range }, index) => [
    index + 1,
    `${formatSrtTime(range.startMs)} --> ${formatSrtTime(range.endMs)}`,
    cue.text,
    ""
  ].join("\n")).join("\n");
}
