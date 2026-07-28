import assert from "node:assert/strict";
import test from "node:test";

import { AudioSample } from "mediabunny";

import {
  activeCuesAt,
  activeImageAssetsAt,
  analyzeCaptionPlacementFrame,
  applyAudioAutomationToSample,
  audioAutomationGainAt,
  audioTrimFrameRange,
  buildAudioAutomation,
  buildRenderEncodingSettings,
  cfrFrameRange,
  cfrFrameTiming,
  chooseOutputCodecs,
  clampCaptionBoxCenter,
  createFileWriteTransaction,
  createImageAssetRenderCache,
  drawImageAsset,
  fallbackCaptionPlacementHints,
  imageAssetDrawRect,
  MAX_ACTIVE_IMAGE_ASSET_RGBA_BYTES,
  normalizeMediaTimeline,
  validateRenderTimeline,
  validateRenderClips,
  wrapCaption
} from "../src/editor/media-engine.js";

function placementFrame(width, height, busyBand = null) {
  const data = new Uint8ClampedArray(width * height * 4);
  const ranges = {
    top: [0.06, 0.34],
    center: [0.36, 0.64],
    bottom: [0.66, 0.94]
  };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const inBusyBand = busyBand && (
        y >= Math.floor(height * ranges[busyBand][0])
        && y < Math.ceil(height * ranges[busyBand][1])
      );
      const value = inBusyBand && (x + y) % 2 === 0 ? 255 : 80;
      data[offset] = value;
      data[offset + 1] = value;
      data[offset + 2] = value;
      data[offset + 3] = 255;
    }
  }
  return data;
}

test("로컬 대표 프레임 방해도는 복잡한 밴드를 피하고 평탄하면 bottom을 택한다", () => {
  const width = 32;
  const height = 30;
  const topBusy = analyzeCaptionPlacementFrame(
    placementFrame(width, height, "top"),
    width,
    height
  );
  assert(topBusy.topScore > topBusy.bottomScore);
  assert.equal(topBusy.preferredPlacement, "bottom");

  const bottomBusy = analyzeCaptionPlacementFrame(
    placementFrame(width, height, "bottom"),
    width,
    height
  );
  assert(bottomBusy.bottomScore > bottomBusy.topScore);
  assert.equal(bottomBusy.preferredPlacement, "top");

  const flat = analyzeCaptionPlacementFrame(
    placementFrame(width, height),
    width,
    height
  );
  assert.deepEqual(
    {
      top: flat.topScore,
      center: flat.centerScore,
      bottom: flat.bottomScore,
      preferred: flat.preferredPlacement
    },
    {
      top: 0,
      center: 0,
      bottom: 0,
      preferred: "bottom"
    }
  );
  assert.deepEqual(
    fallbackCaptionPlacementHints(1),
    {
      analysis: "local-three-band-edge-density-v1",
      framesShared: false,
      samples: [{
        atMs: 0,
        topScore: 500,
        centerScore: 500,
        bottomScore: 500,
        preferredPlacement: "bottom"
      }]
    }
  );
});

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

test("동시 이미지 에셋은 프로젝트 배열 순서대로 활성화한다", () => {
  const project = {
    clips: [{
      id: "clip",
      timelineStartMs: 1_000,
      enabled: true
    }],
    imageAssets: [
      {
        id: "behind",
        clipId: "clip",
        startOffsetMs: 0,
        endOffsetMs: 2_000
      },
      {
        id: "front",
        clipId: "clip",
        startOffsetMs: 500,
        endOffsetMs: 1_500
      }
    ]
  };
  assert.deepEqual(
    activeImageAssetsAt(project, 1.75).map((asset) => asset.id),
    ["behind", "front"]
  );
  assert.deepEqual(activeImageAssetsAt(project, 3), []);
});

test("이미지 에셋은 비율·투명도를 보존해 영상 위에 합성한다", () => {
  const canvas = { width: 1_920, height: 1_080 };
  const image = { width: 1_000, height: 500 };
  const asset = {
    x: 0.5,
    y: 0.5,
    scale: 1,
    opacity: 0.4,
    naturalWidth: 1_000,
    naturalHeight: 500
  };
  assert.deepEqual(imageAssetDrawRect(canvas, asset, image), {
    x: 624,
    y: 372,
    width: 672,
    height: 336
  });

  const events = [];
  const context = {
    globalAlpha: 1,
    globalCompositeOperation: "copy",
    save() {
      events.push(["save"]);
    },
    drawImage(...args) {
      events.push([
        "drawImage",
        ...args,
        this.globalAlpha,
        this.globalCompositeOperation
      ]);
    },
    restore() {
      events.push(["restore"]);
    }
  };
  drawImageAsset(context, canvas, asset, image);
  assert.deepEqual(events, [
    ["save"],
    ["drawImage", image, 624, 372, 672, 336, 0.4, "source-over"],
    ["restore"]
  ]);
});

