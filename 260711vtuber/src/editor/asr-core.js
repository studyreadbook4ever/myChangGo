const DEFAULT_SAMPLE_RATE = 16_000;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function frameRms(audio, start, end) {
  let energy = 0;
  for (let index = start; index < end; index += 1) {
    const sample = audio[index];
    energy += sample * sample;
  }
  return Math.sqrt(energy / Math.max(1, end - start));
}

/**
 * Finds padded speech-like ranges before Whisper inference. This is deliberately
 * conservative: its main job is to skip digital/near silence and split long
 * selections so silence cannot make Whisper repeat a hallucinated phrase.
 */
export function detectSpeechRanges(audio, {
  sampleRate = DEFAULT_SAMPLE_RATE,
  frameMs = 30,
  absoluteRmsFloor = 0.0025,
  minimumVoicedMs = 180,
  maximumGapMs = 600,
  paddingMs = 240,
  maximumRangeSeconds = 28
} = {}) {
  if (!(audio instanceof Float32Array) || audio.length === 0) {
    return [];
  }

  const frameSize = Math.max(1, Math.round(sampleRate * frameMs / 1000));
  const frameCount = Math.ceil(audio.length / frameSize);
  const energies = new Float32Array(frameCount);
  let peakRms = 0;
  for (let frame = 0; frame < frameCount; frame += 1) {
    const start = frame * frameSize;
    const end = Math.min(audio.length, start + frameSize);
    const rms = frameRms(audio, start, end);
    energies[frame] = rms;
    peakRms = Math.max(peakRms, rms);
  }
  if (peakRms < absoluteRmsFloor) {
    return [];
  }

  const sorted = [...energies].sort((left, right) => left - right);
  const baselineRms = sorted[Math.floor((sorted.length - 1) * 0.2)] || 0;
  const thresholdRms = Math.max(
    absoluteRmsFloor,
    Math.min(peakRms * 0.55, baselineRms * 2.8 + 0.0005)
  );
  const maximumGapFrames = Math.max(0, Math.ceil(maximumGapMs / frameMs));
  const minimumVoicedFrames = Math.max(1, Math.ceil(minimumVoicedMs / frameMs));
  const paddingFrames = Math.max(0, Math.ceil(paddingMs / frameMs));
  const rawRanges = [];
  let startFrame = null;
  let lastVoicedFrame = null;
  let voicedFrames = 0;

  const finishRange = () => {
    if (startFrame === null || lastVoicedFrame === null || voicedFrames < minimumVoicedFrames) {
      startFrame = null;
      lastVoicedFrame = null;
      voicedFrames = 0;
      return;
    }
    rawRanges.push({
      startSample: Math.max(0, (startFrame - paddingFrames) * frameSize),
      endSample: Math.min(audio.length, (lastVoicedFrame + 1 + paddingFrames) * frameSize)
    });
    startFrame = null;
    lastVoicedFrame = null;
    voicedFrames = 0;
  };

  for (let frame = 0; frame < frameCount; frame += 1) {
    if (energies[frame] >= thresholdRms) {
      if (startFrame === null) {
        startFrame = frame;
      }
      lastVoicedFrame = frame;
      voicedFrames += 1;
    } else if (
      lastVoicedFrame !== null &&
      frame - lastVoicedFrame > maximumGapFrames
    ) {
      finishRange();
    }
  }
  finishRange();

  const mergedRanges = [];
  for (const range of rawRanges) {
    const previous = mergedRanges.at(-1);
    if (previous && range.startSample <= previous.endSample) {
      previous.endSample = Math.max(previous.endSample, range.endSample);
    } else {
      mergedRanges.push({ ...range });
    }
  }

  const maximumRangeSamples = Math.max(
    frameSize,
    Math.round(maximumRangeSeconds * sampleRate)
  );
  const ranges = [];
  for (const range of mergedRanges) {
    for (let cursor = range.startSample; cursor < range.endSample; cursor += maximumRangeSamples) {
      ranges.push({
        startSample: cursor,
        endSample: Math.min(range.endSample, cursor + maximumRangeSamples)
      });
    }
  }

  return ranges.map((range) => ({
    ...range,
    startSeconds: range.startSample / sampleRate,
    endSeconds: range.endSample / sampleRate,
    thresholdRms
  }));
}

const normalizedText = (value) => String(value || "")
  .normalize("NFKC")
  .toLocaleLowerCase("ko")
  .replace(/[\s\p{P}\p{S}]+/gu, "");

export function normalizeTranscriptChunks(chunks, {
  offsetSeconds = 0,
  durationSeconds = Infinity
} = {}) {
  const boundedDuration = Number.isFinite(durationSeconds)
    ? Math.max(0, durationSeconds)
    : Infinity;
  const normalized = [];

  for (const chunk of Array.isArray(chunks) ? chunks : []) {
    const text = String(chunk?.text || "").trim();
    const rawStart = Number(chunk?.timestamp?.[0]);
    const rawEnd = Number(chunk?.timestamp?.[1]);
    if (!text || !Number.isFinite(rawStart) || !Number.isFinite(rawEnd)) {
      continue;
    }
    const localStart = clamp(rawStart, 0, boundedDuration);
    const localEnd = clamp(rawEnd, 0, boundedDuration);
    if (localEnd - localStart < 0.03) {
      continue;
    }
    const next = {
      text,
      timestamp: [
        offsetSeconds + localStart,
        offsetSeconds + localEnd
      ]
    };
    const previous = normalized.at(-1);
    const repeatedAtSameTime = previous
      && normalizedText(previous.text) === normalizedText(next.text)
      && Math.abs(previous.timestamp[0] - next.timestamp[0]) < 0.12
      && Math.abs(previous.timestamp[1] - next.timestamp[1]) < 0.2;
    if (!repeatedAtSameTime) {
      normalized.push(next);
    }
  }
  return normalized;
}

export function mergeTranscriptChunks(groups) {
  const chunks = (Array.isArray(groups) ? groups : [])
    .flatMap((group) => Array.isArray(group) ? group : [])
    .sort((left, right) => left.timestamp[0] - right.timestamp[0]);
  const merged = [];
  for (const chunk of chunks) {
    const previous = merged.at(-1);
    const duplicate = previous
      && normalizedText(previous.text) === normalizedText(chunk.text)
      && chunk.timestamp[0] < previous.timestamp[1] + 0.08;
    if (!duplicate) {
      merged.push(chunk);
    }
  }
  return merged;
}
