import test from "node:test";
import assert from "node:assert/strict";

import {
  AUDSEG_DRAFT_MODEL,
  AUDSEG_ENGINE_VERSION,
  AUDSEG_PIPELINE_FINGERPRINT
} from "../src/editor/audseg.js";
import {
  AUDSEG_CHECKPOINT_HARNESS_FINGERPRINT,
  AUDSEG_CHECKPOINT_QUALITY_PROFILE_ID,
  AUDSEG_EDITORIAL_CONTEXT_FINGERPRINT,
  MAX_CAPTION_DRAFT_CUES_PER_RUN,
  audSegDraftRuntimeIdentity,
  captionDraftResumePlan,
  captionDraftRunEstimate,
  createCaptionDraftCheckpoint,
  discardCaptionDraftCheckpointsForClips,
  sameCaptionMediaIdentity,
  upsertCaptionDraftCheckpoint
} from "../src/editor/caption-draft-run.js";

function clip(index, overrides = {}) {
  return {
    id: `clip-${index}`,
    sourceStartMs: index * 10_000,
    sourceEndMs: index * 10_000 + 5_000,
    enabled: true,
    ...overrides
  };
}

test("AudSeg 초벌 runtime은 브라우저 로컬 pipeline으로 고정된다", () => {
  assert.deepEqual(audSegDraftRuntimeIdentity(), {
    provider: "local-audseg",
    engine: `audseg-${AUDSEG_ENGINE_VERSION}-dsp`,
    transcriptionMode: "browser-audio-activity",
    fingerprint: AUDSEG_PIPELINE_FINGERPRINT
  });
  assert.equal(MAX_CAPTION_DRAFT_CUES_PER_RUN, 10_000);
});

test("실행 예상량은 비활성 컷을 빼고 활성 컷 전체를 제한 없이 계산한다", () => {
  const clips = [
    ...Array.from({ length: 21 }, (_, index) => clip(index)),
    clip(30, { enabled: false })
  ];
  assert.deepEqual(captionDraftRunEstimate(clips), {
    clipCount: 21,
    totalDurationMs: 105_000,
    browserDrafts: 21
  });
});

test("새 체크포인트는 AudSeg와 기존 재개 fingerprint 계약으로만 생성된다", () => {
  const checkpoint = createCaptionDraftCheckpoint(clip(1), {
    requestId: "request-1",
    completedAt: "2026-07-30T00:00:00.000Z",
    pipelineFingerprint: AUDSEG_PIPELINE_FINGERPRINT
  });
  assert.deepEqual(checkpoint, {
    clipId: "clip-1",
    sourceStartMs: 10_000,
    sourceEndMs: 15_000,
    model: AUDSEG_DRAFT_MODEL,
    qualityProfile: AUDSEG_CHECKPOINT_QUALITY_PROFILE_ID,
    harnessFingerprint: AUDSEG_CHECKPOINT_HARNESS_FINGERPRINT,
    editorialContextFingerprint: AUDSEG_EDITORIAL_CONTEXT_FINGERPRINT,
    pipelineFingerprint: AUDSEG_PIPELINE_FINGERPRINT,
    requestId: "request-1",
    completedAt: "2026-07-30T00:00:00.000Z"
  });
});

test("AudSeg는 많은 컷의 완료 상태를 그대로 재개한다", () => {
  const clips = Array.from({ length: 21 }, (_, index) => clip(index));
  const checkpoints = clips.map((entry, index) => (
    createCaptionDraftCheckpoint(entry, {
      requestId: `request-${index}`,
      pipelineFingerprint: AUDSEG_PIPELINE_FINGERPRINT
    })
  ));
  const plan = captionDraftResumePlan(clips, checkpoints, {
    resume: true,
    pipelineFingerprint: AUDSEG_PIPELINE_FINGERPRINT
  });
  assert.deepEqual(plan.clips, []);
  assert.deepEqual(
    plan.skippedClipIds,
    clips.map((entry) => entry.id)
  );
});

test("pipeline 또는 호환 fingerprint가 다르면 완료 컷으로 건너뛰지 않는다", () => {
  const target = clip(1);
  const checkpoint = createCaptionDraftCheckpoint(target, {
    pipelineFingerprint: AUDSEG_PIPELINE_FINGERPRINT
  });
  assert.deepEqual(
    captionDraftResumePlan([target], [{
      ...checkpoint,
      pipelineFingerprint: "different-pipeline"
    }], {
      resume: true,
      pipelineFingerprint: AUDSEG_PIPELINE_FINGERPRINT
    }).clips,
    [target]
  );
  assert.deepEqual(
    captionDraftResumePlan([target], [{
      ...checkpoint,
      editorialContextFingerprint: "different-context"
    }], {
      resume: true,
      pipelineFingerprint: AUDSEG_PIPELINE_FINGERPRINT
    }).clips,
    [target]
  );
});

test("체크포인트는 같은 실행 키를 갱신하고 지정 컷만 폐기한다", () => {
  const first = createCaptionDraftCheckpoint(clip(1), {
    requestId: "first",
    pipelineFingerprint: AUDSEG_PIPELINE_FINGERPRINT
  });
  const second = createCaptionDraftCheckpoint(clip(2), {
    requestId: "second",
    pipelineFingerprint: AUDSEG_PIPELINE_FINGERPRINT
  });
  const updated = createCaptionDraftCheckpoint(clip(1), {
    requestId: "updated",
    pipelineFingerprint: AUDSEG_PIPELINE_FINGERPRINT
  });
  assert.deepEqual(
    upsertCaptionDraftCheckpoint([first, second], updated)
      .map((entry) => entry.requestId),
    ["second", "updated"]
  );
  assert.deepEqual(
    discardCaptionDraftCheckpointsForClips([second, updated], [clip(2)])
      .map((entry) => entry.requestId),
    ["updated"]
  );
});

test("자막 초벌 미디어 identity는 안정 필드가 모두 같을 때만 일치한다", () => {
  const identity = {
    name: "source.webm",
    size: 1_024,
    lastModified: 123,
    durationMs: 45_000,
    mediaOriginMs: 0,
    width: 1_920,
    height: 1_080,
    codec: "vp9",
    audioCodec: "opus"
  };
  assert.equal(sameCaptionMediaIdentity(identity, { ...identity }), true);
  assert.equal(sameCaptionMediaIdentity(identity, {
    ...identity,
    durationMs: 45_001
  }), false);
  assert.equal(sameCaptionMediaIdentity(identity, null), false);
});
