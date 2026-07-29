const DEFAULT_SPEAKER_PALETTE = Object.freeze([
  "#FFFFFF",
  "#00E6A3",
  "#98DBC8",
  "#F06088",
  "#FFD166",
  "#B18CFA",
  "#E4A478",
  "#38F45C"
]);

export const KR_VTUBER_CLEAN_PROFILE = Object.freeze({
  id: "kr-vtuber-clean-v1",
  locale: "ko-KR",
  maxCueDurationMs: 4_000,
  targetMinCueDurationMs: 650,
  maxLines: 1,
  targetLineWidthUnits: 20,
  maxLineWidthUnits: 20,
  maxTotalWidthUnits: 20,
  maxReadingRateUnitsPerSecond: 16,
  minimumTranscriptCoverage: 0.78,
  minimumTranscriptPrecision: 0.78,
  defaultPlacement: "bottom",
  automaticTopPlacement: false,
  topPlacementEvidence: Object.freeze({
    minimumSamples: 3,
    minimumMeanAdvantage: 180,
    minimumSampleAdvantage: 120,
    minimumWinningRatio: 2 / 3
  }),
  speakerPalette: DEFAULT_SPEAKER_PALETTE
});

export const CAPTION_QUALITY_PROFILE_ID = KR_VTUBER_CLEAN_PROFILE.id;

const WIDE_GRAPHEME_PATTERN =
  /[\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Extended_Pictographic}\uFF01-\uFF60\uFFE0-\uFFE6]/u;
const PUNCTUATION_PATTERN = /[\p{P}\p{S}]/u;
const SENTENCE_BREAK_PATTERN = /[?!…,:;~)\]}>”’」』】〉》]/u;
const TERMINAL_PERIOD_PATTERN =
  /[.\u3002\uff0e]+(?=(?:["'”’)\]}\u3009\u300b\u300d\u300f\u3011]*)$)/u;

let koreanGraphemeSegmenter;

function fallbackGraphemes(value) {
  const clusters = [];
  let joinNext = false;
  for (const codePoint of Array.from(value)) {
    const previous = clusters.at(-1);
    const combining = (
      /\p{Mark}/u.test(codePoint)
      || /[\uFE0E\uFE0F\u20E3]/u.test(codePoint)
      || /[\u{1F3FB}-\u{1F3FF}]/u.test(codePoint)
    );
    const regionalPair = (
      /^[\u{1F1E6}-\u{1F1FF}]$/u.test(codePoint)
      && /^[\u{1F1E6}-\u{1F1FF}]$/u.test(previous || "")
    );
    if (previous && (joinNext || combining || regionalPair)) {
      clusters[clusters.length - 1] += codePoint;
      joinNext = false;
      continue;
    }
    if (codePoint === "\u200D" && previous) {
      clusters[clusters.length - 1] += codePoint;
      joinNext = true;
      continue;
    }
    clusters.push(codePoint);
  }
  return clusters;
}

function graphemes(value) {
  const text = String(value ?? "");
  const Segmenter = globalThis.Intl?.Segmenter;
  if (typeof Segmenter === "function") {
    koreanGraphemeSegmenter ||= new Segmenter("ko-KR", {
      granularity: "grapheme"
    });
    return Array.from(koreanGraphemeSegmenter.segment(text), ({ segment }) => segment);
  }
  return fallbackGraphemes(text);
}

function finiteInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : null;
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function normalizeSpeaker(value) {
  return String(value ?? "")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 80) || "unknown";
}

export function normalizeCaptionDisplayText(value) {
  return String(value ?? "")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(TERMINAL_PERIOD_PATTERN, "")
    .trim();
}

export function measureKoreanWidthUnits(value) {
  const measured = graphemes(value).reduce((total, grapheme) => {
    if (/^\s$/u.test(grapheme)) {
      return total + 0.35;
    }
    if (WIDE_GRAPHEME_PATTERN.test(grapheme)) {
      return total + 1;
    }
    if (PUNCTUATION_PATTERN.test(grapheme)) {
      return total + 0.5;
    }
    return total + 0.55;
  }, 0);
  return Math.round(measured * 100) / 100;
}

function textSignature(value) {
  return graphemes(normalizeCaptionDisplayText(value))
    .filter((grapheme) => !/[\s\p{P}\p{S}]/u.test(grapheme))
    .join("")
    .toLocaleLowerCase("ko-KR");
}

function warningCollector() {
  const warnings = [];
  const seen = new Set();
  return {
    add(code, cueIndex) {
      const normalizedCueIndex = Number.isInteger(cueIndex) && cueIndex >= 0
        ? cueIndex
        : 0;
      const key = `${code}:${normalizedCueIndex}`;
      if (!seen.has(key)) {
        seen.add(key);
        warnings.push({ code, cueIndex: normalizedCueIndex });
      }
    },
    values() {
      return warnings;
    }
  };
}

function candidateTranscriptRange(candidate, clipDurationMs) {
  const directStart = finiteInteger(candidate?.startMs ?? candidate?.start_ms);
  const directEnd = finiteInteger(candidate?.endMs ?? candidate?.end_ms);
  if (directStart != null && directEnd != null) {
    return {
      startMs: clamp(directStart, 0, clipDurationMs),
      endMs: clamp(directEnd, 0, clipDurationMs),
      wasClamped: (
        directStart < 0
        || directStart > clipDurationMs
        || directEnd < 0
        || directEnd > clipDurationMs
      )
    };
  }

  const timestamp = Array.isArray(candidate?.timestamp)
    ? candidate.timestamp
    : [];
  const startSeconds = Number(
    candidate?.start
    ?? candidate?.start_time
    ?? timestamp[0]
  );
  const endSeconds = Number(
    candidate?.end
    ?? candidate?.end_time
    ?? timestamp[1]
  );
  if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds)) {
    return null;
  }
  const rawStartMs = Math.round(startSeconds * 1_000);
  const rawEndMs = Math.round(endSeconds * 1_000);
  return {
    startMs: clamp(rawStartMs, 0, clipDurationMs),
    endMs: clamp(rawEndMs, 0, clipDurationMs),
    wasClamped: (
      rawStartMs < 0
      || rawStartMs > clipDurationMs
      || rawEndMs < 0
      || rawEndMs > clipDurationMs
    )
  };
}

