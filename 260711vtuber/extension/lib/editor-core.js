export const EDITOR_SCHEMA = "chzzk-kirinuki-editor/v2";
export const EDITOR_PROJECTS_STORE_KEY = "chzzkKirinukiEditorProjectsV1";
export const EDITOR_SEED_PREFIX = "chzzkKirinukiEditorSeed:";
export const EDITOR_DATABASE_NAME = "chzzk-kirinuki-studio";
export const MIN_SUBTITLE_LANES = 2;
export const MAX_SUBTITLE_LANES = 8;

const MIN_CLIP_DURATION_MS = 100;
const MIN_CUE_DURATION_MS = 100;
const LEGACY_EDITOR_SCHEMA = "chzzk-kirinuki-editor/v1";

const nowIso = () => new Date().toISOString();
const makeId = (prefix) => `${prefix}-${crypto.randomUUID()}`;

const finiteNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const secondsToMilliseconds = (seconds) => Math.max(0, Math.round(finiteNumber(seconds) * 1000));
export const millisecondsToSeconds = (milliseconds) => Math.max(0, finiteNumber(milliseconds) / 1000);
export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

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
  const channelId = String(source.channelId ?? "").trim();
  const startedAt = String(source.broadcastStartedAt ?? "").trim();
  const contentId = String(source.contentId ?? "").trim();
  const contentType = String(source.contentType ?? "unknown").trim();

  if (channelId && startedAt) {
    return `broadcast:${channelId}:${startedAt}`;
  }
  if (contentId) {
    return `${contentType}:${contentId}`;
  }
  if (channelId) {
    return `${contentType}:${channelId}`;
  }
  return String(source.canonicalUrl || source.url || "").trim();
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
    previousIdentity !== nextIdentity
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
    subtitles: [],
    subtitleLaneCount: MIN_SUBTITLE_LANES,
    audioRegions: [],
    selectedClipId: clips[0]?.id || null,
    selectedCueId: null,
    selectedAudioRegionId: null,
    playheadMs: 0,
    subtitleDefaults: {
      x: 0.5,
      y: 0.84,
      maxWidth: 0.86,
      fontScale: 0.052,
      fontFamily: "Pretendard",
      fontWeight: 800,
      color: "#ffffff",
      outlineColor: "#111111",
      outlineWidth: 0.006,
      backgroundColor: "transparent",
      align: "center"
    },
    ai: {
      provider: "transformers.js",
      model: "Xenova/whisper-tiny",
      language: "korean",
      status: "idle",
      progress: 0,
      lastRunAt: null,
      error: null
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
  if (!raw || ![EDITOR_SCHEMA, LEGACY_EDITOR_SCHEMA].includes(raw.schema)) {
    return null;
  }
  const migratingLegacyProject = raw.schema === LEGACY_EDITOR_SCHEMA;
  const clips = reflowClips(Array.isArray(raw.clips) ? raw.clips : []);
  const defaults = createEditorProjectFromCapture({}, {
    id: raw.id || makeId("project"),
    createdAt: raw.createdAt || nowIso()
  });
  const clipIds = new Set(clips.map((clip) => clip.id));
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
  const subtitleDefaults = {
    ...defaults.subtitleDefaults,
    ...(raw.subtitleDefaults || {}),
    fontFamily: "Pretendard",
    fontWeight: 800,
    color: subtitleColor,
    outlineColor: normalizeHexColor(
      raw.subtitleDefaults?.outlineColor,
      defaults.subtitleDefaults.outlineColor
    ),
    backgroundColor: migratingLegacyProject
      ? "transparent"
      : String(raw.subtitleDefaults?.backgroundColor || defaults.subtitleDefaults.backgroundColor)
  };

  return {
    ...defaults,
    ...raw,
    schema: EDITOR_SCHEMA,
    source: { ...defaults.source, ...(raw.source || {}) },
    broadcastSession: { ...defaults.broadcastSession, ...(raw.broadcastSession || {}) },
    mediaAsset: normalizeMediaAsset(raw.mediaAsset),
    subtitleDefaults,
    ai: { ...defaults.ai, ...(raw.ai || {}) },
    history: {
      undo: Array.isArray(raw.history?.undo) ? raw.history.undo : [],
      redo: Array.isArray(raw.history?.redo) ? raw.history.redo : []
    },
    clips,
    subtitles,
    subtitleLaneCount,
    audioRegions,
    selectedAudioRegionId: audioRegions.some((region) => region.id === raw.selectedAudioRegionId)
      ? raw.selectedAudioRegionId
      : null
  };
}

