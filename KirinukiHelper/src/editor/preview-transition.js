export const PREVIEW_BOUNDARY_TOLERANCE_MS = 20;

export function nextEnabledPreviewClip(clips, activeClipId) {
  if (!Array.isArray(clips) || !activeClipId) {
    return null;
  }
  const enabled = clips.filter((clip) => clip?.enabled !== false);
  const activeIndex = enabled.findIndex((clip) => clip.id === activeClipId);
  return activeIndex >= 0 ? enabled[activeIndex + 1] || null : null;
}

export function previewReachedClipBoundary(
  sourceMs,
  sourceEndMs,
  toleranceMs = PREVIEW_BOUNDARY_TOLERANCE_MS
) {
  if (!Number.isFinite(sourceMs) || !Number.isFinite(sourceEndMs)) {
    return false;
  }
  const tolerance = Math.max(0, Number(toleranceMs) || 0);
  return sourceMs >= sourceEndMs - tolerance;
}

export function preparedPreviewMatches(prepared, clip, targetSeconds) {
  return Boolean(
    prepared
    && clip
    && prepared.ready === true
    && prepared.clipId === clip.id
    && Number.isFinite(prepared.targetSeconds)
    && Number.isFinite(targetSeconds)
    && Math.abs(prepared.targetSeconds - targetSeconds) <= 0.03
  );
}