function transcriptCandidates(transcript) {
  if (Array.isArray(transcript)) {
    return transcript;
  }
  if (Array.isArray(transcript?.words) && transcript.words.length > 0) {
    return transcript.words;
  }
  if (Array.isArray(transcript?.segments)) {
    return transcript.segments;
  }
  if (Array.isArray(transcript?.units)) {
    return transcript.units;
  }
  return [];
}

export function canonicalizeTranscriptUnits(transcript, {
  clipDurationMs
} = {}) {
  const duration = finiteInteger(clipDurationMs);
  if (duration == null || duration < 1) {
    throw new TypeError("clipDurationMs must be a positive integer");
  }

  const collector = warningCollector();
  const units = [];
  for (const [unitIndex, candidate] of transcriptCandidates(transcript).entries()) {
    const range = candidateTranscriptRange(candidate, duration);
    const originalText = String(candidate?.text ?? candidate?.word ?? "");
    const text = normalizeCaptionDisplayText(originalText);
    if (!range || range.endMs <= range.startMs || !text) {
      collector.add("HARNESS_DROPPED_INVALID_TRANSCRIPT_UNIT", unitIndex);
      continue;
    }
    if (range.wasClamped) {
      collector.add("HARNESS_CLAMPED_TRANSCRIPT_UNIT", unitIndex);
    }
    if (text !== originalText.replace(/\s+/gu, " ").trim()) {
      collector.add("HARNESS_NORMALIZED_TRANSCRIPT_TEXT", unitIndex);
    }
    units.push({
      startMs: range.startMs,
      endMs: range.endMs,
      text,
      speakerId: normalizeSpeaker(
        candidate?.speakerId
        ?? candidate?.speaker_id
        ?? candidate?.speaker
        ?? candidate?.speakerLabel
        ?? candidate?.speaker_label
      )
    });
  }

  units.sort((first, second) => (
    first.startMs - second.startMs
    || first.endMs - second.endMs
    || first.text.localeCompare(second.text, "ko")
    || first.speakerId.localeCompare(second.speakerId, "ko")
  ));
  const deduplicated = units.filter((unit, index, all) => {
    const previous = all[index - 1];
    const duplicate = previous && (
      previous.startMs === unit.startMs
      && previous.endMs === unit.endMs
      && previous.text === unit.text
      && previous.speakerId === unit.speakerId
    );
    if (duplicate) {
      collector.add("HARNESS_DEDUPLICATED_TRANSCRIPT_UNIT", index);
    }
    return !duplicate;
  });

  const fullText = normalizeCaptionDisplayText(
    transcript && !Array.isArray(transcript) ? transcript.text : ""
  );
  return {
    units: deduplicated,
    text: fullText || deduplicated.map((unit) => unit.text).join(" "),
    warnings: collector.values()
  };
}

