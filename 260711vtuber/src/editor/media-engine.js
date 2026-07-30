import {
  ALL_FORMATS,
  AudioBufferSink,
  AudioSample,
  AudioSampleSink,
  AudioSampleSource,
  BlobSource,
  BufferTarget,
  Input,
  Mp4OutputFormat,
  Output,
  StreamTarget,
  VideoSample,
  VideoSampleSink,
  VideoSampleSource,
  WebMOutputFormat,
  canEncodeAudio,
  canEncodeVideo
} from "mediabunny";

import {
  audioRegionTimelineRange,
  clamp,
  cueTimelineRange,
  findAudioRegionOverlaps,
  findSubtitleOverlaps,
  imageAssetTimelineRange,
  imageAssetsAtTimeline
} from "../../extension/lib/editor-core.js";

const PCM_SAMPLE_RATE = 16_000;
const OUTPUT_AUDIO_CHANNELS = 2;
const OUTPUT_AUDIO_SAMPLE_RATE = 48_000;
const OUTPUT_AUDIO_BITRATE = 160_000;
const FRAME_INDEX_EPSILON = 1e-7;
export const MAX_ACTIVE_IMAGE_ASSET_RGBA_BYTES = 256 * 1024 * 1024;
export const CAPTION_PLACEMENT_ANALYSIS =
  "local-three-band-edge-density-v1";
export const CAPTION_PLACEMENT_SAMPLE_COUNT = 7;

const CAPTION_PLACEMENT_BANDS = Object.freeze([
  Object.freeze({ placement: "top", start: 0.06, end: 0.34 }),
  Object.freeze({ placement: "center", start: 0.36, end: 0.64 }),
  Object.freeze({ placement: "bottom", start: 0.66, end: 0.94 })
]);
const CAPTION_PLACEMENT_TIE_ORDER = Object.freeze({
  bottom: 0,
  top: 1,
  center: 2
});

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw new DOMException("작업이 취소되었습니다.", "AbortError");
  }
}

function createInput(file) {
  return new Input({
    formats: ALL_FORMATS,
    source: new BlobSource(file, { maxCacheSize: 16 * 1024 * 1024 })
  });
}

