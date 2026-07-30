import {
  AUDSEG_DRAFT_MODEL,
  AUDSEG_ENGINE_VERSION,
  AUDSEG_PIPELINE_FINGERPRINT
} from "./audseg.js";

export const MAX_CAPTION_DRAFT_CUES_PER_RUN = 10_000;
export const AUDSEG_CHECKPOINT_QUALITY_PROFILE_ID = "kr-vtuber-clean-v1";
export const AUDSEG_CHECKPOINT_HARNESS_FINGERPRINT =
  "kr-vtuber-clean-v1:segment-word-v3:context-v1:quality-gate-v2";
export const AUDSEG_EDITORIAL_CONTEXT_FINGERPRINT =
  "audseg-no-editorial-context-v1";

const LEGACY_CAPTION_PIPELINE_FINGERPRINT = "legacy-caption-pipeline-v0";
const REQUIRED_CAPTION_PIPELINE_FINGERPRINT =
  "current-caption-pipeline-required-v1";
const DEFAULT_CHECKPOINT_LIMIT = 500;

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function captionCheckpointKey({
  clipId,
  sourceStartMs,
  sourceEndMs,
  model,
  qualityProfile,
  harnessFingerprint,
  editorialContextFingerprint,
  pipelineFingerprint
}) {
  return [
    String(clipId || ""),
    Math.round(finiteNumber(sourceStartMs, -1)),
    Math.round(finiteNumber(sourceEndMs, -1)),
    String(model || ""),
    String(qualityProfile || "legacy-unharnessed-v0"),
    String(harnessFingerprint || "legacy-harness-fingerprint-v0"),
    String(editorialContextFingerprint || "legacy-context-v0"),
    String(pipelineFingerprint || LEGACY_CAPTION_PIPELINE_FINGERPRINT)
  ].join("\u0000");
}

export function audSegDraftRuntimeIdentity() {
  return {
    provider: "local-audseg",
    engine: `audseg-${AUDSEG_ENGINE_VERSION}-dsp`,
    transcriptionMode: "browser-audio-activity",
    fingerprint: AUDSEG_PIPELINE_FINGERPRINT
  };
}

export function captionDraftRunEstimate(clips = []) {
  if (!Array.isArray(clips)) {
    throw new TypeError("자막 실행 예상량을 계산할 컷 배열이 필요합니다.");
  }
  const enabled = clips.filter((clip) => clip?.enabled !== false);
  const totalDurationMs = enabled.reduce((total, clip) => {
    const startMs = finiteNumber(clip?.sourceStartMs ?? clip?.startMs);
    const endMs = finiteNumber(clip?.sourceEndMs ?? clip?.endMs);
    return total + Math.max(0, Math.round(endMs - startMs));
  }, 0);
  return {
    clipCount: enabled.length,
    totalDurationMs,
    browserDrafts: enabled.length
  };
}

export function createCaptionDraftCheckpoint(
  clip,
  {
    requestId = "",
    completedAt = new Date().toISOString(),
    pipelineFingerprint = REQUIRED_CAPTION_PIPELINE_FINGERPRINT
  } = {}
) {
  const checkpoint = {
    clipId: String(clip?.id || ""),
    sourceStartMs: Math.round(finiteNumber(clip?.sourceStartMs, -1)),
    sourceEndMs: Math.round(finiteNumber(clip?.sourceEndMs, -1)),
    model: AUDSEG_DRAFT_MODEL,
    qualityProfile: AUDSEG_CHECKPOINT_QUALITY_PROFILE_ID,
    harnessFingerprint: AUDSEG_CHECKPOINT_HARNESS_FINGERPRINT,
    editorialContextFingerprint: AUDSEG_EDITORIAL_CONTEXT_FINGERPRINT,
    pipelineFingerprint: String(
      pipelineFingerprint || REQUIRED_CAPTION_PIPELINE_FINGERPRINT
    ).trim().slice(0, 128),
    requestId: String(requestId || "").trim().slice(0, 128),
    completedAt: String(completedAt || "").trim().slice(0, 64)
  };
  if (
    !checkpoint.clipId
    || checkpoint.sourceStartMs < 0
    || checkpoint.sourceEndMs <= checkpoint.sourceStartMs
    || !checkpoint.pipelineFingerprint
  ) {
    throw new Error("자막 재개 체크포인트용 컷 범위가 올바르지 않습니다.");
  }
  return checkpoint;
}

export function upsertCaptionDraftCheckpoint(
  checkpoints,
  checkpoint,
  { maximum = DEFAULT_CHECKPOINT_LIMIT } = {}
) {
  const source = Array.isArray(checkpoints) ? checkpoints : [];
  const targetKey = captionCheckpointKey(checkpoint);
  return [
    ...source.filter(
      (candidate) => captionCheckpointKey(candidate) !== targetKey
    ),
    checkpoint
  ].slice(-Math.max(1, Math.round(finiteNumber(maximum, 1))));
}

export function discardCaptionDraftCheckpointsForClips(
  checkpoints,
  clips
) {
  const clipIds = new Set(
    (Array.isArray(clips) ? clips : [])
      .map((clip) => String(clip?.id || ""))
      .filter(Boolean)
  );
  if (clipIds.size === 0) {
    return Array.isArray(checkpoints) ? [...checkpoints] : [];
  }
  return (Array.isArray(checkpoints) ? checkpoints : []).filter(
    (checkpoint) => !clipIds.has(String(checkpoint?.clipId || ""))
  );
}

export function sameCaptionMediaIdentity(left, right) {
  if (!left || typeof left !== "object" || !right || typeof right !== "object") {
    return false;
  }
  for (const field of ["size", "lastModified", "durationMs"]) {
    if (
      !Number.isFinite(Number(left[field]))
      || !Number.isFinite(Number(right[field]))
    ) {
      return false;
    }
  }
  const fields = [
    "name",
    "size",
    "lastModified",
    "durationMs",
    "mediaOriginMs",
    "width",
    "height",
    "codec",
    "audioCodec"
  ];
  return fields.every(
    (field) => String(left[field] ?? "") === String(right[field] ?? "")
  );
}

export function captionDraftResumePlan(
  clips,
  checkpoints,
  {
    resume = false,
    pipelineFingerprint = REQUIRED_CAPTION_PIPELINE_FINGERPRINT
  } = {}
) {
  const enabled = (Array.isArray(clips) ? clips : []).filter(
    (clip) => clip?.enabled !== false
  );
  if (!resume) {
    return {
      clips: enabled,
      skippedClipIds: []
    };
  }
  const completedKeys = new Set(
    (Array.isArray(checkpoints) ? checkpoints : [])
      .map((checkpoint) => captionCheckpointKey(checkpoint))
  );
  const skippedClipIds = [];
  const pending = enabled.filter((clip) => {
    const completed = completedKeys.has(captionCheckpointKey({
      clipId: clip.id,
      sourceStartMs: clip.sourceStartMs,
      sourceEndMs: clip.sourceEndMs,
      model: AUDSEG_DRAFT_MODEL,
      qualityProfile: AUDSEG_CHECKPOINT_QUALITY_PROFILE_ID,
      harnessFingerprint: AUDSEG_CHECKPOINT_HARNESS_FINGERPRINT,
      editorialContextFingerprint: AUDSEG_EDITORIAL_CONTEXT_FINGERPRINT,
      pipelineFingerprint
    }));
    if (completed) {
      skippedClipIds.push(String(clip.id));
    }
    return !completed;
  });
  return {
    clips: pending,
    skippedClipIds
  };
}