export const canonicalTimedTranscript = canonicalizeTranscriptUnits;

function isPreferredBreak(graphemeBefore, graphemeAfter) {
  return (
    /\s/u.test(graphemeBefore)
    || /\s/u.test(graphemeAfter)
    || SENTENCE_BREAK_PATTERN.test(graphemeBefore)
  );
}

function balancedTextBreak(value, {
  maxLineWidthUnits = Number.POSITIVE_INFINITY
} = {}) {
  const source = normalizeCaptionDisplayText(value);
  const sourceGraphemes = graphemes(source);
  if (sourceGraphemes.length < 2) {
    return null;
  }

  const candidates = [];
  for (let index = 1; index < sourceGraphemes.length; index += 1) {
    const left = sourceGraphemes.slice(0, index).join("").trim();
    const right = sourceGraphemes.slice(index).join("").trim();
    if (!left || !right) {
      continue;
    }
    const leftWidth = measureKoreanWidthUnits(left);
    const rightWidth = measureKoreanWidthUnits(right);
    if (
      leftWidth > maxLineWidthUnits
      || rightWidth > maxLineWidthUnits
    ) {
      continue;
    }
    const preferred = isPreferredBreak(
      sourceGraphemes[index - 1],
      sourceGraphemes[index]
    );
    candidates.push({
      left,
      right,
      preferred,
      score: Math.abs(leftWidth - rightWidth),
      index
    });
  }
  const preferredCandidates = candidates.filter(({ preferred }) => preferred);
  const pool = preferredCandidates.length > 0 ? preferredCandidates : candidates;
  const best = pool.sort((first, second) => (
    first.score - second.score || first.index - second.index
  ))[0];
  return best && [best.left, best.right];
}

function splitTextForCueCapacity(text, requestedParts, profile) {
  const parts = [normalizeCaptionDisplayText(text)];
  const needsCapacitySplit = () => parts.some(
    (part) => measureKoreanWidthUnits(part) > profile.maxTotalWidthUnits
  );
  while (
    (parts.length < requestedParts || needsCapacitySplit())
    && parts.some((part) => graphemes(part).length > 1)
  ) {
    let widestIndex = 0;
    for (let index = 1; index < parts.length; index += 1) {
      if (
        measureKoreanWidthUnits(parts[index])
        > measureKoreanWidthUnits(parts[widestIndex])
      ) {
        widestIndex = index;
      }
    }
    const split = balancedTextBreak(parts[widestIndex]);
    if (!split) {
      break;
    }
    parts.splice(widestIndex, 1, ...split);
  }
  return parts;
}

function layoutCueText(text, profile) {
  const source = normalizeCaptionDisplayText(text);
  if (
    profile.maxLines <= 1
    || measureKoreanWidthUnits(source) <= profile.maxLineWidthUnits
  ) {
    return source;
  }
  const split = balancedTextBreak(source, {
    maxLineWidthUnits: profile.maxLineWidthUnits
  });
  return split ? split.join("\n") : source;
}

function normalizedRawCueRange(rawCue, clipDurationMs) {
  const rawStart = finiteInteger(rawCue?.startMs ?? rawCue?.start_ms);
  const rawEnd = finiteInteger(rawCue?.endMs ?? rawCue?.end_ms);
  let startMs = clamp(rawStart ?? 0, 0, clipDurationMs);
  let endMs = clamp(
    rawEnd ?? Math.min(clipDurationMs, startMs + 650),
    0,
    clipDurationMs
  );
  let repaired = (
    rawStart == null
    || rawEnd == null
    || rawStart !== startMs
    || rawEnd !== endMs
  );
  if (endMs <= startMs) {
    startMs = Math.min(startMs, Math.max(0, clipDurationMs - 1));
    endMs = Math.min(clipDurationMs, startMs + 1);
    repaired = true;
  }
  return { startMs, endMs, repaired };
}