test("렌더 캐시는 현재 활성 이미지 에셋만 디코드하고 구간 종료 즉시 해제한다", async () => {
  const firstBlob = new Blob(["first"], { type: "image/png" });
  const secondBlob = new Blob(["second"], { type: "image/png" });
  const blobs = new Map([
    ["first-key", firstBlob],
    ["second-key", secondBlob]
  ]);
  const dimensions = new Map([
    [firstBlob, { width: 20, height: 10, id: "first" }],
    [secondBlob, { width: 8, height: 8, id: "second" }]
  ]);
  const resolved = [];
  const decoded = [];
  const closed = [];
  const project = {
    clips: [{
      id: "clip",
      timelineStartMs: 0,
      enabled: true
    }],
    imageAssets: [
      {
        id: "first",
        clipId: "clip",
        name: "첫 에셋",
        mimeType: "image/png",
        source: { kind: "blob-key", value: "first-key" },
        startOffsetMs: 0,
        endOffsetMs: 500
      },
      {
        id: "second",
        clipId: "clip",
        name: "둘째 에셋",
        mimeType: "image/png",
        source: { kind: "blob-key", value: "second-key" },
        startOffsetMs: 1_000,
        endOffsetMs: 1_500
      }
    ]
  };
  const cache = createImageAssetRenderCache(project, {
    resolveImageAsset: async (source) => {
      resolved.push(source.value);
      return blobs.get(source.value);
    },
    decodeImageAsset: async (blob) => {
      const metadata = dimensions.get(blob);
      decoded.push(metadata.id);
      return {
        width: metadata.width,
        height: metadata.height,
        close: () => closed.push(metadata.id)
      };
    }
  });

  assert.equal(MAX_ACTIVE_IMAGE_ASSET_RGBA_BYTES, 256 * 1024 * 1024);
  assert.deepEqual(
    (await cache.prepareAt(0.1)).map(({ asset }) => asset.id),
    ["first"]
  );
  assert.deepEqual(resolved, ["first-key"]);
  assert.deepEqual(decoded, ["first"]);
  assert.equal(cache.decodedBytes, 20 * 10 * 4);

  await cache.prepareAt(0.2);
  assert.deepEqual(decoded, ["first"]);
  cache.releaseThrough(0.4996);
  assert.deepEqual(closed, ["first"]);
  assert.equal(cache.decodedBytes, 0);

  assert.deepEqual(
    (await cache.prepareAt(1.1)).map(({ asset }) => asset.id),
    ["second"]
  );
  assert.deepEqual(resolved, ["first-key", "second-key"]);
  cache.closeAll();
  assert.deepEqual(closed, ["first", "second"]);
  assert.equal(cache.decodedCount, 0);
});

