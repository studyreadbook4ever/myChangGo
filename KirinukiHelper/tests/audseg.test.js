import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  AUDSEG_DRAFT_MODEL,
  AUDSEG_PIPELINE_FINGERPRINT,
  audSegBlankSubtitleDrafts,
  segmentAudSegPcm,
  segmentAudSegPcmInWorker
} from "../src/editor/audseg.js";
import {
  createEditorProjectFromCapture,
  replaceAiBlankTimingDraft,
  subtitleCueNeedsReview,
  updateSubtitleCue
} from "../extension/lib/editor-core.js";
import { mixAudioChannelSamples } from "../src/editor/media-engine.js";

const SAMPLE_RATE = 16_000;
const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

function silence(seconds) {
  return new Float32Array(Math.round(SAMPLE_RATE * seconds));
}

function tone(seconds, amplitude = 0.5, frequencyHz = 440) {
  return Float32Array.from(
    { length: Math.round(SAMPLE_RATE * seconds) },
    (_, index) => (
      amplitude * Math.sin(
        2 * Math.PI * frequencyHz * index / SAMPLE_RATE
      )
    )
  );
}

function concat(...arrays) {
  const output = new Float32Array(
    arrays.reduce((total, array) => total + array.length, 0)
  );
  let offset = 0;
  for (const array of arrays) {
    output.set(array, offset);
    offset += array.length;
  }
  return output;
}

function capture() {
  return {
    schemaVersion: 3,
    source: {
      platform: "CHZZK",
      contentType: "VOD",
      contentId: "audseg-test",
      canonicalUrl: "https://chzzk.naver.com/video/audseg-test"
    },
    segments: [{
      id: "selection-1",
      startSeconds: 0,
      endSeconds: 12,
      description: ""
    }]
  };
}