function expandRange(startMs, endMs, desiredDurationMs, clipDurationMs) {
  const currentDuration = endMs - startMs;
  const targetDuration = Math.min(
    clipDurationMs,
    Math.max(currentDuration, desiredDurationMs)
  );
  if (targetDuration <= currentDuration) {
    return { startMs, endMs };
  }
  let extra = targetDuration - currentDuration;
  const extendEnd = Math.min(extra, clipDurationMs - endMs);
  endMs += extendEnd;
  extra -= extendEnd;
  startMs = Math.max(0, startMs - extra);
  return { startMs, endMs };
}

function distributeDurations(totalDurationMs, minimumDurations, maximumDurationMs) {
  const count = minimumDurations.length;
  if (count === 0) {
    return [];
  }
  const minimumTotal = minimumDurations.reduce((sum, value) => sum + value, 0);
  if (totalDurationMs < minimumTotal) {
    const raw = minimumDurations.map(
      (value) => totalDurationMs * value / minimumTotal
    );
    const durations = raw.map((value) => Math.max(1, Math.floor(value)));
    let remainder = totalDurationMs - durations.reduce((sum, value) => sum + value, 0);
    for (let index = 0; remainder > 0; index = (index + 1) % count) {
      durations[index] += 1;
      remainder -= 1;
    }
    return durations;
  }

  const durations = [...minimumDurations];
  let remaining = totalDurationMs - minimumTotal;
  while (remaining > 0) {
    const eligible = durations
      .map((value, index) => ({ value, index }))
      .filter(({ value }) => value < maximumDurationMs);
    if (eligible.length === 0) {
      break;
    }
    const share = Math.max(1, Math.floor(remaining / eligible.length));
    for (const { index } of eligible) {
      const addition = Math.min(
        share,
        remaining,
        maximumDurationMs - durations[index]
      );
      durations[index] += addition;
      remaining -= addition;
      if (remaining === 0) {
        break;
      }
    }
  }
  return durations;
}

function splitRawCue(rawCue, cueIndex, clipDurationMs, profile, collector) {
  const originalText = String(rawCue?.text ?? "");
  const text = normalizeCaptionDisplayText(originalText);
  if (!text) {
    collector.add("HARNESS_DROPPED_EMPTY_CUE", cueIndex);
    return [];
  }
  if (text !== originalText.replace(/\s+/gu, " ").trim()) {
    collector.add("HARNESS_NORMALIZED_CUE_TEXT", cueIndex);
  }

  const range = normalizedRawCueRange(rawCue, clipDurationMs);
  if (range.repaired) {
    collector.add("HARNESS_REPAIRED_CUE_RANGE", cueIndex);
  }
  const timeParts = Math.max(
    1,
    Math.ceil((range.endMs - range.startMs) / profile.maxCueDurationMs)
  );
  const parts = splitTextForCueCapacity(text, timeParts, profile);
  if (parts.length > 1) {
    collector.add("HARNESS_SPLIT_CUE", cueIndex);
  }

  const minimumDurations = parts.map((part) => Math.max(
    profile.targetMinCueDurationMs,
    Math.ceil(
      measureKoreanWidthUnits(part)
      * 1_000
      / profile.maxReadingRateUnitsPerSecond
    )
  ));
  const desiredTotal = minimumDurations.reduce((sum, value) => sum + value, 0);
  let expanded = expandRange(
    range.startMs,
    range.endMs,
    desiredTotal,
    clipDurationMs
  );
  if (
    expanded.startMs !== range.startMs
    || expanded.endMs !== range.endMs
  ) {
    collector.add("HARNESS_EXPANDED_CUE_RANGE", cueIndex);
  }
  const maximumAggregateDuration = parts.length * profile.maxCueDurationMs;
  if (expanded.endMs - expanded.startMs > maximumAggregateDuration) {
    expanded = {
      startMs: expanded.startMs,
      endMs: expanded.startMs + maximumAggregateDuration
    };
    collector.add("HARNESS_TRIMMED_EXCESSIVE_CUE_RANGE", cueIndex);
  }
  const distributed = distributeDurations(
    expanded.endMs - expanded.startMs,
    minimumDurations,
    profile.maxCueDurationMs
  );

  let cursor = expanded.startMs;
  return parts.map((part, partIndex) => {
    const startMs = cursor;
    const endMs = partIndex === parts.length - 1
      ? expanded.endMs
      : cursor + distributed[partIndex];
    cursor = endMs;
    const laidOutText = layoutCueText(part, profile);
    if (laidOutText !== part) {
      collector.add("HARNESS_REFLOWED_CUE", cueIndex);
    }
    return {
      startMs,
      endMs,
      text: laidOutText,
      speakerId: normalizeSpeaker(
        rawCue?.speakerId
        ?? rawCue?.speaker_id
        ?? rawCue?.speaker
      ),
      reviewRequired: (
        rawCue?.reviewRequired === true
        || rawCue?.review_required === true
        || /\[불명확\]/u.test(part)
      ),
      placement: String(rawCue?.placement || "").toLowerCase(),
      sourceCueIndex: cueIndex
    };
  }).filter((cue) => cue.endMs > cue.startMs);
}