export function mergeCaptureIntoEditorProject(project, captureState = {}) {
  const normalized = normalizeEditorProject(project) || createEditorProjectFromCapture(captureState);
  const alignmentOffsetMs = Math.round(finiteNumber(normalized.broadcastSession?.alignmentOffsetMs));
  const incomingClips = (captureState.segments || []).map(segmentToClip).map((clip) => {
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
  const retainedClips = normalized.clips.flatMap((existing) => {
    const incoming = incomingBySelection.get(existing.selectionId);
    if (!incoming) {
      return [];
    }
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
    const capturedBoundaryUnchanged = (
      previousSelectionStartMs === incoming.selectionStartMs &&
      previousSelectionEndMs === incoming.selectionEndMs
    );
    const overlapStartMs = Math.max(existing.sourceStartMs, incoming.sourceStartMs);
    const overlapEndMs = Math.min(existing.sourceEndMs, incoming.sourceEndMs);
    const canPreserveTrim = !stillAtCapturedBoundary && overlapEndMs - overlapStartMs >= MIN_CLIP_DURATION_MS;
    return [{
      ...incoming,
      ...existing,
      sourceStartMs: capturedBoundaryUnchanged
        ? existing.sourceStartMs
        : canPreserveTrim
          ? overlapStartMs
          : incoming.sourceStartMs,
      sourceEndMs: capturedBoundaryUnchanged
        ? existing.sourceEndMs
        : canPreserveTrim
          ? overlapEndMs
          : incoming.sourceEndMs,
      selectionStartMs: incoming.selectionStartMs,
      selectionEndMs: incoming.selectionEndMs,
      note: incoming.note,
      capture: incoming.capture,
      updatedAt: nowIso()
    }];
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
  const source = { ...normalized.source, ...(captureState.source || {}) };
  const incomingSession = createBroadcastSession(source);

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
      alignmentConfirmed: normalized.broadcastSession?.alignmentConfirmed || source.contentType === "vod"
    },
    clips: reflowedClips,
    subtitles,
    audioRegions,
    selectedClipId: nextClipIds.has(normalized.selectedClipId)
      ? normalized.selectedClipId
      : nextClips[0]?.id || null,
    selectedCueId: subtitles.some((cue) => cue.id === normalized.selectedCueId)
      ? normalized.selectedCueId
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
    x: clamp(finiteNumber(cue.x, 0.5), 0.05, 0.95),
    y: clamp(finiteNumber(cue.y, 0.84), 0.05, 0.95),
    origin: cue.origin === "ai" ? "ai" : "human",
    humanEdited: Boolean(cue.humanEdited),
    confidence: Number.isFinite(cue.confidence) ? cue.confidence : null,
    createdAt: cue.createdAt || nowIso(),
    updatedAt: cue.updatedAt || cue.createdAt || nowIso()
  };
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
    createdAt,
    updatedAt: createdAt
  }, clip, project.subtitleLaneCount ?? MIN_SUBTITLE_LANES);
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

export function replaceAiSubtitleDraft(project, clipId, drafts = []) {
  const clip = project.clips.find((candidate) => candidate.id === clipId);
  if (!clip) {
    return project;
  }
  const preserved = project.subtitles.filter((cue) => (
    cue.clipId !== clipId || cue.origin !== "ai" || cue.humanEdited
  ));
  const protectedInClip = preserved.filter((cue) => (
    cue.clipId === clipId && cue.lane === 0
  ));
  const overlapsProtectedCue = (draft) => protectedInClip.some((cue) => (
    Math.max(finiteNumber(draft.startOffsetMs), cue.startOffsetMs) <
    Math.min(finiteNumber(draft.endOffsetMs), cue.endOffsetMs)
  ));
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
      a.endOffsetMs - b.endOffsetMs
    ));
  const aiCues = [];
  for (const candidate of normalizedDrafts) {
    if (overlapsProtectedCue(candidate)) {
      continue;
    }
    const previous = aiCues.at(-1);
    if (!previous || candidate.startOffsetMs >= previous.endOffsetMs) {
      aiCues.push(candidate);
      continue;
    }
    const availableDuration = candidate.endOffsetMs - previous.endOffsetMs;
    if (availableDuration >= MIN_CUE_DURATION_MS) {
      aiCues.push({
        ...candidate,
        startOffsetMs: previous.endOffsetMs
      });
      continue;
    }
    previous.text = `${previous.text} ${candidate.text}`.trim();
    previous.endOffsetMs = Math.max(previous.endOffsetMs, candidate.endOffsetMs);
    previous.updatedAt = nowIso();
  }
  const subtitles = [...preserved, ...aiCues].sort((a, b) => {
    const clipA = project.clips.find((candidate) => candidate.id === a.clipId);
    const clipB = project.clips.find((candidate) => candidate.id === b.clipId);
    return (clipA?.timelineStartMs || 0) + a.startOffsetMs - ((clipB?.timelineStartMs || 0) + b.startOffsetMs);
  });
  return {
    ...project,
    subtitles,
    selectedCueId: subtitles.some((cue) => cue.id === project.selectedCueId)
      ? project.selectedCueId
      : aiCues[0]?.id || protectedInClip[0]?.id || null,
    updatedAt: nowIso()
  };
}

export function transcriptChunksToCueDrafts(chunks = [], clipDuration = 0, {
  maxCharacters = 26,
  maxDurationMs = 4_500,
  gapBreakMs = 800,
  minimumDurationMs = 650
} = {}) {
  const clipDurationMs = Math.max(MIN_CUE_DURATION_MS, Math.round(finiteNumber(clipDuration)));
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
      word.endMs - first.startMs > maxDurationMs ||
      proposedText.length > maxCharacters ||
      /[.!?。！？…]$/u.test(previous.text)
    );
    if (shouldBreak) {
      flush();
    }
    group.push(word);
  });
  flush();
  const nonOverlapping = [];
  for (const draft of drafts) {
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
    previous.endOffsetMs = Math.max(previous.endOffsetMs, draft.endOffsetMs);
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
  const selectedCueId = subtitles.some((cue) => cue.id === project.selectedCueId)
    ? project.selectedCueId
    : null;
  const selectedAudioRegionId = audioRegions.some((region) => (
    region.id === project.selectedAudioRegionId
  ))
    ? project.selectedAudioRegionId
    : null;
  return {
    ...project,
    clips,
    subtitles,
    audioRegions,
    selectedCueId,
    selectedAudioRegionId,
    updatedAt: nowIso()
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