class FakeAudSegWorker {
  constructor({ respond = true } = {}) {
    this.respond = respond;
    this.listeners = new Map();
    this.terminated = false;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  postMessage(message) {
    if (!this.respond) {
      return;
    }
    queueMicrotask(() => {
      const result = segmentAudSegPcm(message.samples, {
        sampleRateHz: message.sampleRateHz
      });
      for (const listener of this.listeners.get("message") || []) {
        listener({
          data: {
            requestId: message.requestId,
            ok: true,
            result
          }
        });
      }
    });
  }

  terminate() {
    this.terminated = true;
  }
}

test("AudSeg 브라우저 통합은 모델·네트워크 없이 활동 구간만 찾는다", () => {
  const pcm = concat(silence(0.2), tone(0.4), silence(0.4));
  const result = segmentAudSegPcm(pcm);

  assert.equal(result.schema, "kirinuki-audseg-browser-result/v1");
  assert.equal(result.engine.id, "audseg");
  assert.equal(result.engine.modelFree, true);
  assert.equal(result.engine.transcription, false);
  assert.equal(result.engine.fingerprint, AUDSEG_PIPELINE_FINGERPRINT);
  assert.equal(AUDSEG_DRAFT_MODEL, "audseg-local");
  assert.equal(result.activityRegions.length, 1);
  assert.equal(result.segments.length, 1);
  assert.deepEqual(
    [result.segments[0].startSample, result.segments[0].endSample],
    [2_400, 11_040]
  );
  assert.deepEqual(result.warnings, []);
});

test("긴 연속 활동은 조용한 골짜기 또는 hard limit에서 4초 이하로 나눈다", () => {
  const pcm = concat(silence(0.2), tone(9), silence(0.4));
  const result = segmentAudSegPcm(pcm);

  assert.ok(result.segments.length >= 3);
  assert.ok(result.segments.every((segment) => (
    segment.endSample - segment.startSample <= SAMPLE_RATE * 4
  )));
  assert.ok(result.segments.every((segment) => segment.forcedSplit));
  assert.ok(result.segments.every((segment) => (
    ["quiet_valley", "hard_limit"].includes(segment.splitMethod)
  )));
});

test("무음은 실패가 아니라 활동 없음 진단과 빈 timing 결과를 반환한다", () => {
  const result = segmentAudSegPcm(silence(1));

  assert.deepEqual(result.segments, []);
  assert.ok(result.warnings.includes("no_activity_detected"));
  assert.deepEqual(audSegBlankSubtitleDrafts(result), []);
});

test("AudSeg는 upstream과 같은 미세 overshoot를 clamp하고 잘못된 PCM은 거절한다", () => {
  const tolerated = new Float32Array([1.000_000_1, -1.000_000_1, 0]);
  const result = segmentAudSegPcm(tolerated);
  assert.equal(result.totalSamples, 3);
  assert.equal(tolerated[0], 1);
  assert.equal(tolerated[1], -1);

  assert.throws(
    () => segmentAudSegPcm(new Float32Array([1.001])),
    /-1부터 1/u
  );
  assert.throws(
    () => segmentAudSegPcm(new Float32Array([Number.NaN])),
    /유한한 값/u
  );
  assert.throws(
    () => segmentAudSegPcm(silence(1), {
      config: { detector: {}, cues: {} }
    }),
    /기본값으로 고정/u
  );
});

test("AudSeg용 strongest 채널 혼합은 역상 스테레오를 무음으로 상쇄하지 않는다", () => {
  const channels = [
    new Float32Array([0.5, 0.25]),
    new Float32Array([-0.5, -0.25])
  ];

  assert.equal(mixAudioChannelSamples(channels, 0, 1, 0, "average"), 0);
  assert.equal(
    mixAudioChannelSamples(channels, 0, 1, 0, "strongest"),
    0.5
  );
});

test("AudSeg Worker 경로는 결과 뒤 종료되고 AbortSignal로 즉시 취소된다", async () => {
  const completedWorker = new FakeAudSegWorker();
  const result = await segmentAudSegPcmInWorker(
    concat(silence(0.2), tone(0.4), silence(0.4)),
    { workerFactory: () => completedWorker }
  );
  assert.equal(result.segments.length, 1);
  assert.equal(completedWorker.terminated, true);

  const waitingWorker = new FakeAudSegWorker({ respond: false });
  const controller = new AbortController();
  const pending = segmentAudSegPcmInWorker(silence(1), {
    signal: controller.signal,
    workerFactory: () => waitingWorker
  });
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(waitingWorker.terminated, true);
});

test("AudSeg timing 초안은 빈 자막으로 보이고 사람이 채우면 재실행에서 보존된다", () => {
  const project = createEditorProjectFromCapture(capture());
  const clip = project.clips[0];
  const result = segmentAudSegPcm(
    concat(silence(0.2), tone(0.4), silence(0.4))
  );
  const drafts = audSegBlankSubtitleDrafts(result);
  const inserted = replaceAiBlankTimingDraft(project, clip.id, drafts);

  assert.equal(inserted.subtitles.length, 1);
  assert.equal(inserted.subtitles[0].text, "");
  assert.equal(inserted.subtitles[0].origin, "ai");
  assert.equal(inserted.subtitles[0].remoteMeta.reviewRequired, true);
  assert.equal(subtitleCueNeedsReview(inserted.subtitles[0]), true);
  assert.ok(
    inserted.subtitles[0].remoteMeta.qualityCodes.includes(
      "AUDSEG_BLANK_TIMING"
    )
  );

  const human = updateSubtitleCue(
    inserted,
    inserted.subtitles[0].id,
    { text: "직접 입력한 자막" }
  );
  const rerun = replaceAiBlankTimingDraft(human, clip.id, drafts);
  assert.equal(rerun.subtitles.length, 1);
  assert.equal(rerun.subtitles[0].id, inserted.subtitles[0].id);
  assert.equal(rerun.subtitles[0].text, "직접 입력한 자막");
  assert.equal(rerun.subtitles[0].humanEdited, true);
  assert.equal(subtitleCueNeedsReview(rerun.subtitles[0]), false);

  const timingOnlyEdit = updateSubtitleCue(
    inserted,
    inserted.subtitles[0].id,
    { startOffsetMs: inserted.subtitles[0].startOffsetMs + 20 }
  );
  assert.equal(timingOnlyEdit.subtitles[0].humanEdited, true);
  assert.equal(timingOnlyEdit.subtitles[0].text, "");
  assert.equal(subtitleCueNeedsReview(timingOnlyEdit.subtitles[0]), true);
});

test("AudSeg 원본과 MIT 라이선스는 sibling 패키지로 함께 보존된다", () => {
  const audSegRoot = path.resolve(packageRoot, "..", "AudSeg");
  const pyproject = fs.readFileSync(
    path.join(audSegRoot, "pyproject.toml"),
    "utf8"
  );
  const license = fs.readFileSync(
    path.join(audSegRoot, "LICENSE"),
    "utf8"
  );

  assert.match(pyproject, /name = "audseg"/u);
  assert.match(pyproject, /version = "0\.1\.0"/u);
  assert.match(license, /MIT License/u);
});