function visualSamples(visualPlacement) {
  if (Array.isArray(visualPlacement)) {
    return visualPlacement;
  }
  return Array.isArray(visualPlacement?.samples)
    ? visualPlacement.samples
    : [];
}

export function chooseStableCaptionPlacement(visualPlacement, {
  profile = KR_VTUBER_CLEAN_PROFILE
} = {}) {
  if (!profile.automaticTopPlacement) {
    return profile.defaultPlacement;
  }
  const evidence = profile.topPlacementEvidence;
  const samples = visualSamples(visualPlacement)
    .map((sample) => ({
      topScore: Number(sample?.topScore),
      bottomScore: Number(sample?.bottomScore)
    }))
    .filter(({ topScore, bottomScore }) => (
      Number.isFinite(topScore) && Number.isFinite(bottomScore)
    ));
  if (samples.length < evidence.minimumSamples) {
    return profile.defaultPlacement;
  }
  const meanAdvantage = samples.reduce(
    (sum, sample) => sum + sample.bottomScore - sample.topScore,
    0
  ) / samples.length;
  const winningSamples = samples.filter(
    (sample) => (
      sample.bottomScore - sample.topScore
      >= evidence.minimumSampleAdvantage
    )
  ).length;
  return (
    meanAdvantage >= evidence.minimumMeanAdvantage
    && winningSamples / samples.length >= evidence.minimumWinningRatio
  )
    ? "top"
    : profile.defaultPlacement;
}

function repairSameSpeakerOverlaps(cues, collector) {
  const bySpeaker = new Map();
  for (const cue of cues) {
    const speakerCues = bySpeaker.get(cue.speakerId) || [];
    speakerCues.push(cue);
    bySpeaker.set(cue.speakerId, speakerCues);
  }
  for (const speakerCues of bySpeaker.values()) {
    speakerCues.sort((first, second) => (
      first.startMs - second.startMs
      || first.endMs - second.endMs
      || first.sourceCueIndex - second.sourceCueIndex
    ));
    for (let index = 1; index < speakerCues.length; index += 1) {
      const previous = speakerCues[index - 1];
      const current = speakerCues[index];
      if (current.startMs >= previous.endMs) {
        continue;
      }
      const minimumBoundary = previous.startMs + 1;
      const maximumBoundary = current.endMs - 1;
      if (minimumBoundary <= maximumBoundary) {
        const boundary = clamp(
          Math.round((previous.endMs + current.startMs) / 2),
          minimumBoundary,
          maximumBoundary
        );
        previous.endMs = boundary;
        current.startMs = boundary;
        collector.add(
          "HARNESS_REPAIRED_SAME_SPEAKER_OVERLAP",
          current.sourceCueIndex
        );
      } else {
        collector.add(
          "HARNESS_UNRESOLVED_SAME_SPEAKER_OVERLAP",
          current.sourceCueIndex
        );
      }
    }
  }
}

