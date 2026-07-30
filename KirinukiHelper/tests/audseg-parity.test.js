import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_AUDSEG_CONFIG,
  segmentAudSegPcm
} from "../src/editor/audseg.js";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const fixturePath = path.resolve(
  packageRoot,
  "..",
  "AudSeg",
  "tests",
  "fixtures",
  "browser_python_golden.json"
);
const golden = JSON.parse(fs.readFileSync(fixturePath, "utf8"));

function browserConfig(config) {
  return {
    detector: {
      frameMs: config.detector.frame_ms,
      hopMs: config.detector.hop_ms,
      noisePercentile: config.detector.noise_percentile,
      noiseCeilingDbfs: config.detector.noise_ceiling_dbfs,
      minimumOnDbfs: config.detector.minimum_on_dbfs,
      minimumOffDbfs: config.detector.minimum_off_dbfs,
      onMarginDb: config.detector.on_margin_db,
      offMarginDb: config.detector.off_margin_db,
      peakGuardDb: config.detector.peak_guard_db,
      hysteresisDb: config.detector.hysteresis_db,
      fixedThresholdDbfs: config.detector.fixed_threshold_dbfs,
      onsetMs: config.detector.onset_ms,
      releaseMs: config.detector.release_ms,
      minRegionMs: config.detector.min_region_ms,
      mergeGapMs: config.detector.merge_gap_ms,
      padStartMs: config.detector.pad_start_ms,
      padEndMs: config.detector.pad_end_ms
    },
    cues: {
      maxDurationMs: config.cues.max_duration_ms,
      minSplitDurationMs: config.cues.min_split_duration_ms,
      splitSearchMs: config.cues.split_search_ms
    }
  };
}

function fixtureSamples(chunks) {
  const sampleCount = chunks.reduce(
    (total, chunk) => total + chunk.sample_count,
    0
  );
  const samples = new Float32Array(sampleCount);
  let cursor = 0;
  for (const chunk of chunks) {
    if (chunk.kind === "constant") {
      samples.fill(
        chunk.value,
        cursor,
        cursor + chunk.sample_count
      );
    } else if (chunk.kind === "alternating") {
      for (let index = 0; index < chunk.sample_count; index += 1) {
        samples[cursor + index] = index % 2 === 0
          ? chunk.amplitude
          : -chunk.amplitude;
      }
    } else {
      assert.fail(`unsupported fixture chunk: ${chunk.kind}`);
    }
    cursor += chunk.sample_count;
  }
  return samples;
}

function regionBoundaries(result) {
  return result.activityRegions.map((region) => [
    region.startSample,
    region.endSample,
    region.endReason
  ]);
}

function segmentBoundaries(result) {
  return result.segments.map((segment) => [
    segment.startSample,
    segment.endSample,
    segment.sourceRegion,
    segment.forcedSplit,
    segment.splitMethod
  ]);
}

test("AudSeg Python과 브라우저 포트는 공유 골든 경계가 정확히 같다", async (context) => {
  assert.equal(golden.schema, "audseg.browser-python-golden/v1");
  assert.deepEqual(
    browserConfig(golden.config),
    DEFAULT_AUDSEG_CONFIG
  );

  for (const fixtureCase of golden.cases) {
    await context.test(fixtureCase.id, () => {
      const result = segmentAudSegPcm(
        fixtureSamples(fixtureCase.chunks),
        { sampleRateHz: golden.sample_rate_hz }
      );
      const expected = fixtureCase.expected;

      assert.equal(result.totalSamples, expected.total_samples);
      assert.deepEqual(
        regionBoundaries(result),
        expected.activity_regions
      );
      assert.deepEqual(
        segmentBoundaries(result),
        expected.segments
      );
      assert.deepEqual(result.warnings, expected.warnings);
      assert.ok(result.segments.every((segment) => (
        segment.endSample - segment.startSample
          <= 4 * result.sampleRateHz
      )));
    });
  }
});