function humanBytes(value) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = Math.max(0, Number(value) || 0);
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size >= 100 || unit === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`;
}

export function normalizeMediaTimeline(firstTimestampSeconds, endTimestampSeconds) {
  const first = Number(firstTimestampSeconds);
  const end = Number(endTimestampSeconds);
  const originSeconds = Math.max(0, Number.isFinite(first) ? first : 0);
  const mediaEndSeconds = Number.isFinite(end) ? end : originSeconds;
  const durationSeconds = Math.max(0, mediaEndSeconds - originSeconds);
  return {
    originSeconds,
    endSeconds: mediaEndSeconds,
    durationSeconds,
    mediaOriginMs: Math.round(originSeconds * 1000),
    mediaEndTimestampMs: Math.round(mediaEndSeconds * 1000),
    durationMs: Math.round(durationSeconds * 1000)
  };
}

async function readMediaTimeline(input, tracks) {
  const filteredTracks = tracks.filter(Boolean);
  if (filteredTracks.length === 0) {
    return normalizeMediaTimeline(0, 0);
  }

  const firstTimestamp = await input.getFirstTimestamp(filteredTracks);
  const originSeconds = Math.max(0, Number.isFinite(firstTimestamp) ? firstTimestamp : 0);
  let endTimestamp = await input.getDurationFromMetadata(filteredTracks);
  if (!Number.isFinite(endTimestamp) || endTimestamp <= originSeconds) {
    endTimestamp = await input.computeDuration(filteredTracks);
  }
  return normalizeMediaTimeline(originSeconds, endTimestamp);
}

export function validateRenderClips(project, mediaDurationMs) {
  const durationMs = Number(mediaDurationMs);
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new Error("원본 영상의 유효한 재생 길이를 확인하지 못했습니다.");
  }

  const enabledClips = (project?.clips || []).filter((clip) => clip && clip.enabled !== false);
  if (enabledClips.length === 0) {
    throw new Error("내보낼 활성 사용자 선택 구간이 없습니다.");
  }

  let expectedTimelineStartMs = 0;
  for (const [index, clip] of enabledClips.entries()) {
    const sourceStartMs = Number(clip.sourceStartMs);
    const sourceEndMs = Number(clip.sourceEndMs);
    const timelineStartMs = Number(clip.timelineStartMs);
    const label = clip.id || `${index + 1}번째 구간`;

    if (!Number.isFinite(sourceStartMs) || !Number.isFinite(sourceEndMs)) {
      throw new Error(`${label}의 원본 구간 시각이 올바르지 않습니다.`);
    }
    if (sourceStartMs < 0 || sourceEndMs <= sourceStartMs) {
      throw new Error(`${label}의 원본 시작·끝 범위를 확인해 주세요.`);
    }
    if (sourceEndMs > durationMs + 0.5) {
      throw new Error(`${label}이 원본 영상 길이 밖까지 이어집니다.`);
    }
    if (
      !Number.isFinite(timelineStartMs)
      || Math.abs(timelineStartMs - expectedTimelineStartMs) > 0.5
    ) {
      throw new Error(`${label}의 편집 타임라인 위치가 현재 컷 순서와 맞지 않습니다.`);
    }

    expectedTimelineStartMs += sourceEndMs - sourceStartMs;
  }

  return enabledClips;
}

export function buildRenderEncodingSettings(sourceWidth, sourceHeight, packetRate, hasAudio) {
  const { width, height } = scaledDimensions(sourceWidth, sourceHeight);
  const parsedPacketRate = Number(packetRate);
  const frameRate = Number.isFinite(parsedPacketRate) && parsedPacketRate > 0
    ? Math.max(1, Math.min(60, parsedPacketRate))
    : 30;
  return {
    width,
    height,
    frameRate,
    videoBitrate: Math.max(2_500_000, Math.round(width * height * frameRate * 0.08)),
    hasAudio: Boolean(hasAudio)
  };
}

export function createFileWriteTransaction(fileWritable) {
  if (
    !fileWritable
    || typeof fileWritable.write !== "function"
    || typeof fileWritable.close !== "function"
    || typeof fileWritable.abort !== "function"
  ) {
    throw new TypeError("쓰기·닫기·중단을 지원하는 파일 스트림이 필요합니다.");
  }

  let commitRequested = false;
  let settled = false;
  let settling = null;

  const settle = async (mode, reason) => {
    if (settled) {
      return;
    }
    if (settling) {
      try {
        await settling;
      } catch {
        // A failed commit can still be followed by an explicit abort.
      }
      if (settled) {
        return;
      }
    }

    const operation = mode === "commit"
      ? () => fileWritable.close()
      : () => fileWritable.abort(reason);
    settling = (async () => {
      await operation();
      settled = true;
    })();
    try {
      await settling;
    } finally {
      settling = null;
    }
  };

  const writable = new WritableStream({
    write: (chunk) => fileWritable.write(chunk),
    close: () => settle(commitRequested ? "commit" : "abort"),
    abort: (reason) => settle("abort", reason)
  });

  return {
    writable,
    prepareCommit() {
      if (settled) {
        throw new Error("이미 닫힌 파일 스트림은 커밋할 수 없습니다.");
      }
      commitRequested = true;
    },
    abort: (reason) => settle("abort", reason),
    get settled() {
      return settled;
    }
  };
}

export async function inspectMediaFile(file) {
  const input = createInput(file);
  try {
    if (!(await input.canRead())) {
      throw new Error("이 영상 컨테이너를 브라우저에서 읽을 수 없습니다.");
    }
    const [videoTrack, audioTrack] = await Promise.all([
      input.getPrimaryVideoTrack(),
      input.getPrimaryAudioTrack()
    ]);
    const tracks = [videoTrack, audioTrack].filter(Boolean);
    const [
      timeline,
      width,
      height,
      codec,
      audioCodec,
      packetStats,
      videoDecodable,
      audioDecodable
    ] = await Promise.all([
      readMediaTimeline(input, tracks),
      videoTrack?.getDisplayWidth() ?? null,
      videoTrack?.getDisplayHeight() ?? null,
      videoTrack?.getCodec() ?? null,
      audioTrack?.getCodec() ?? null,
      videoTrack?.computePacketStats(100) ?? null,
      videoTrack?.canDecode() ?? false,
      audioTrack?.canDecode() ?? false
    ]);
    const frameRate = packetStats
      ? buildRenderEncodingSettings(width, height, packetStats.averagePacketRate, Boolean(audioTrack)).frameRate
      : null;
    return {
      name: file.name,
      size: file.size,
      sizeLabel: humanBytes(file.size),
      type: file.type,
      lastModified: file.lastModified,
      durationMs: timeline.durationMs,
      mediaOriginMs: timeline.mediaOriginMs,
      mediaEndTimestampMs: timeline.mediaEndTimestampMs,
      width,
      height,
      frameRate,
      codec,
      audioCodec,
      hasVideo: Boolean(videoTrack),
      hasAudio: Boolean(audioTrack),
      videoDecodable: Boolean(videoDecodable),
      audioDecodable: Boolean(audioDecodable)
    };
  } finally {
    input.dispose();
  }
}

export function mixAudioChannelSamples(
  channels,
  left,
  right,
  mix,
  channelMix = "average"
) {
  if (!Array.isArray(channels) || channels.length === 0) {
    return 0;
  }
  if (channelMix === "strongest") {
    let strongest = 0;
    for (const channel of channels) {
      const value = channel[left] * (1 - mix) + channel[right] * mix;
      if (Math.abs(value) > Math.abs(strongest)) {
        strongest = value;
      }
    }
    return strongest;
  }
  if (channelMix !== "average") {
    throw new Error(`지원하지 않는 오디오 채널 혼합 방식입니다: ${channelMix}`);
  }
  let mono = 0;
  for (const channel of channels) {
    mono += channel[left] * (1 - mix) + channel[right] * mix;
  }
  return mono / channels.length;
}

export async function extractClipPcm16k(file, clip, {
  onProgress = () => {},
  signal,
  channelMix = "average"
} = {}) {
  const input = createInput(file);
  try {
    const [videoTrack, audioTrack] = await Promise.all([
      input.getPrimaryVideoTrack(),
      input.getPrimaryAudioTrack()
    ]);
    if (!audioTrack) {
      throw new Error("원본 영상에서 음성 트랙을 찾지 못했습니다.");
    }
    if (!(await audioTrack.canDecode())) {
      throw new Error("이 영상의 음성 코덱을 현재 Chrome에서 디코딩할 수 없습니다.");
    }

    const timeline = await readMediaTimeline(input, [videoTrack, audioTrack]);
    validateRenderClips({
      clips: [{ ...clip, enabled: true, timelineStartMs: 0 }]
    }, timeline.durationSeconds * 1000);

    const startSeconds = timeline.originSeconds + clip.sourceStartMs / 1000;
    const endSeconds = timeline.originSeconds + clip.sourceEndMs / 1000;
    const durationSeconds = (clip.sourceEndMs - clip.sourceStartMs) / 1000;
    const pcm = new Float32Array(Math.ceil(durationSeconds * PCM_SAMPLE_RATE));
    const sink = new AudioBufferSink(audioTrack);
    let writtenUntil = 0;

    for await (const wrapped of sink.buffers(startSeconds, endSeconds)) {
      throwIfAborted(signal);
      const buffer = wrapped.buffer;
      const bufferStart = wrapped.timestamp;
      const bufferEnd = bufferStart + buffer.duration;
      const overlapStart = Math.max(startSeconds, bufferStart);
      const overlapEnd = Math.min(endSeconds, bufferEnd);
      if (overlapEnd <= overlapStart) {
        continue;
      }

      const outputStart = Math.max(0, Math.round((overlapStart - startSeconds) * PCM_SAMPLE_RATE));
      const outputEnd = Math.min(pcm.length, Math.ceil((overlapEnd - startSeconds) * PCM_SAMPLE_RATE));
      const channels = Array.from(
        { length: buffer.numberOfChannels },
        (_, channel) => buffer.getChannelData(channel)
      );
      const sourceRate = buffer.sampleRate;

      for (let outputIndex = outputStart; outputIndex < outputEnd; outputIndex += 1) {
        const absoluteTime = startSeconds + outputIndex / PCM_SAMPLE_RATE;
        const sourcePosition = clampSamplePosition((absoluteTime - bufferStart) * sourceRate, buffer.length);
        const left = Math.floor(sourcePosition);
        const right = Math.min(buffer.length - 1, left + 1);
        const mix = sourcePosition - left;
        pcm[outputIndex] = mixAudioChannelSamples(
          channels,
          left,
          right,
          mix,
          channelMix
        );
      }

      writtenUntil = Math.max(writtenUntil, outputEnd);
      onProgress(pcm.length > 0 ? writtenUntil / pcm.length : 1);
    }
    onProgress(1);
    return pcm;
  } finally {
    input.dispose();
  }
}

function pixelLuminance(data, offset) {
  return (
    data[offset] * 0.2126
    + data[offset + 1] * 0.7152
    + data[offset + 2] * 0.0722
  );
}

function captionBandObstructionScore(data, width, height, band) {
  const startX = Math.max(0, Math.floor(width * 0.04));
  const endX = Math.min(width, Math.ceil(width * 0.96));
  const startY = Math.max(0, Math.floor(height * band.start));
  const endY = Math.min(height, Math.ceil(height * band.end));
  let luminanceTotal = 0;
  let luminanceSquaredTotal = 0;
  let edgeTotal = 0;
  let edgeCount = 0;
  let pixelCount = 0;

  for (let y = startY; y < endY; y += 1) {
    for (let x = startX; x < endX; x += 1) {
      const offset = (y * width + x) * 4;
      const luminance = pixelLuminance(data, offset);
      luminanceTotal += luminance;
      luminanceSquaredTotal += luminance * luminance;
      pixelCount += 1;
      if (x > startX) {
        edgeTotal += Math.abs(
          luminance - pixelLuminance(data, offset - 4)
        );
        edgeCount += 1;
      }
      if (y > startY) {
        edgeTotal += Math.abs(
          luminance - pixelLuminance(data, offset - width * 4)
        );
        edgeCount += 1;
      }
    }
  }

  if (pixelCount === 0) {
    return 1_000;
  }
  const mean = luminanceTotal / pixelCount;
  const variance = Math.max(
    0,
    luminanceSquaredTotal / pixelCount - mean * mean
  );
  const contrast = Math.sqrt(variance);
  const edgeDensity = edgeCount > 0 ? edgeTotal / edgeCount : 0;
  return Math.round(
    clamp((contrast * 1.8 + edgeDensity * 2.2) / 255, 0, 1) * 1_000
  );
}

export function analyzeCaptionPlacementFrame(
  rgba,
  width,
  height
) {
  const normalizedWidth = Number(width);
  const normalizedHeight = Number(height);
  if (
    !rgba
    || !Number.isInteger(normalizedWidth)
    || !Number.isInteger(normalizedHeight)
    || normalizedWidth < 2
    || normalizedHeight < 3
    || rgba.length < normalizedWidth * normalizedHeight * 4
  ) {
    throw new TypeError("자막 안전 영역을 분석할 RGBA 프레임이 올바르지 않습니다.");
  }
  const scores = Object.fromEntries(
    CAPTION_PLACEMENT_BANDS.map((band) => [
      `${band.placement}Score`,
      captionBandObstructionScore(
        rgba,
        normalizedWidth,
        normalizedHeight,
        band
      )
    ])
  );
  const preferredPlacement = CAPTION_PLACEMENT_BANDS
    .map((band) => band.placement)
    .sort((first, second) => (
      scores[`${first}Score`] - scores[`${second}Score`]
      || CAPTION_PLACEMENT_TIE_ORDER[first]
      - CAPTION_PLACEMENT_TIE_ORDER[second]
    ))[0];
  return {
    ...scores,
    preferredPlacement
  };
}

export function fallbackCaptionPlacementHints(durationMs) {
  const duration = Math.max(1, Math.round(Number(durationMs) || 1));
  return {
    analysis: CAPTION_PLACEMENT_ANALYSIS,
    framesShared: false,
    samples: [{
      atMs: Math.min(duration - 1, Math.floor(duration / 2)),
      topScore: 500,
      centerScore: 500,
      bottomScore: 500,
      preferredPlacement: "bottom"
    }]
  };
}

export async function extractClipCaptionPlacementHints(file, clip, {
  onProgress = () => {},
  sampleCount = CAPTION_PLACEMENT_SAMPLE_COUNT,
  signal
} = {}) {
  const input = createInput(file);
  try {
    const [videoTrack, audioTrack] = await Promise.all([
      input.getPrimaryVideoTrack(),
      input.getPrimaryAudioTrack()
    ]);
    if (!videoTrack) {
      throw new Error("자막 위치를 분석할 영상 트랙을 찾지 못했습니다.");
    }
    if (!(await videoTrack.canDecode())) {
      throw new Error("자막 위치 분석을 위해 영상 프레임을 디코딩할 수 없습니다.");
    }
    const timeline = await readMediaTimeline(input, [videoTrack, audioTrack]);
    validateRenderClips({
      clips: [{ ...clip, enabled: true, timelineStartMs: 0 }]
    }, timeline.durationSeconds * 1_000);

    const sourceWidth = await videoTrack.getDisplayWidth();
    const sourceHeight = await videoTrack.getDisplayHeight();
    if (!(sourceWidth > 0) || !(sourceHeight > 0)) {
      throw new Error("자막 위치 분석용 영상 크기를 확인하지 못했습니다.");
    }
    const aspectRatio = sourceWidth / sourceHeight;
    const analysisWidth = aspectRatio >= 1
      ? 160
      : Math.max(64, Math.round(160 * aspectRatio));
    const analysisHeight = aspectRatio >= 1
      ? Math.max(64, Math.round(160 / aspectRatio))
      : 160;
    const canvas = new OffscreenCanvas(analysisWidth, analysisHeight);
    const context = canvas.getContext("2d", {
      alpha: false,
      willReadFrequently: true
    });
    if (!context) {
      throw new Error("자막 위치 분석용 캔버스를 준비하지 못했습니다.");
    }

    const durationMs = Math.round(clip.sourceEndMs - clip.sourceStartMs);
    const count = Math.max(
      1,
      Math.min(
        CAPTION_PLACEMENT_SAMPLE_COUNT,
        durationMs,
        Math.floor(Number(sampleCount)) || CAPTION_PLACEMENT_SAMPLE_COUNT
      )
    );
    const localTimestampsMs = Array.from({ length: count }, (_, index) => (
      Math.max(
        0,
        Math.min(
          durationMs - 1,
          Math.round(durationMs * (index + 0.5) / count)
        )
      )
    ));
    const sourceTimestamps = localTimestampsMs.map((timestampMs) => (
      timeline.originSeconds
      + (clip.sourceStartMs + timestampMs) / 1_000
    ));
    const sink = new VideoSampleSink(videoTrack);
    const samples = [];
    let sampleIndex = 0;
    for await (const sample of sink.samplesAtTimestamps(sourceTimestamps)) {
      try {
        throwIfAborted(signal);
        if (!sample) {
          throw new Error("자막 위치를 분석할 대표 프레임을 읽지 못했습니다.");
        }
        context.fillStyle = "#000";
        context.fillRect(0, 0, analysisWidth, analysisHeight);
        sample.drawWithFit(context, { fit: "cover" });
        const analysis = analyzeCaptionPlacementFrame(
          context.getImageData(
            0,
            0,
            analysisWidth,
            analysisHeight
          ).data,
          analysisWidth,
          analysisHeight
        );
        samples.push({
          atMs: localTimestampsMs[sampleIndex],
          ...analysis
        });
      } finally {
        sample?.close();
      }
      sampleIndex += 1;
      onProgress(sampleIndex / count);
    }
    if (samples.length !== count) {
      throw new Error("자막 위치 분석용 대표 프레임을 모두 읽지 못했습니다.");
    }
    onProgress(1);
    return {
      analysis: CAPTION_PLACEMENT_ANALYSIS,
      framesShared: false,
      samples
    };
  } finally {
    input.dispose();
  }
}

function clampSamplePosition(value, length) {
  return Math.max(0, Math.min(Math.max(0, length - 1), value));
}

export function activeCuesAt(project, outputSeconds) {
  const outputMs = outputSeconds * 1000;
  return project.subtitles
    .map((cue) => ({ cue, range: cueTimelineRange(project, cue) }))
    .filter(({ cue, range }) => range && cue.text.trim() && outputMs >= range.startMs && outputMs < range.endMs)
    .sort((a, b) => (
      (Number(a.cue.lane) || 0) - (Number(b.cue.lane) || 0)
      || a.range.startMs - b.range.startMs
      || String(a.cue.id).localeCompare(String(b.cue.id))
    ))
    .map(({ cue }) => cue);
}

export function activeImageAssetsAt(project, outputSeconds) {
  return imageAssetsAtTimeline(project, Number(outputSeconds) * 1000);
}

export function imageAssetDrawRect(canvas, asset, image) {
  const canvasWidth = Math.max(1, Number(canvas?.width) || 1);
  const canvasHeight = Math.max(1, Number(canvas?.height) || 1);
  const naturalWidth = Math.max(
    1,
    Number(asset?.naturalWidth) || Number(image?.width) || 1
  );
  const naturalHeight = Math.max(
    1,
    Number(asset?.naturalHeight) || Number(image?.height) || 1
  );
  const baseFit = Math.min(
    1,
    canvasWidth * 0.35 / naturalWidth,
    canvasHeight * 0.35 / naturalHeight
  );
  const requestedScale = Number(asset?.scale);
  const scale = clamp(Number.isFinite(requestedScale) ? requestedScale : 1, 0.05, 5);
  const width = naturalWidth * baseFit * scale;
  const height = naturalHeight * baseFit * scale;
  const requestedX = Number(asset?.x);
  const requestedY = Number(asset?.y);
  const centerX = canvasWidth * clamp(Number.isFinite(requestedX) ? requestedX : 0.5, 0, 1);
  const centerY = canvasHeight * clamp(Number.isFinite(requestedY) ? requestedY : 0.5, 0, 1);
  return {
    x: centerX - width / 2,
    y: centerY - height / 2,
    width,
    height
  };
}

export function drawImageAsset(context, canvas, asset, image) {
  if (!context || !asset || !image) {
    return;
  }
  const rect = imageAssetDrawRect(canvas, asset, image);
  context.save();
  context.globalAlpha = clamp(
    Number.isFinite(Number(asset.opacity)) ? Number(asset.opacity) : 1,
    0,
    1
  );
  context.globalCompositeOperation = "source-over";
  context.drawImage(image, rect.x, rect.y, rect.width, rect.height);
  context.restore();
}

async function imageAssetBlob(asset, resolveImageAsset, fetchImageAsset) {
  if (asset.source?.kind === "data-url") {
    if (typeof fetchImageAsset !== "function") {
      throw new Error(`‘${asset.name}’ 이미지 데이터를 읽을 수 있는 fetch 구현이 없습니다.`);
    }
    const response = await fetchImageAsset(asset.source.value);
    if (!response.ok) {
      throw new Error(`‘${asset.name}’ 이미지 데이터를 읽지 못했습니다.`);
    }
    return response.blob();
  }
  if (asset.source?.kind === "blob-key") {
    if (typeof resolveImageAsset !== "function") {
      throw new Error(`‘${asset.name}’ 로컬 이미지 저장소를 연결하지 못했습니다.`);
    }
    const resolved = await resolveImageAsset(asset.source, asset);
    if (!(resolved instanceof Blob)) {
      throw new Error(`‘${asset.name}’ 로컬 이미지 데이터를 읽지 못했습니다.`);
    }
    return resolved;
  }
  throw new Error(`‘${asset.name}’ 이미지 참조가 올바르지 않습니다.`);
}

function decodedImageRgbaBytes(image) {
  const width = Number(image?.width);
  const height = Number(image?.height);
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    throw new Error("디코딩한 이미지 에셋의 크기가 올바르지 않습니다.");
  }
  return Math.ceil(width) * Math.ceil(height) * 4;
}

function imageAssetMetadataRgbaBytes(asset) {
  const width = Number(asset?.naturalWidth);
  const height = Number(asset?.naturalHeight);
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    return null;
  }
  return Math.ceil(width) * Math.ceil(height) * 4;
}

function decodedMemoryLimitLabel(bytes) {
  if (bytes >= 1024 * 1024) {
    return `${Math.round(bytes / (1024 * 1024))} MiB`;
  }
  return `${bytes} B`;
}

function decodedMemoryLimitError(memoryLimit) {
  return new Error(
    `동시에 표시되는 이미지 에셋의 디코드 메모리가 `
    + `${decodedMemoryLimitLabel(memoryLimit)}를 넘습니다. `
    + "이미지 크기나 겹치는 에셋 수를 줄여 주세요."
  );
}

export function createImageAssetRenderCache(project, {
  resolveImageAsset = null,
  fetchImageAsset = globalThis.fetch?.bind(globalThis),
  decodeImageAsset = globalThis.createImageBitmap?.bind(globalThis),
  maxDecodedBytes = MAX_ACTIVE_IMAGE_ASSET_RGBA_BYTES,
  signal
} = {}) {
  const memoryLimit = Number(maxDecodedBytes);
  if (!Number.isFinite(memoryLimit) || memoryLimit <= 0) {
    throw new TypeError("이미지 에셋 디코드 메모리 상한은 0보다 커야 합니다.");
  }

  const decoded = new Map();
  let decodedBytes = 0;

  const closeEntry = (assetId) => {
    const entry = decoded.get(assetId);
    if (!entry) {
      return;
    }
    decoded.delete(assetId);
    decodedBytes = Math.max(0, decodedBytes - entry.bytes);
    entry.image.close?.();
  };

  const closeAll = () => {
    for (const assetId of [...decoded.keys()]) {
      closeEntry(assetId);
    }
  };

  const releaseThrough = (outputSeconds) => {
    const outputMs = Math.round(Number(outputSeconds) * 1000);
    if (!Number.isFinite(outputMs)) {
      return;
    }
    for (const [assetId, entry] of decoded) {
      if (entry.endMs <= outputMs) {
        closeEntry(assetId);
      }
    }
  };

  const prepareAt = async (outputSeconds) => {
    throwIfAborted(signal);
    releaseThrough(outputSeconds);
    const activeAssets = activeImageAssetsAt(project, outputSeconds);

    try {
      for (const asset of activeAssets) {
        if (decoded.has(asset.id)) {
          continue;
        }
        if (typeof decodeImageAsset !== "function") {
          throw new Error("이미지 에셋을 디코딩할 수 있는 브라우저 기능이 없습니다.");
        }

        const metadataBytes = imageAssetMetadataRgbaBytes(asset);
        if (metadataBytes !== null && decodedBytes + metadataBytes > memoryLimit) {
          throw decodedMemoryLimitError(memoryLimit);
        }
        const blob = await imageAssetBlob(asset, resolveImageAsset, fetchImageAsset);
        throwIfAborted(signal);
        if (blob.type && asset.mimeType && blob.type !== asset.mimeType) {
          throw new Error(`‘${asset.name}’ 이미지 형식이 저장 정보와 다릅니다.`);
        }

        const image = await decodeImageAsset(blob);
        try {
          throwIfAborted(signal);
          const bytes = decodedImageRgbaBytes(image);
          if (decodedBytes + bytes > memoryLimit) {
            throw decodedMemoryLimitError(memoryLimit);
          }
          const range = imageAssetTimelineRange(project, asset);
          if (!range) {
            image?.close?.();
            continue;
          }
          decoded.set(asset.id, {
            image,
            bytes,
            endMs: range.endMs
          });
          decodedBytes += bytes;
        } catch (error) {
          image?.close?.();
          throw error;
        }
      }
    } catch (error) {
      closeAll();
      throw error;
    }

    return activeAssets
      .map((asset) => ({
        asset,
        image: decoded.get(asset.id)?.image
      }))
      .filter(({ image }) => Boolean(image));
  };

  return {
    prepareAt,
    releaseThrough,
    closeAll,
    get decodedBytes() {
      return decodedBytes;
    },
    get decodedCount() {
      return decoded.size;
    }
  };
}

export function wrapCaption(context, text, maxWidth) {
  const paragraphs = String(text).split(/\r?\n/);
  const lines = [];
  for (const paragraph of paragraphs) {
    const tokens = paragraph.includes(" ")
      ? paragraph.split(/(\s+)/).filter(Boolean)
      : Array.from(paragraph);
    let line = "";
    for (const token of tokens) {
      const candidate = `${line}${token}`;
      if (line && context.measureText(candidate).width > maxWidth) {
        lines.push(line.trim());
        line = token.trimStart();
      } else {
        line = candidate;
      }
    }
    if (line.trim() || paragraph === "") {
      lines.push(line.trim());
    }
  }
  return lines;
}

export function singleLineCaptionText(text) {
  return String(text ?? "").replace(/\s+/gu, " ").trim();
}

export function fitSingleLineCaptionFontSize({
  baseFontSize,
  measuredWidth,
  maxWidth
}) {
  const normalizedBase = Math.max(1, Number(baseFontSize) || 1);
  const normalizedMeasuredWidth = Math.max(0, Number(measuredWidth) || 0);
  const normalizedMaxWidth = Math.max(1, Number(maxWidth) || 1);
  if (normalizedMeasuredWidth <= normalizedMaxWidth) {
    return normalizedBase;
  }
  return Math.max(
    1,
    Math.floor(
      normalizedBase * normalizedMaxWidth / normalizedMeasuredWidth * 0.96
    )
  );
}

export function clampCaptionBoxCenter({
  requestedX,
  requestedY,
  boxWidth,
  boxHeight,
  canvasWidth,
  canvasHeight,
  safeInset = 0
}) {
  const horizontalInset = Math.min(boxWidth / 2 + safeInset, canvasWidth / 2);
  const verticalInset = Math.min(boxHeight / 2 + safeInset, canvasHeight / 2);
  return {
    x: clamp(
      requestedX,
      horizontalInset,
      canvasWidth - horizontalInset
    ),
    y: clamp(
      requestedY,
      verticalInset,
      canvasHeight - verticalInset
    )
  };
}

function drawCaption(context, canvas, project, cue) {
  if (!cue) {
    return;
  }
  const defaults = project.subtitleDefaults;
  const fontScale = defaults.fontScale || 0.0675;
  let fontSize = Math.max(18, Math.round(Math.min(
    canvas.height * fontScale,
    canvas.width * fontScale * 9 / 16
  )));
  const fontFamily = String(defaults.fontFamily || "Pretendard").replace(/["\\]/gu, "");
  const fontWeight = clamp(Math.round(Number(defaults.fontWeight) || 800), 100, 900);
  const maximumLines = clamp(
    Math.round(Number(defaults.maxLines) || 1),
    1,
    2
  );
  const lineHeightScale = clamp(
    Number(defaults.lineHeight) || 1.24,
    1,
    1.6
  );
  const requestedX = canvas.width * cue.x;
  const requestedY = canvas.height * cue.y;
  const maxWidth = canvas.width * (defaults.maxWidth || 0.86);
  const outlineWidth = Math.max(2, canvas.height * (defaults.outlineWidth || 0.004));
  context.save();
  context.textAlign = defaults.align || "center";
  context.textBaseline = "middle";
  context.lineJoin = "round";

  let lines = [];
  const maximumCaptionHeight = canvas.height * 0.9;
  if (maximumLines === 1) {
    context.font = `${fontWeight} ${fontSize}px "${fontFamily}", "Noto Sans KR", sans-serif`;
    const displayText = singleLineCaptionText(cue.text);
    fontSize = fitSingleLineCaptionFontSize({
      baseFontSize: fontSize,
      measuredWidth: context.measureText(displayText).width,
      maxWidth
    });
    context.font = `${fontWeight} ${fontSize}px "${fontFamily}", "Noto Sans KR", sans-serif`;
    lines = [displayText];
  } else {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      context.font = `${fontWeight} ${fontSize}px "${fontFamily}", "Noto Sans KR", sans-serif`;
      lines = wrapCaption(context, cue.text, maxWidth);
      const measuredHeight = lines.length * fontSize * lineHeightScale + fontSize * 0.3;
      if (
        (
          lines.length <= maximumLines
          && measuredHeight <= maximumCaptionHeight
        )
        || fontSize <= 1
      ) {
        break;
      }
      const lineBudgetScale = lines.length > maximumLines
        ? maximumLines / lines.length
        : 1;
      const heightBudgetScale = measuredHeight > maximumCaptionHeight
        ? maximumCaptionHeight / measuredHeight
        : 1;
      const scaled = Math.floor(
        fontSize * Math.min(lineBudgetScale, heightBudgetScale) * 0.96
      );
      fontSize = Math.max(1, Math.min(fontSize - 1, scaled));
    }
  }
  const lineHeight = fontSize * lineHeightScale;
  const widest = Math.max(...lines.map((line) => context.measureText(line).width), fontSize);
  const boxWidth = Math.min(maxWidth, widest + fontSize * 0.72);
  const boxHeight = lines.length * lineHeight + fontSize * 0.3;
  const safeInset = outlineWidth / 2 + 2;
  const { x, y } = clampCaptionBoxCenter({
    requestedX,
    requestedY,
    boxWidth,
    boxHeight,
    canvasWidth: canvas.width,
    canvasHeight: canvas.height,
    safeInset
  });
  const backgroundColor = String(defaults.backgroundColor || "transparent").trim();
  if (
    backgroundColor
    && backgroundColor !== "transparent"
    && !/^rgba\([^)]*,\s*0(?:\.0+)?\s*\)$/iu.test(backgroundColor)
  ) {
    context.fillStyle = backgroundColor;
    context.beginPath();
    context.roundRect(
      x - boxWidth / 2,
      y - boxHeight / 2,
      boxWidth,
      boxHeight,
      Math.max(5, fontSize * 0.14)
    );
    context.fill();
  }

  const firstY = y - ((lines.length - 1) * lineHeight) / 2;
  const textX = context.textAlign === "left"
    ? x - boxWidth / 2 + fontSize * 0.36
    : context.textAlign === "right"
      ? x + boxWidth / 2 - fontSize * 0.36
      : x;
  context.lineWidth = outlineWidth;
  context.strokeStyle = defaults.outlineColor || "#111111";
  context.fillStyle = cue.color || defaults.color || "#ffffff";
  context.shadowColor = String(
    defaults.shadowColor || "rgba(0, 0, 0, 0.45)"
  );
  context.shadowOffsetX = fontSize * (
    Number(defaults.shadowOffsetXEm) || 0
  );
  context.shadowOffsetY = fontSize * (
    Number(defaults.shadowOffsetYEm) || 0
  );
  context.shadowBlur = fontSize * Math.max(
    0,
    Number(defaults.shadowBlurEm) || 0
  );
  lines.forEach((line, index) => {
    const lineY = firstY + index * lineHeight;
    context.strokeText(line, textX, lineY, maxWidth);
    context.fillText(line, textX, lineY, maxWidth);
  });
  context.restore();
}

export async function chooseOutputCodecs(settings, {
  videoProbe = canEncodeVideo,
  audioProbe = canEncodeAudio
} = {}) {
  const videoOptions = {
    width: settings.width,
    height: settings.height,
    bitrate: settings.videoBitrate,
    latencyMode: "quality"
  };
  const audioOptions = {
    numberOfChannels: OUTPUT_AUDIO_CHANNELS,
    sampleRate: OUTPUT_AUDIO_SAMPLE_RATE,
    bitrate: OUTPUT_AUDIO_BITRATE
  };
  const findVideoAcceleration = async (codec) => {
    for (const hardwareAcceleration of [
      "prefer-hardware",
      "no-preference",
      "prefer-software"
    ]) {
      if (await videoProbe(codec, {
        ...videoOptions,
        hardwareAcceleration
      })) {
        return hardwareAcceleration;
      }
    }
    return null;
  };

  const aac = settings.hasAudio ? await audioProbe("aac", audioOptions) : true;
  const avcAcceleration = aac ? await findVideoAcceleration("avc") : null;
  if (avcAcceleration) {
    return {
      extension: "mp4",
      mimeType: "video/mp4",
      format: new Mp4OutputFormat({ fastStart: false }),
      videoCodec: "avc",
      audioCodec: settings.hasAudio ? "aac" : null,
      hardwareAcceleration: avcAcceleration
    };
  }

  const opus = settings.hasAudio ? await audioProbe("opus", audioOptions) : true;
  const vp9Acceleration = opus ? await findVideoAcceleration("vp9") : null;
  if (!vp9Acceleration) {
    throw new Error(
      settings.hasAudio
        ? "현재 Chrome에서 H.264/AAC 또는 VP9/Opus 영상 인코더를 사용할 수 없습니다."
        : "현재 Chrome에서 H.264 또는 VP9 영상 인코더를 사용할 수 없습니다."
    );
  }
  return {
    extension: "webm",
    mimeType: "video/webm",
    format: new WebMOutputFormat(),
    videoCodec: "vp9",
    audioCodec: settings.hasAudio ? "opus" : null,
    hardwareAcceleration: vp9Acceleration
  };
}

function scaledDimensions(width, height) {
  const sourceWidth = Math.max(2, width || 1280);
  const sourceHeight = Math.max(2, height || 720);
  const scale = Math.min(1, 1920 / sourceWidth, 1080 / sourceHeight);
  return {
    width: Math.max(2, Math.round(sourceWidth * scale / 2) * 2),
    height: Math.max(2, Math.round(sourceHeight * scale / 2) * 2)
  };
}

async function prepareRenderSource(input, project) {
  validateRenderTimeline(project);
  const [videoTrack, audioTrack] = await Promise.all([
    input.getPrimaryVideoTrack(),
    input.getPrimaryAudioTrack()
  ]);
  if (!videoTrack) {
    throw new Error("원본에서 영상 트랙을 찾지 못했습니다.");
  }

  const [videoDecodable, audioDecodable] = await Promise.all([
    videoTrack.canDecode(),
    audioTrack ? audioTrack.canDecode() : true
  ]);
  if (!videoDecodable) {
    throw new Error("이 영상 코덱을 현재 Chrome에서 디코딩할 수 없습니다.");
  }
  if (!audioDecodable) {
    throw new Error("원본의 음성 트랙을 현재 Chrome에서 디코딩할 수 없습니다.");
  }

  const [timeline, sourceWidth, sourceHeight, packetStats] = await Promise.all([
    readMediaTimeline(input, [videoTrack, audioTrack]),
    videoTrack.getDisplayWidth(),
    videoTrack.getDisplayHeight(),
    videoTrack.computePacketStats(100)
  ]);
  const settings = buildRenderEncodingSettings(
    sourceWidth,
    sourceHeight,
    packetStats.averagePacketRate,
    Boolean(audioTrack)
  );
  const clips = validateRenderClips(project, timeline.durationSeconds * 1000);
  return {
    videoTrack,
    audioTrack,
    timeline,
    settings,
    clips
  };
}

export function validateRenderTimeline(project) {
  const subtitleOverlaps = findSubtitleOverlaps(project);
  if (subtitleOverlaps.length > 0) {
    throw new Error(
      "같은 자막 레인에서 서로 겹치는 자막이 있습니다. 자막 시작·끝 또는 레인을 조정해 주세요."
    );
  }
  const audioOverlaps = findAudioRegionOverlaps(project);
  if (audioOverlaps.length > 0) {
    throw new Error(
      "서로 겹치는 음성 설정 구간이 있습니다. 음성 구간 시작·끝을 겹치지 않게 조정해 주세요."
    );
  }
}

export async function getPreferredOutputProfile(file, project) {
  const input = createInput(file);
  try {
    const source = await prepareRenderSource(input, project);
    const profile = await chooseOutputCodecs(source.settings);
    return {
      extension: profile.extension,
      mimeType: profile.mimeType
    };
  } finally {
    input.dispose();
  }
}

export function cfrFrameRange(clip, frameRate) {
  const rate = Number(frameRate);
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new TypeError("CFR 프레임률은 0보다 큰 숫자여야 합니다.");
  }
  const durationSeconds = (
    Number(clip.sourceEndMs) - Number(clip.sourceStartMs)
  ) / 1000;
  const firstFrameIndex = 0;
  const endFrameIndex = Math.max(
    firstFrameIndex,
    Math.ceil(durationSeconds * rate - FRAME_INDEX_EPSILON)
  );
  return { firstFrameIndex, endFrameIndex };
}

export function cfrFrameTiming(clip, frameIndex, frameRate) {
  const rate = Number(frameRate);
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new TypeError("CFR 프레임률은 0보다 큰 숫자여야 합니다.");
  }
  if (!Number.isInteger(frameIndex) || frameIndex < 0) {
    throw new TypeError("CFR 프레임 인덱스는 0 이상의 정수여야 합니다.");
  }
  const timelineStartSeconds = Number(clip.timelineStartMs) / 1000;
  const clipDurationSeconds = (
    Number(clip.sourceEndMs) - Number(clip.sourceStartMs)
  ) / 1000;
  const localTimestamp = frameIndex / rate;
  const outputTimestamp = timelineStartSeconds + localTimestamp;
  return {
    localTimestamp,
    outputTimestamp,
    duration: Math.max(
      0,
      Math.min(1 / rate, timelineStartSeconds + clipDurationSeconds - outputTimestamp)
    )
  };
}

export function audioTrimFrameRange(sample, startSeconds, endSeconds) {
  const frameStart = Math.max(
    0,
    Math.min(
      sample.numberOfFrames,
      Math.round((startSeconds - sample.timestamp) * sample.sampleRate)
    )
  );
  const frameEnd = Math.max(
    0,
    Math.min(
      sample.numberOfFrames,
      Math.round((endSeconds - sample.timestamp) * sample.sampleRate)
    )
  );
  return { frameStart, frameEnd };
}

export function buildAudioAutomation(project) {
  return (project?.audioRegions || [])
    .map((region) => {
      const range = audioRegionTimelineRange(project, region);
      if (!range) {
        return null;
      }
      return {
        id: region.id,
        startSeconds: range.startMs / 1000,
        endSeconds: range.endMs / 1000,
        targetGain: region.muted
          ? 0
          : clamp(Number.isFinite(Number(region.gain)) ? Number(region.gain) : 1, 0, 1),
        fadeInSeconds: clamp(
          (Number.isFinite(Number(region.fadeInMs)) ? Number(region.fadeInMs) : 0) / 1000,
          0,
          Math.max(0, (range.endMs - range.startMs) / 1000)
        ),
        fadeOutSeconds: clamp(
          (Number.isFinite(Number(region.fadeOutMs)) ? Number(region.fadeOutMs) : 0) / 1000,
          0,
          Math.max(0, (range.endMs - range.startMs) / 1000)
        )
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.startSeconds - b.startSeconds || a.endSeconds - b.endSeconds);
}

export function audioAutomationGainAt(automation, outputSeconds) {
  const time = Number(outputSeconds);
  if (!Number.isFinite(time)) {
    return 1;
  }
  const segment = automation.find((candidate) => (
    time >= candidate.startSeconds && time < candidate.endSeconds
  ));
  if (!segment) {
    return 1;
  }

  // Regions are non-destructive overrides: fades move from the untouched source
  // level (1) into the region setting, then back to the untouched level.
  let blend = 1;
  if (segment.fadeInSeconds > 0) {
    blend = Math.min(
      blend,
      clamp((time - segment.startSeconds) / segment.fadeInSeconds, 0, 1)
    );
  }
  if (segment.fadeOutSeconds > 0) {
    blend = Math.min(
      blend,
      clamp((segment.endSeconds - time) / segment.fadeOutSeconds, 0, 1)
    );
  }
  return 1 + (segment.targetGain - 1) * blend;
}

export function applyAudioAutomationToSample(sample, automation) {
  const sampleStart = sample.timestamp;
  const sampleEnd = sample.timestamp + sample.duration;
  const relevantAutomation = automation.filter((segment) => (
    segment.targetGain !== 1
    && segment.startSeconds < sampleEnd
    && segment.endSeconds > sampleStart
  ));
  if (relevantAutomation.length === 0) {
    return sample;
  }

  const data = new Float32Array(sample.numberOfFrames * sample.numberOfChannels);
  sample.copyTo(data, { planeIndex: 0, format: "f32" });
  for (let frameIndex = 0; frameIndex < sample.numberOfFrames; frameIndex += 1) {
    const outputSeconds = sample.timestamp + frameIndex / sample.sampleRate;
    const gain = audioAutomationGainAt(relevantAutomation, outputSeconds);
    const frameOffset = frameIndex * sample.numberOfChannels;
    for (let channel = 0; channel < sample.numberOfChannels; channel += 1) {
      data[frameOffset + channel] *= gain;
    }
  }
  return new AudioSample({
    data,
    format: "f32",
    numberOfChannels: sample.numberOfChannels,
    sampleRate: sample.sampleRate,
    timestamp: sample.timestamp
  });
}

export async function renderProjectVideo(file, project, {
  fileHandle = null,
  onProgress = () => {},
  resolveImageAsset = null,
  signal
} = {}) {
  throwIfAborted(signal);
  const input = createInput(file);
  let output = null;
  let fileTransaction = null;
  let imageAssetCache = null;
  let completed = false;
  try {
    const source = await prepareRenderSource(input, project);
    const {
      videoTrack,
      audioTrack,
      timeline,
      settings,
      clips
    } = source;
    const {
      width,
      height,
      frameRate,
      videoBitrate
    } = settings;
    imageAssetCache = createImageAssetRenderCache(project, {
      resolveImageAsset,
      signal
    });
    const outputCodecs = await chooseOutputCodecs(settings);
    let target;
    if (fileHandle) {
      fileTransaction = createFileWriteTransaction(await fileHandle.createWritable());
      target = new StreamTarget(fileTransaction.writable, { chunked: true });
    } else {
      target = new BufferTarget();
    }
    output = new Output({ format: outputCodecs.format, target });

    const videoSource = new VideoSampleSource({
      codec: outputCodecs.videoCodec,
      bitrate: videoBitrate,
      keyFrameInterval: 2,
      hardwareAcceleration: outputCodecs.hardwareAcceleration,
      latencyMode: "quality"
    });
    output.addVideoTrack(videoSource, { frameRate });

    let audioSource = null;
    if (audioTrack) {
      audioSource = new AudioSampleSource({
        codec: outputCodecs.audioCodec,
        bitrate: OUTPUT_AUDIO_BITRATE,
        transform: {
          numberOfChannels: OUTPUT_AUDIO_CHANNELS,
          sampleRate: OUTPUT_AUDIO_SAMPLE_RATE
        }
      });
      output.addAudioTrack(audioSource);
    }
    output.setMetadataTags({
      title: project.name,
      comment: "Created with CHZZK Kirinuki Studio"
    });
    await output.start();

    const totalDurationMs = clips.reduce(
      (total, clip) => total + clip.sourceEndMs - clip.sourceStartMs,
      0
    );
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) {
      throw new Error("영상 자막을 그릴 2D 캔버스를 준비하지 못했습니다.");
    }
    const videoSink = new VideoSampleSink(videoTrack);
    const audioSink = audioTrack && audioSource ? new AudioSampleSink(audioTrack) : null;
    const audioAutomation = buildAudioAutomation(project);
    const pumpState = {
      stopped: false,
      primaryError: null
    };

    const pumpVideo = async () => {
      for (const clip of clips) {
        if (pumpState.stopped) {
          return;
        }
        const { firstFrameIndex, endFrameIndex } = cfrFrameRange(clip, frameRate);
        const sourceTimestamps = (function* generateSourceTimestamps() {
          for (let frameIndex = firstFrameIndex; frameIndex < endFrameIndex; frameIndex += 1) {
            yield timeline.originSeconds
              + clip.sourceStartMs / 1000
              + frameIndex / frameRate;
          }
        })();
        let frameIndex = firstFrameIndex;
        for await (const sourceSample of videoSink.samplesAtTimestamps(sourceTimestamps)) {
          try {
            if (pumpState.stopped) {
              return;
            }
            throwIfAborted(signal);
            const timing = cfrFrameTiming(clip, frameIndex, frameRate);
            frameIndex += 1;
            if (timing.duration <= 0) {
              continue;
            }
            context.fillStyle = "#000";
            context.fillRect(0, 0, width, height);
            sourceSample?.drawWithFit(context, { fit: "contain" });
            const activeImageAssets = await imageAssetCache.prepareAt(timing.outputTimestamp);
            for (const { asset, image } of activeImageAssets) {
              drawImageAsset(context, canvas, asset, image);
            }
            imageAssetCache.releaseThrough(timing.outputTimestamp + timing.duration);
            for (const cue of activeCuesAt(project, timing.outputTimestamp)) {
              drawCaption(context, canvas, project, cue);
            }
            const outputSample = new VideoSample(canvas, {
              timestamp: timing.outputTimestamp,
              duration: timing.duration
            });
            try {
              await videoSource.add(outputSample);
            } finally {
              outputSample.close();
            }
            onProgress(
              Math.min(0.98, (timing.outputTimestamp * 1000) / totalDurationMs),
              "video"
            );
          } finally {
            sourceSample?.close();
          }
        }
        if (frameIndex !== endFrameIndex) {
          throw new Error("원본 영상의 CFR 프레임을 모두 읽지 못했습니다.");
        }
      }
      if (!pumpState.stopped) {
        videoSource.close();
      }
    };

    const pumpAudio = async () => {
      if (!audioSink || !audioSource) {
        return;
      }
      for (const clip of clips) {
        if (pumpState.stopped) {
          return;
        }
        const start = timeline.originSeconds + clip.sourceStartMs / 1000;
        const end = timeline.originSeconds + clip.sourceEndMs / 1000;
        const timelineStart = clip.timelineStartMs / 1000;
        for await (const sourceSample of audioSink.samples(start, end)) {
          try {
            if (pumpState.stopped) {
              return;
            }
            throwIfAborted(signal);
            const { frameStart, frameEnd } = audioTrimFrameRange(sourceSample, start, end);
            if (frameEnd <= frameStart) {
              continue;
            }
            const trimmed = sourceSample.trim(frameStart, frameEnd);
            try {
              trimmed.setTimestamp(timelineStart + trimmed.timestamp - start);
              const automated = applyAudioAutomationToSample(trimmed, audioAutomation);
              try {
                await audioSource.add(automated);
              } finally {
                if (automated !== trimmed) {
                  automated.close();
                }
              }
            } finally {
              trimmed.close();
            }
          } finally {
            sourceSample.close();
          }
        }
      }
      if (!pumpState.stopped) {
        audioSource.close();
      }
    };

    const runPump = async (pump) => {
      try {
        await pump();
      } catch (error) {
        pumpState.primaryError ||= error;
        pumpState.stopped = true;
        throw error;
      }
    };
    const pumpResults = await Promise.allSettled([
      runPump(pumpVideo),
      runPump(pumpAudio)
    ]);
    const rejectedPump = pumpResults.find((result) => result.status === "rejected");
    if (rejectedPump) {
      throw pumpState.primaryError || rejectedPump.reason;
    }

    throwIfAborted(signal);
    onProgress(0.995, "finalize");
    fileTransaction?.prepareCommit();
    await output.finalize();
    completed = true;
    onProgress(1, "finalize");

    if (target instanceof BufferTarget) {
      return {
        blob: new Blob([target.buffer], { type: outputCodecs.mimeType }),
        ...outputCodecs,
        width,
        height,
        frameRate
      };
    }
    return {
      blob: null,
      ...outputCodecs,
      width,
      height,
      frameRate
    };
  } catch (error) {
    if (output && output.state !== "finalized" && output.state !== "canceled") {
      await output.cancel().catch(() => {});
    }
    if (fileTransaction && !fileTransaction.settled) {
      await fileTransaction.abort(error).catch(() => {});
    }
    throw error;
  } finally {
    input.dispose();
    imageAssetCache?.closeAll();
    if (!completed && fileTransaction && !fileTransaction.settled) {
      await fileTransaction.abort().catch(() => {});
    }
  }
}
