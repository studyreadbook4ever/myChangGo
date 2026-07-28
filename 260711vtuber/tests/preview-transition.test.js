import assert from "node:assert/strict";
import test from "node:test";

import {
  nextEnabledPreviewClip,
  preparedPreviewMatches,
  previewReachedClipBoundary
} from "../src/editor/preview-transition.js";

test("다음 미리보기 컷은 비활성 컷을 건너뛰되 저장된 편집 순서를 유지한다", () => {
  const clips = [
    { id: "first", enabled: true, sourceStartMs: 50_000 },
    { id: "disabled", enabled: false, sourceStartMs: 5_000 },
    { id: "second", enabled: true, sourceStartMs: 10_000 }
  ];

  assert.equal(nextEnabledPreviewClip(clips, "first")?.id, "second");
  assert.equal(nextEnabledPreviewClip(clips, "second"), null);
  assert.equal(nextEnabledPreviewClip(clips, "missing"), null);
});

test("프레임 단위 경계 감시는 마지막 프레임 오차 안에서만 전환한다", () => {
  assert.equal(previewReachedClipBoundary(9_979, 10_000), false);
  assert.equal(previewReachedClipBoundary(9_980, 10_000), true);
  assert.equal(previewReachedClipBoundary(10_100, 10_000), true);
  assert.equal(previewReachedClipBoundary(Number.NaN, 10_000), false);
});

test("미리 준비된 프레임은 동일 컷과 동일 원본 시각일 때만 재사용한다", () => {
  const clip = { id: "next" };
  const prepared = {
    ready: true,
    clipId: "next",
    targetSeconds: 123.456
  };

  assert.equal(preparedPreviewMatches(prepared, clip, 123.47), true);
  assert.equal(preparedPreviewMatches(prepared, { id: "other" }, 123.47), false);
  assert.equal(preparedPreviewMatches({ ...prepared, ready: false }, clip, 123.47), false);
  assert.equal(preparedPreviewMatches(prepared, clip, 123.5), false);
});
