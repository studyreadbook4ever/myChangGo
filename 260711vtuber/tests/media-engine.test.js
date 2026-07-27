import assert from "node:assert/strict";
import test from "node:test";

import {
  activeCuesAt,
  audioTrimFrameRange,
  buildRenderEncodingSettings,
  cfrFrameRange,
  cfrFrameTiming,
  chooseOutputCodecs,
  clampCaptionBoxCenter,
  createFileWriteTransaction,
  normalizeMediaTimeline,
  validateRenderClips,
  wrapCaption
} from "../src/editor/media-engine.js";

test("컨테이너 PTS 원점을 프로젝트 0초와 분리해 실제 재생 길이를 계산한다", () => {
  assert.deepEqual(normalizeMediaTimeline(120.25, 180.75), {
    originSeconds: 120.25,
    endSeconds: 180.75,
    durationSeconds: 60.5,
    mediaOriginMs: 120_250,
    mediaEndTimestampMs: 180_750,
    durationMs: 60_500
  });
  assert.deepEqual(normalizeMediaTimeline(-0.125, 10), {
    originSeconds: 0,
    endSeconds: 10,
    durationSeconds: 10,
    mediaOriginMs: 0,
    mediaEndTimestampMs: 10_000,
    durationMs: 10_000
  });
});

test("렌더 대상은 활성 컷·원본 범위·연속 타임라인을 모두 검증한다", () => {
  const valid = {
    clips: [
      {
        id: "first",
        sourceStartMs: 1_000,
        sourceEndMs: 2_000,
        timelineStartMs: 0,
        enabled: true
      },
      {
        id: "disabled",
        sourceStartMs: -100,
        sourceEndMs: -50,
        timelineStartMs: 1_000,
        enabled: false
      },
      {
        id: "second",
        sourceStartMs: 4_000,
        sourceEndMs: 5_500,
        timelineStartMs: 1_000,
        enabled: true
      }
    ]
  };
  assert.deepEqual(
    validateRenderClips(valid, 6_000).map((clip) => clip.id),
    ["first", "second"]
  );
  assert.throws(
    () => validateRenderClips({ clips: [{ ...valid.clips[0], enabled: false }] }, 6_000),
    /활성/
  );
  assert.throws(
    () => validateRenderClips({
      clips: [{ ...valid.clips[0], sourceEndMs: 6_001 }]
    }, 6_000),
    /영상 길이 밖/
  );
  assert.throws(
    () => validateRenderClips({
      clips: [
        valid.clips[0],
        { ...valid.clips[2], timelineStartMs: 1_010 }
      ]
    }, 6_000),
    /컷 순서와 맞지/
  );
});

test("컷별 CFR 격자는 사용자 컷 경계를 정확히 잇고 마지막 프레임만 짧게 만든다", () => {
  const firstClip = {
    sourceStartMs: 0,
    sourceEndMs: 510,
    timelineStartMs: 0
  };
  const secondClip = {
    sourceStartMs: 2_000,
    sourceEndMs: 2_490,
    timelineStartMs: 510
  };
  const first = cfrFrameRange(firstClip, 30);
  const second = cfrFrameRange(secondClip, 30);
  const firstLastFrame = cfrFrameTiming(firstClip, first.endFrameIndex - 1, 30);
  const secondFirstFrame = cfrFrameTiming(secondClip, second.firstFrameIndex, 30);

  assert.deepEqual(first, { firstFrameIndex: 0, endFrameIndex: 16 });
  assert.deepEqual(second, { firstFrameIndex: 0, endFrameIndex: 15 });
  assert.ok(firstLastFrame.duration < 1 / 30);
  assert.ok(Math.abs(
    firstLastFrame.outputTimestamp
      + firstLastFrame.duration
      - secondFirstFrame.outputTimestamp
  ) < 1e-12);
  assert.equal(secondFirstFrame.outputTimestamp, 0.51);
});

test("긴 자막 박스 중심은 5% 위치에서도 캔버스 안으로 이동한다", () => {
  const boxWidth = 1_650;
  const boxHeight = 180;
  const safeInset = 6;
  const center = clampCaptionBoxCenter({
    requestedX: 1_920 * 0.05,
    requestedY: 1_080 * 0.05,
    boxWidth,
    boxHeight,
    canvasWidth: 1_920,
    canvasHeight: 1_080,
    safeInset
  });
  assert.ok(center.x - boxWidth / 2 >= safeInset);
  assert.ok(center.y - boxHeight / 2 >= safeInset);
  assert.ok(center.x + boxWidth / 2 <= 1_920 - safeInset);
  assert.ok(center.y + boxHeight / 2 <= 1_080 - safeInset);
});

