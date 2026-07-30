// src/editor/audseg.js
var AUDSEG_ENGINE_ID = "audseg";
var AUDSEG_ENGINE_VERSION = "0.1.0";
var AUDSEG_SAMPLE_RATE_HZ = 16e3;
var MAX_AUDSEG_CLIP_DURATION_MS = 30 * 60 * 1e3;
var MAX_AUDSEG_PCM_BYTES = 128 * 1024 * 1024;
var AUDSEG_PIPELINE_FINGERPRINT = "audseg-browser-v1-0.1.0-frame20-hop10-max4000";
var DEFAULT_AUDSEG_CONFIG = Object.freeze({
  detector: Object.freeze({
    frameMs: 20,
    hopMs: 10,
    noisePercentile: 0.2,
    noiseCeilingDbfs: -45,
    minimumOnDbfs: -65,
    minimumOffDbfs: -68,
    onMarginDb: 10,
    offMarginDb: 6,
    peakGuardDb: 6,
    hysteresisDb: 4,
    fixedThresholdDbfs: null,
    onsetMs: 40,
    releaseMs: 250,
    minRegionMs: 120,
    mergeGapMs: 100,
    padStartMs: 40,
    padEndMs: 80
  }),
  cues: Object.freeze({
    maxDurationMs: 4e3,
    minSplitDurationMs: 500,
    splitSearchMs: 2e3
  })
});
var DBFS_FLOOR = -120;
function millisecondsToSamples(milliseconds, sampleRateHz, {
  minimum = 0
} = {}) {
  return Math.max(
    minimum,
    Math.round(Number(milliseconds) * sampleRateHz / 1e3)
  );
}
function powerToDbfs(power) {
  return 10 * Math.log10(Math.max(power, 1e-12));
}
function frameDbfs(sampleSum, squareSum, count) {
  const mean = sampleSum / count;
  const variance = Math.max(0, squareSum / count - mean * mean);
  return powerToDbfs(variance);
}
function validateSamples(samples, sampleRateHz) {
  if (!(samples instanceof Float32Array)) {
    throw new TypeError("AudSeg\uC5D0\uB294 Float32 PCM \uC624\uB514\uC624\uAC00 \uD544\uC694\uD569\uB2C8\uB2E4.");
  }
  if (!Number.isInteger(sampleRateHz) || sampleRateHz <= 0) {
    throw new RangeError("AudSeg sample rate\uB294 \uC591\uC758 \uC815\uC218\uC5EC\uC57C \uD569\uB2C8\uB2E4.");
  }
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index];
    if (!Number.isFinite(sample) || sample < -1.000001 || sample > 1.000001) {
      throw new RangeError("AudSeg PCM \uD45C\uBCF8\uC740 -1\uBD80\uD130 1 \uC0AC\uC774\uC758 \uC720\uD55C\uD55C \uAC12\uC774\uC5B4\uC57C \uD569\uB2C8\uB2E4.");
    }
    if (sample < -1 || sample > 1) {
      samples[index] = Math.max(-1, Math.min(1, sample));
    }
  }
}
function extractAudSegFrameLevels(samples, sampleRateHz = AUDSEG_SAMPLE_RATE_HZ, detector = DEFAULT_AUDSEG_CONFIG.detector) {
  validateSamples(samples, sampleRateHz);
  const frameSamples = Math.max(
    1,
    millisecondsToSamples(detector.frameMs, sampleRateHz)
  );
  const hopSamples = Math.min(
    frameSamples,
    Math.max(1, millisecondsToSamples(detector.hopMs, sampleRateHz))
  );
  const levels = [];
  let frameStart = 0;
  let lastEmittedEnd = 0;
  while (frameStart + frameSamples <= samples.length) {
    let sampleSum = 0;
    let squareSum = 0;
    const frameEnd = frameStart + frameSamples;
    for (let index = frameStart; index < frameEnd; index += 1) {
      const sample = samples[index];
      sampleSum += sample;
      squareSum += sample * sample;
    }
    levels.push({
      startSample: frameStart,
      endSample: frameEnd,
      dbfs: frameDbfs(sampleSum, squareSum, frameSamples)
    });
    lastEmittedEnd = frameEnd;
    frameStart += hopSamples;
  }
  if (frameStart < samples.length && lastEmittedEnd < samples.length) {
    let sampleSum = 0;
    let squareSum = 0;
    for (let index = frameStart; index < samples.length; index += 1) {
      const sample = samples[index];
      sampleSum += sample;
      squareSum += sample * sample;
    }
    levels.push({
      startSample: frameStart,
      endSample: samples.length,
      dbfs: frameDbfs(
        sampleSum,
        squareSum,
        samples.length - frameStart
      )
    });
  }
  return {
    levels,
    totalSamples: samples.length
  };
}
function percentile(values, fraction) {
  if (values.length === 0) {
    return DBFS_FLOOR;
  }
  const ordered = [...values].sort((left, right) => left - right);
  const position = (ordered.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) {
    return ordered[lower];
  }
  const weight = position - lower;
  return ordered[lower] * (1 - weight) + ordered[upper] * weight;
}
function thresholds(levels, detector) {
  const values = levels.map((frame) => frame.dbfs);
  const estimatedNoiseDbfs = percentile(values, detector.noisePercentile);
  const effectiveNoiseDbfs = Math.min(
    estimatedNoiseDbfs,
    detector.noiseCeilingDbfs
  );
  const peakDbfs = values.reduce(
    (peak, value) => Math.max(peak, value),
    DBFS_FLOOR
  );
  let startThresholdDbfs;
  let stopThresholdDbfs;
  if (detector.fixedThresholdDbfs != null) {
    startThresholdDbfs = detector.fixedThresholdDbfs;
    stopThresholdDbfs = Math.max(
      DBFS_FLOOR,
      startThresholdDbfs - detector.hysteresisDb
    );
  } else {
    const adaptiveOn = effectiveNoiseDbfs + detector.onMarginDb;
    const peakGuarded = peakDbfs - detector.peakGuardDb;
    startThresholdDbfs = Math.max(
      detector.minimumOnDbfs,
      Math.min(adaptiveOn, peakGuarded)
    );
    const adaptiveOff = effectiveNoiseDbfs + detector.offMarginDb;
    stopThresholdDbfs = Math.max(
      detector.minimumOffDbfs,
      Math.min(
        adaptiveOff,
        startThresholdDbfs - detector.hysteresisDb
      )
    );
    if (stopThresholdDbfs >= startThresholdDbfs) {
      stopThresholdDbfs = Math.max(
        DBFS_FLOOR,
        startThresholdDbfs - 0.1
      );
    }
  }
  return {
    estimatedNoiseDbfs,
    effectiveNoiseDbfs,
    peakDbfs,
    startThresholdDbfs,
    stopThresholdDbfs
  };
}
function rawRegions(levels, totalSamples, sampleRateHz, detector, startThresholdDbfs, stopThresholdDbfs) {
  const onsetSamples = millisecondsToSamples(
    detector.onsetMs,
    sampleRateHz,
    { minimum: 1 }
  );
  const releaseSamples = millisecondsToSamples(
    detector.releaseMs,
    sampleRateHz,
    { minimum: 1 }
  );
  let candidateStart = null;
  let activeStart = null;
  let lastActiveEnd = null;
  const regions = [];
  for (const frame of levels) {
    if (activeStart == null) {
      if (frame.dbfs >= startThresholdDbfs) {
        candidateStart ??= frame.startSample;
        if (frame.endSample - candidateStart >= onsetSamples) {
          activeStart = candidateStart;
          lastActiveEnd = frame.endSample;
          candidateStart = null;
        }
      } else {
        candidateStart = null;
      }
      continue;
    }
    if (frame.dbfs >= stopThresholdDbfs && frame.dbfs > DBFS_FLOOR) {
      lastActiveEnd = Math.max(lastActiveEnd ?? frame.endSample, frame.endSample);
      continue;
    }
    if (frame.endSample - lastActiveEnd >= releaseSamples) {
      regions.push({
        startSample: activeStart,
        endSample: Math.min(lastActiveEnd, totalSamples),
        endReason: "silence"
      });
      activeStart = null;
      lastActiveEnd = null;
      candidateStart = null;
    }
  }
  if (activeStart != null && lastActiveEnd != null) {
    regions.push({
      startSample: activeStart,
      endSample: Math.min(lastActiveEnd, totalSamples),
      endReason: "eof"
    });
  }
  return regions;
}
function mergeRawRegions(regions, sampleRateHz, detector) {
  const mergeGap = millisecondsToSamples(
    detector.mergeGapMs,
    sampleRateHz
  );
  const minimum = millisecondsToSamples(
    detector.minRegionMs,
    sampleRateHz
  );
  const merged = [];
  for (const region of regions) {
    if (region.endSample - region.startSample < minimum) {
      continue;
    }
    const previous = merged.at(-1);
    if (previous && region.startSample - previous.endSample <= mergeGap) {
      previous.endSample = Math.max(previous.endSample, region.endSample);
      previous.endReason = region.endReason === "silence" ? "merged" : region.endReason;
    } else {
      merged.push({ ...region });
    }
  }
  return merged;
}
function levelStats(values) {
  if (values.length === 0) {
    return { peakDbfs: DBFS_FLOOR, meanDbfs: DBFS_FLOOR };
  }
  const meanPower = values.reduce(
    (total, value) => total + 10 ** (value / 10),
    0
  ) / values.length;
  return {
    peakDbfs: values.reduce(
      (peak, value) => Math.max(peak, value),
      DBFS_FLOOR
    ),
    meanDbfs: powerToDbfs(meanPower)
  };
}
function padRegions(regions, levels, totalSamples, sampleRateHz, detector) {
  const padStart = millisecondsToSamples(
    detector.padStartMs,
    sampleRateHz
  );
  const padEnd = millisecondsToSamples(
    detector.padEndMs,
    sampleRateHz
  );
  const padded = regions.map((region) => ({
    startSample: Math.max(0, region.startSample - padStart),
    endSample: Math.min(totalSamples, region.endSample + padEnd),
    rawStartSample: region.startSample,
    rawEndSample: region.endSample,
    endReason: region.endReason
  }));
  for (let index = 1; index < padded.length; index += 1) {
    const previous = padded[index - 1];
    const current = padded[index];
    if (previous.endSample <= current.startSample) {
      continue;
    }
    let midpoint = Math.floor(
      (previous.rawEndSample + current.rawStartSample) / 2
    );
    midpoint = Math.max(previous.startSample + 1, midpoint);
    midpoint = Math.min(current.endSample - 1, midpoint);
    previous.endSample = midpoint;
    current.startSample = midpoint;
  }
  let firstLevel = 0;
  return padded.flatMap((region) => {
    if (region.endSample <= region.startSample) {
      return [];
    }
    while (firstLevel < levels.length && levels[firstLevel].endSample <= region.startSample) {
      firstLevel += 1;
    }
    let lastLevel = firstLevel;
    const values = [];
    while (lastLevel < levels.length && levels[lastLevel].startSample < region.endSample) {
      values.push(levels[lastLevel].dbfs);
      lastLevel += 1;
    }
    return [{
      startSample: region.startSample,
      endSample: region.endSample,
      endReason: region.endReason,
      ...levelStats(values)
    }];
  });
}
function lowerBound(values, target) {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (values[middle] < target) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}
function upperBound(values, target) {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (values[middle] <= target) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}
function median(values) {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0 ? (ordered[middle - 1] + ordered[middle]) / 2 : ordered[middle];
}
function chooseSplit(levels, starts, { lower, upper, ideal }) {
  const hardBoundary = Math.min(Math.max(ideal, lower), upper);
  const first = lowerBound(starts, lower);
  const last = upperBound(starts, upper);
  const candidates = levels.slice(first, last);
  if (candidates.length === 0) {
    return { boundary: hardBoundary, method: "hard_limit" };
  }
  const quietest = candidates.reduce((best, frame) => frame.dbfs < best.dbfs || frame.dbfs === best.dbfs && Math.abs(frame.startSample - ideal) < Math.abs(best.startSample - ideal) ? frame : best);
  const medianLevel = median(candidates.map((frame) => frame.dbfs));
  return quietest.dbfs <= medianLevel - 3 ? { boundary: quietest.startSample, method: "quiet_valley" } : { boundary: hardBoundary, method: "hard_limit" };
}
function splitRegion(region, sourceRegion, levels, levelStarts, sampleRateHz, cuePolicy) {
  if (cuePolicy.maxDurationMs == null) {
    return [{
      startSample: region.startSample,
      endSample: region.endSample,
      sourceRegion,
      forcedSplit: false,
      splitMethod: null
    }];
  }
  const maximum = millisecondsToSamples(
    cuePolicy.maxDurationMs,
    sampleRateHz,
    { minimum: 1 }
  );
  if (region.endSample - region.startSample <= maximum) {
    return [{
      startSample: region.startSample,
      endSample: region.endSample,
      sourceRegion,
      forcedSplit: false,
      splitMethod: null
    }];
  }
  const minimum = millisecondsToSamples(
    cuePolicy.minSplitDurationMs,
    sampleRateHz,
    { minimum: 1 }
  );
  const search = millisecondsToSamples(
    cuePolicy.splitSearchMs,
    sampleRateHz
  );
  const boundaries = [];
  let cursor = region.startSample;
  while (region.endSample - cursor > maximum) {
    const ideal = cursor + maximum;
    const lower = Math.max(cursor + minimum, ideal - search);
    const upper = Math.min(ideal, region.endSample - minimum);
    let selected;
    if (upper < lower) {
      selected = {
        boundary: Math.min(ideal, region.endSample - minimum),
        method: "hard_limit"
      };
    } else {
      selected = chooseSplit(levels, levelStarts, {
        lower,
        upper,
        ideal
      });
    }
    if (selected.boundary <= cursor || selected.boundary >= region.endSample) {
      selected = {
        boundary: Math.min(
          cursor + maximum,
          region.endSample - minimum
        ),
        method: "hard_limit"
      };
    }
    boundaries.push(selected);
    cursor = selected.boundary;
  }
  const points = [
    region.startSample,
    ...boundaries.map(({ boundary }) => boundary),
    region.endSample
  ];
  return points.slice(0, -1).map((startSample, index) => ({
    startSample,
    endSample: points[index + 1],
    sourceRegion,
    forcedSplit: true,
    splitMethod: boundaries[Math.min(index, boundaries.length - 1)].method
  }));
}
function segmentAudSegPcm(samples, {
  sampleRateHz = AUDSEG_SAMPLE_RATE_HZ,
  config
} = {}) {
  if (config !== void 0 && config !== DEFAULT_AUDSEG_CONFIG) {
    throw new Error(
      "KirinukiHelper\uC758 AudSeg \uC124\uC815\uC740 \uC7AC\uD604 \uAC00\uB2A5\uD55C \uAE30\uBCF8\uAC12\uC73C\uB85C \uACE0\uC815\uB418\uC5B4 \uC788\uC2B5\uB2C8\uB2E4."
    );
  }
  const appliedConfig = DEFAULT_AUDSEG_CONFIG;
  const { levels, totalSamples } = extractAudSegFrameLevels(
    samples,
    sampleRateHz,
    appliedConfig.detector
  );
  const analysis = thresholds(levels, appliedConfig.detector);
  const raw = rawRegions(
    levels,
    totalSamples,
    sampleRateHz,
    appliedConfig.detector,
    analysis.startThresholdDbfs,
    analysis.stopThresholdDbfs
  );
  const merged = mergeRawRegions(raw, sampleRateHz, appliedConfig.detector);
  const activityRegions = padRegions(
    merged,
    levels,
    totalSamples,
    sampleRateHz,
    appliedConfig.detector
  );
  const levelStarts = levels.map((frame) => frame.startSample);
  const segments = activityRegions.flatMap((region, sourceRegion) => splitRegion(
    region,
    sourceRegion,
    levels,
    levelStarts,
    sampleRateHz,
    appliedConfig.cues
  ));
  const activeSamples = activityRegions.reduce(
    (total, region) => total + region.endSample - region.startSample,
    0
  );
  const warnings = [];
  if (totalSamples === 0) {
    warnings.push("empty_audio");
  } else if (activityRegions.length === 0) {
    warnings.push("no_activity_detected");
  }
  if (totalSamples > 0 && activeSamples / totalSamples >= 0.95) {
    warnings.push("nearly_continuous_activity");
  }
  if (analysis.peakDbfs - analysis.effectiveNoiseDbfs < 6 && analysis.peakDbfs > DBFS_FLOOR) {
    warnings.push("low_level_contrast");
  }
  if (analysis.estimatedNoiseDbfs > analysis.effectiveNoiseDbfs) {
    warnings.push("noise_floor_capped");
  }
  return {
    schema: "kirinuki-audseg-browser-result/v1",
    engine: {
      id: AUDSEG_ENGINE_ID,
      version: AUDSEG_ENGINE_VERSION,
      modelFree: true,
      transcription: false,
      fingerprint: AUDSEG_PIPELINE_FINGERPRINT
    },
    sampleRateHz,
    totalSamples,
    ...analysis,
    activityRegions,
    segments,
    warnings
  };
}

// src/editor/audseg-worker.js
self.addEventListener("message", (event) => {
  const requestId = String(event.data?.requestId || "");
  if (!requestId) {
    return;
  }
  try {
    const result = segmentAudSegPcm(event.data.samples, {
      sampleRateHz: Number(event.data.sampleRateHz)
    });
    self.postMessage({ requestId, ok: true, result });
  } catch (error) {
    self.postMessage({
      requestId,
      ok: false,
      error: {
        name: String(error?.name || "Error").slice(0, 80),
        message: String(error?.message || "AudSeg \uBD84\uC11D\uC5D0 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4.").slice(0, 1e3)
      }
    });
  }
});