function expandShortCuesWithoutSpeakerOverlap(cues, clipDurationMs, profile, collector) {
  const bySpeaker = new Map();
  for (const cue of cues) {
    const speakerCues = bySpeaker.get(cue.speakerId) || [];
    speakerCues.push(cue);
    bySpeaker.set(cue.speakerId, speakerCues);
  }
  for (const speakerCues of bySpeaker.values()) {
    speakerCues.sort((first, second) => (
      first.startMs - second.startMs
      || first.endMs - second.endMs
      || first.sourceCueIndex - second.sourceCueIndex
    ));
    for (const [index, cue] of speakerCues.entries()) {
      const readingMinimum = Math.ceil(
        measureKoreanWidthUnits(cue.text)
        * 1_000
        / profile.maxReadingRateUnitsPerSecond
      );
      const targetDuration = Math.min(
        profile.maxCueDurationMs,
        Math.max(profile.targetMinCueDurationMs, readingMinimum)
      );
      let missing = targetDuration - (cue.endMs - cue.startMs);
      if (missing <= 0) {
        continue;
      }
      const nextStart = speakerCues[index + 1]?.startMs ?? clipDurationMs;
      const extendEnd = Math.min(missing, Math.max(0, nextStart - cue.endMs));
      cue.endMs += extendEnd;
      missing -= extendEnd;
      const previousEnd = speakerCues[index - 1]?.endMs ?? 0;
      const extendStart = Math.min(missing, Math.max(0, cue.startMs - previousEnd));
      cue.startMs -= extendStart;
      missing -= extendStart;
      if (extendEnd > 0 || extendStart > 0) {
        collector.add("HARNESS_EXPANDED_SHORT_CUE", cue.sourceCueIndex);
      }
      if (missing > 0) {
        collector.add("HARNESS_SHORT_CUE_UNRESOLVED", cue.sourceCueIndex);
      }
    }
  }
}

function longestCommonSubsequenceLength(first, second) {
  if (!first || !second) {
    return 0;
  }
  if (
    first.length === second.length
    && first.every((value, index) => value === second[index])
  ) {
    return first.length;
  }
  if (first.length * second.length > 2_000_000) {
    const orderedMatchLength = (needle, haystack) => {
      let needleIndex = 0;
      for (const value of haystack) {
        if (value === needle[needleIndex]) {
          needleIndex += 1;
          if (needleIndex === needle.length) {
            break;
          }
        }
      }
      return needleIndex;
    };
    return Math.max(
      orderedMatchLength(first, second),
      orderedMatchLength(second, first)
    );
  }
  let shorter = first;
  let longer = second;
  if (first.length > second.length) {
    shorter = second;
    longer = first;
  }
  let previous = new Uint32Array(shorter.length + 1);
  let current = new Uint32Array(shorter.length + 1);
  for (const longerCharacter of longer) {
    current.fill(0);
    for (let index = 1; index <= shorter.length; index += 1) {
      current[index] = longerCharacter === shorter[index - 1]
        ? previous[index - 1] + 1
        : Math.max(previous[index], current[index - 1]);
    }
    [previous, current] = [current, previous];
  }
  return previous[shorter.length];
}

function transcriptSignature(transcript, clipDurationMs) {
  const canonical = canonicalizeTranscriptUnits(transcript, { clipDurationMs });
  return {
    signature: textSignature(canonical.text),
    warnings: canonical.warnings
  };
}

function appendViolation(violations, code, cueIndex, severity = "error") {
  const normalizedCueIndex = Number.isInteger(cueIndex) && cueIndex >= 0
    ? cueIndex
    : 0;
  const key = `${code}:${normalizedCueIndex}`;
  if (!violations.some((violation) => (
    `${violation.code}:${violation.cueIndex}` === key
  ))) {
    violations.push({ code, cueIndex: normalizedCueIndex, severity });
  }
}