test("겹치는 사람 자막과 네 줄을 넘는 텍스트를 렌더 단계에서 버리지 않는다", () => {
  const project = {
    clips: [{
      id: "clip",
      timelineStartMs: 0,
      enabled: true
    }],
    subtitles: [
      {
        id: "first",
        clipId: "clip",
        startOffsetMs: 0,
        endOffsetMs: 2_000,
        text: "첫 자막"
      },
      {
        id: "second",
        clipId: "clip",
        startOffsetMs: 500,
        endOffsetMs: 1_500,
        text: "둘째 자막"
      }
    ]
  };
  assert.deepEqual(
    activeCuesAt(project, 1).map((cue) => cue.id),
    ["first", "second"]
  );

  const context = {
    measureText: (text) => ({ width: String(text).length * 10 })
  };
  assert.deepEqual(
    wrapCaption(context, "하나\n둘\n셋\n넷\n다섯", 100),
    ["하나", "둘", "셋", "넷", "다섯"]
  );
});

test("오디오 경계는 가장 가까운 PCM 프레임으로 자른다", () => {
  const sample = {
    timestamp: 10,
    sampleRate: 48_000,
    numberOfFrames: 4_800
  };
  assert.deepEqual(
    audioTrimFrameRange(sample, 10.000_01, 10.099_98),
    { frameStart: 0, frameEnd: 4_799 }
  );
  assert.deepEqual(
    audioTrimFrameRange(sample, 9, 11),
    { frameStart: 0, frameEnd: 4_800 }
  );
});

test("코덱 probe는 실제 출력 크기·비트레이트를 쓰고 무음 영상에서 오디오를 요구하지 않는다", async () => {
  const settings = buildRenderEncodingSettings(3_840, 2_160, 59.94, false);
  const videoCalls = [];
  let audioCalls = 0;
  const profile = await chooseOutputCodecs(settings, {
    videoProbe: async (codec, options) => {
      videoCalls.push({ codec, options });
      return codec === "avc";
    },
    audioProbe: async () => {
      audioCalls += 1;
      return false;
    }
  });

  assert.equal(profile.extension, "mp4");
  assert.equal(profile.audioCodec, null);
  assert.equal(profile.hardwareAcceleration, "prefer-hardware");
  assert.equal(audioCalls, 0);
  assert.deepEqual(videoCalls, [{
    codec: "avc",
    options: {
      width: 1_920,
      height: 1_080,
      bitrate: settings.videoBitrate,
      hardwareAcceleration: "prefer-hardware",
      latencyMode: "quality"
    }
  }]);
});

test("하드웨어 인코더가 없으면 지원되는 소프트웨어 프로필로 내려간다", async () => {
  const settings = buildRenderEncodingSettings(1_280, 720, 30, true);
  const videoCalls = [];
  const profile = await chooseOutputCodecs(settings, {
    videoProbe: async (codec, options) => {
      videoCalls.push({ codec, preference: options.hardwareAcceleration });
      return codec === "vp9" && options.hardwareAcceleration === "no-preference";
    },
    audioProbe: async (codec) => codec === "opus"
  });

  assert.equal(profile.extension, "webm");
  assert.equal(profile.videoCodec, "vp9");
  assert.equal(profile.audioCodec, "opus");
  assert.equal(profile.hardwareAcceleration, "no-preference");
  assert.deepEqual(videoCalls, [
    { codec: "vp9", preference: "prefer-hardware" },
    { codec: "vp9", preference: "no-preference" }
  ]);
});

test("파일 스트림은 finalize 준비 전 close에서는 abort하고 성공 경로에서만 commit한다", async () => {
  const abortedEvents = [];
  const abortedFile = {
    async write(chunk) {
      abortedEvents.push(["write", chunk]);
    },
    async close() {
      abortedEvents.push(["close"]);
    },
    async abort(reason) {
      abortedEvents.push(["abort", reason]);
    }
  };
  const abortedTransaction = createFileWriteTransaction(abortedFile);
  const abortedWriter = abortedTransaction.writable.getWriter();
  await abortedWriter.write({ type: "write", position: 0, data: new Uint8Array([1]) });
  await abortedWriter.close();
  assert.deepEqual(abortedEvents.map(([event]) => event), ["write", "abort"]);

  const committedEvents = [];
  const committedFile = {
    async write(chunk) {
      committedEvents.push(["write", chunk]);
    },
    async close() {
      committedEvents.push(["close"]);
    },
    async abort(reason) {
      committedEvents.push(["abort", reason]);
    }
  };
  const committedTransaction = createFileWriteTransaction(committedFile);
  const committedWriter = committedTransaction.writable.getWriter();
  await committedWriter.write({ type: "write", position: 0, data: new Uint8Array([2]) });
  committedTransaction.prepareCommit();
  await committedWriter.close();
  assert.deepEqual(committedEvents.map(([event]) => event), ["write", "close"]);
});

test("파일 commit 자체가 실패해도 원본 오류를 유지한 채 abort로 정리할 수 있다", async () => {
  const events = [];
  const file = {
    async write() {},
    async close() {
      events.push("close");
      throw new Error("disk full");
    },
    async abort() {
      events.push("abort");
    }
  };
  const transaction = createFileWriteTransaction(file);
  const writer = transaction.writable.getWriter();
  transaction.prepareCommit();
  await assert.rejects(writer.close(), /disk full/);
  await transaction.abort();
  assert.deepEqual(events, ["close", "abort"]);
});