test("동시 활성 이미지의 실제 RGBA 용량이 상한을 넘으면 모두 닫고 명확히 실패한다", async () => {
  const closed = [];
  let decodeIndex = 0;
  const project = {
    clips: [{
      id: "clip",
      timelineStartMs: 0,
      enabled: true
    }],
    imageAssets: ["behind", "front"].map((id) => ({
      id,
      clipId: "clip",
      name: id,
      mimeType: "image/png",
      source: { kind: "blob-key", value: id },
      startOffsetMs: 0,
      endOffsetMs: 1_000,
      naturalWidth: 4,
      naturalHeight: 4
    }))
  };
  const cache = createImageAssetRenderCache(project, {
    maxDecodedBytes: 100,
    resolveImageAsset: async () => new Blob(["image"], { type: "image/png" }),
    decodeImageAsset: async (_blob) => {
      const id = project.imageAssets[decodeIndex]?.id || "front";
      decodeIndex += 1;
      return {
        width: 4,
        height: 4,
        close: () => closed.push(id)
      };
    }
  });

  await assert.rejects(
    cache.prepareAt(0.1),
    /디코드 메모리가 100 B를 넘습니다/
  );
  assert.equal(decodeIndex, 1);
  assert.deepEqual(closed, ["behind"]);
  assert.equal(cache.decodedBytes, 0);
  assert.equal(cache.decodedCount, 0);

  let mismatchedClosed = 0;
  const mismatchedCache = createImageAssetRenderCache({
    clips: project.clips,
    imageAssets: [{
      ...project.imageAssets[0],
      naturalWidth: 1,
      naturalHeight: 1
    }]
  }, {
    maxDecodedBytes: 32,
    resolveImageAsset: async () => new Blob(["image"], { type: "image/png" }),
    decodeImageAsset: async () => ({
      width: 4,
      height: 4,
      close: () => {
        mismatchedClosed += 1;
      }
    })
  });
  await assert.rejects(
    mismatchedCache.prepareAt(0.1),
    /디코드 메모리가 32 B를 넘습니다/
  );
  assert.equal(mismatchedClosed, 1);
  assert.equal(mismatchedCache.decodedBytes, 0);
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

test("렌더 검증은 다른 자막 레인의 동시 자막을 허용하고 같은 레인·음성 구간 충돌만 막는다", () => {
  const clips = [{
    id: "clip",
    sourceStartMs: 0,
    sourceEndMs: 4_000,
    timelineStartMs: 0,
    enabled: true
  }];
  const simultaneousCaptions = {
    clips,
    imageAssets: [
      {
        id: "asset-a",
        clipId: "clip",
        startOffsetMs: 0,
        endOffsetMs: 2_000
      },
      {
        id: "asset-b",
        clipId: "clip",
        startOffsetMs: 500,
        endOffsetMs: 1_500
      }
    ],
    subtitles: [
      {
        id: "top",
        clipId: "clip",
        startOffsetMs: 0,
        endOffsetMs: 2_000,
        lane: 0
      },
      {
        id: "bottom",
        clipId: "clip",
        startOffsetMs: 500,
        endOffsetMs: 1_500,
        lane: 1
      }
    ],
    audioRegions: []
  };
  // One visual lane deliberately permits overlap. Array order defines back→front,
  // so export validation only rejects ambiguous subtitle/audio lane collisions.
  assert.doesNotThrow(() => validateRenderTimeline(simultaneousCaptions));
  assert.throws(
    () => validateRenderTimeline({
      ...simultaneousCaptions,
      subtitles: simultaneousCaptions.subtitles.map((cue) => ({ ...cue, lane: 0 }))
    }),
    /같은 자막 레인/
  );
  assert.throws(
    () => validateRenderTimeline({
      ...simultaneousCaptions,
      audioRegions: [
        {
          id: "first",
          clipId: "clip",
          startOffsetMs: 0,
          endOffsetMs: 2_000
        },
        {
          id: "second",
          clipId: "clip",
          startOffsetMs: 1_000,
          endOffsetMs: 3_000
        }
      ]
    }),
    /겹치는 음성/
  );
});

test("음성 자동화는 컷 타임라인에 맞춰 볼륨·뮤트와 양쪽 페이드를 계산한다", () => {
  const project = {
    clips: [{
      id: "clip",
      timelineStartMs: 2_000,
      enabled: true
    }],
    audioRegions: [{
      id: "quiet",
      clipId: "clip",
      startOffsetMs: 1_000,
      endOffsetMs: 5_000,
      gain: 0.25,
      muted: false,
      fadeInMs: 1_000,
      fadeOutMs: 2_000
    }]
  };
  const automation = buildAudioAutomation(project);
  assert.deepEqual(automation, [{
    id: "quiet",
    startSeconds: 3,
    endSeconds: 7,
    targetGain: 0.25,
    fadeInSeconds: 1,
    fadeOutSeconds: 2
  }]);
  assert.equal(audioAutomationGainAt(automation, 2.9), 1);
  assert.equal(audioAutomationGainAt(automation, 3), 1);
  assert.equal(audioAutomationGainAt(automation, 3.5), 0.625);
  assert.equal(audioAutomationGainAt(automation, 4), 0.25);
  assert.equal(audioAutomationGainAt(automation, 5), 0.25);
  assert.equal(audioAutomationGainAt(automation, 6), 0.625);
  assert.equal(audioAutomationGainAt(automation, 7), 1);

  const muted = buildAudioAutomation({
    ...project,
    audioRegions: [{
      ...project.audioRegions[0],
      muted: true,
      gain: 1,
      fadeInMs: 0,
      fadeOutMs: 0
    }]
  });
  assert.equal(audioAutomationGainAt(muted, 4), 0);
});

test("PCM 샘플에는 설정 구간의 프레임만 모든 채널에 동일하게 반영한다", () => {
  const sourceData = new Float32Array([
    1, -1,
    1, -1,
    1, -1,
    1, -1,
    1, -1,
    1, -1,
    1, -1,
    1, -1
  ]);
  const source = new AudioSample({
    data: sourceData,
    format: "f32",
    numberOfChannels: 2,
    sampleRate: 4,
    timestamp: 0
  });
  const automation = [{
    id: "quiet",
    startSeconds: 0.5,
    endSeconds: 1.5,
    targetGain: 0.25,
    fadeInSeconds: 0,
    fadeOutSeconds: 0
  }];
  const rendered = applyAudioAutomationToSample(source, automation);
  try {
    assert.notEqual(rendered, source);
    const actual = new Float32Array(sourceData.length);
    rendered.copyTo(actual, { planeIndex: 0, format: "f32" });
    assert.deepEqual([...actual], [
      1, -1,
      1, -1,
      0.25, -0.25,
      0.25, -0.25,
      0.25, -0.25,
      0.25, -0.25,
      1, -1,
      1, -1
    ]);
    assert.equal(applyAudioAutomationToSample(source, []), source);
  } finally {
    rendered.close();
    source.close();
  }
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