export function evaluateSolarCaptionCues(cues, {
  clipDurationMs,
  transcript,
  visualPlacement,
  profile = KR_VTUBER_CLEAN_PROFILE
} = {}) {
  const duration = finiteInteger(clipDurationMs);
  if (duration == null || duration < 1) {
    throw new TypeError("clipDurationMs must be a positive integer");
  }
  if (!Array.isArray(cues)) {
    throw new TypeError("cues must be an array");
  }

  const violations = [];
  const desiredPlacement = chooseStableCaptionPlacement(visualPlacement, {
    profile
  });
  let maximumDurationMs = 0;
  let maximumLineWidthUnits = 0;
  let maximumTotalWidthUnits = 0;
  let maximumReadingRate = 0;
  const rangesBySpeaker = new Map();

  for (const [cueIndex, cue] of cues.entries()) {
    const startMs = finiteInteger(cue?.startMs);
    const endMs = finiteInteger(cue?.endMs);
    const text = String(cue?.text ?? "").trim();
    const lines = text.split("\n");
    const widths = lines.map(measureKoreanWidthUnits);
    const totalWidth = measureKoreanWidthUnits(text.replace(/\n/gu, " "));
    const cueDuration = startMs != null && endMs != null
      ? endMs - startMs
      : 0;
    const readingRate = cueDuration > 0
      ? totalWidth * 1_000 / cueDuration
      : Number.POSITIVE_INFINITY;

    maximumDurationMs = Math.max(maximumDurationMs, cueDuration);
    maximumLineWidthUnits = Math.max(maximumLineWidthUnits, ...widths, 0);
    maximumTotalWidthUnits = Math.max(maximumTotalWidthUnits, totalWidth);
    maximumReadingRate = Math.max(maximumReadingRate, readingRate);

    if (!text) {
      appendViolation(violations, "HARNESS_EMPTY_TEXT", cueIndex);
    }
    if (text && normalizeCaptionDisplayText(text) !== text.replace(/\n/gu, " ").replace(/\s+/gu, " ").trim()) {
      appendViolation(violations, "HARNESS_TERMINAL_PERIOD", cueIndex);
    }
    if (
      startMs == null
      || endMs == null
      || startMs < 0
      || endMs <= startMs
      || endMs > duration
    ) {
      appendViolation(violations, "HARNESS_CUE_OUT_OF_RANGE", cueIndex);
    }
    if (cueDuration > profile.maxCueDurationMs) {
      appendViolation(violations, "HARNESS_CUE_TOO_LONG", cueIndex);
    }
    if (cueDuration > 0 && cueDuration < profile.targetMinCueDurationMs) {
      appendViolation(
        violations,
        "HARNESS_CUE_SHORTER_THAN_TARGET",
        cueIndex,
        "warning"
      );
    }
    if (lines.length > profile.maxLines) {
      appendViolation(violations, "HARNESS_TOO_MANY_LINES", cueIndex);
    }
    if (widths.some((width) => width > profile.maxLineWidthUnits)) {
      appendViolation(violations, "HARNESS_LINE_TOO_WIDE", cueIndex);
    }
    if (totalWidth > profile.maxTotalWidthUnits) {
      appendViolation(violations, "HARNESS_CUE_TEXT_TOO_WIDE", cueIndex);
    }
    if (
      Number.isFinite(readingRate)
      && readingRate > profile.maxReadingRateUnitsPerSecond + 0.001
    ) {
      appendViolation(violations, "HARNESS_READING_RATE_EXCEEDED", cueIndex);
    }
    if (cue?.placement !== desiredPlacement) {
      appendViolation(violations, "HARNESS_UNSTABLE_PLACEMENT", cueIndex);
    }

    if (startMs != null && endMs != null) {
      const speakerId = normalizeSpeaker(cue?.speakerId);
      const ranges = rangesBySpeaker.get(speakerId) || [];
      ranges.push({ startMs, endMs, cueIndex });
      rangesBySpeaker.set(speakerId, ranges);
    }
  }
  for (const ranges of rangesBySpeaker.values()) {
    ranges.sort((first, second) => (
      first.startMs - second.startMs
      || first.endMs - second.endMs
      || first.cueIndex - second.cueIndex
    ));
    for (let index = 1; index < ranges.length; index += 1) {
      if (ranges[index].startMs < ranges[index - 1].endMs) {
        appendViolation(
          violations,
          "HARNESS_SAME_SPEAKER_OVERLAP",
          ranges[index].cueIndex
        );
      }
    }
  }

  let transcriptCoverage = null;
  let transcriptPrecision = null;
  if (transcript != null) {
    const expected = transcriptSignature(transcript, duration).signature;
    const actual = textSignature(cues.map((cue) => cue?.text || "").join(" "));
    if (expected || actual) {
      const commonLength = longestCommonSubsequenceLength(
        graphemes(expected),
        graphemes(actual)
      );
      transcriptCoverage = expected
        ? commonLength / graphemes(expected).length
        : actual ? 0 : 1;
      transcriptPrecision = actual
        ? commonLength / graphemes(actual).length
        : expected ? 0 : 1;
      if (transcriptCoverage < profile.minimumTranscriptCoverage) {
        appendViolation(
          violations,
          "HARNESS_TRANSCRIPT_COVERAGE_LOW",
          0
        );
      }
      if (transcriptPrecision < profile.minimumTranscriptPrecision) {
        appendViolation(
          violations,
          "HARNESS_TRANSCRIPT_PRECISION_LOW",
          0
        );
      }
    }
  }

  const errorCount = violations.filter(
    (violation) => violation.severity === "error"
  ).length;
  return {
    profileId: profile.id,
    valid: errorCount === 0,
    violations,
    metrics: {
      cueCount: cues.length,
      maximumDurationMs,
      maximumLineWidthUnits: Math.round(maximumLineWidthUnits * 100) / 100,
      maximumTotalWidthUnits: Math.round(maximumTotalWidthUnits * 100) / 100,
      maximumReadingRate: Number.isFinite(maximumReadingRate)
        ? Math.round(maximumReadingRate * 100) / 100
        : null,
      transcriptCoverage: transcriptCoverage == null
        ? null
        : Math.round(transcriptCoverage * 10_000) / 10_000,
      transcriptPrecision: transcriptPrecision == null
        ? null
        : Math.round(transcriptPrecision * 10_000) / 10_000,
      placement: desiredPlacement
    }
  };
}

export const evaluateCaptionDraft = evaluateSolarCaptionCues;

function deterministicSpeakerColors(cues, profile) {
  const speakers = [...new Set(cues.map((cue) => cue.speakerId))]
    .sort((first, second) => first.localeCompare(second, "ko"));
  const colors = {};
  let paletteIndex = 0;
  if (speakers.includes("main")) {
    colors.main = profile.speakerPalette[0];
    paletteIndex = 1;
  }
  for (const speakerId of speakers) {
    if (speakerId === "main") {
      continue;
    }
    colors[speakerId] = profile.speakerPalette[
      paletteIndex % profile.speakerPalette.length
    ];
    paletteIndex += 1;
  }
  return colors;
}

export function repairSolarCaptionCues(rawCues, {
  clipDurationMs,
  transcript,
  visualPlacement,
  includeSpeakerColors = false,
  profile = KR_VTUBER_CLEAN_PROFILE
} = {}) {
  const duration = finiteInteger(clipDurationMs);
  if (duration == null || duration < 1) {
    throw new TypeError("clipDurationMs must be a positive integer");
  }
  if (!Array.isArray(rawCues)) {
    throw new TypeError("rawCues must be an array");
  }

  const collector = warningCollector();
  const placement = chooseStableCaptionPlacement(visualPlacement, { profile });
  const cues = rawCues.flatMap((rawCue, cueIndex) => (
    splitRawCue(rawCue, cueIndex, duration, profile, collector)
  ));
  cues.sort((first, second) => (
    first.startMs - second.startMs
    || first.endMs - second.endMs
    || first.sourceCueIndex - second.sourceCueIndex
  ));
  for (const cue of cues) {
    if (cue.placement !== placement) {
      collector.add("HARNESS_STABILIZED_PLACEMENT", cue.sourceCueIndex);
    }
    cue.placement = placement;
  }
  repairSameSpeakerOverlaps(cues, collector);
  expandShortCuesWithoutSpeakerOverlap(
    cues,
    duration,
    profile,
    collector
  );

  const finalizedCues = cues.map(({ sourceCueIndex, ...cue }) => cue);
  const evaluation = evaluateSolarCaptionCues(finalizedCues, {
    clipDurationMs: duration,
    transcript,
    visualPlacement,
    profile
  });
  return {
    profileId: profile.id,
    cues: finalizedCues,
    warnings: collector.values(),
    evaluation,
    ...(includeSpeakerColors
      ? {
        metadata: {
          speakerColorPalette: "kr-vtuber-reference-v1",
          speakerColors: deterministicSpeakerColors(finalizedCues, profile)
        }
      }
      : {})
  };
}

export function repairCaptionDraft(rawCues, options) {
  const repaired = repairSolarCaptionCues(rawCues, options);
  const { evaluation, ...result } = repaired;
  return {
    ...result,
    report: evaluation
  };
}
