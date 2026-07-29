import assert from "node:assert/strict";
import test from "node:test";

import {
  CAPTION_HARNESS_FINGERPRINT,
  CAPTION_QUALITY_PROFILE_ID,
  KR_VTUBER_CLEAN_PROFILE,
  canonicalTimedTranscript,
  chooseStableCaptionPlacement,
  evaluateCaptionDraft,
  measureKoreanWidthUnits,
  normalizeCaptionDisplayText,
  repairCaptionDraft
} from "../src/caption-agent/caption-quality-harness.js";

function flattenedCaptionText(cues) {
  return normalizeCaptionDisplayText(
    cues.map((cue) => cue.text.replace(/\n/gu, " ")).join(" ")
  ).replace(/\s+/gu, "");
}

function assertCleanCue(cue, clipDurationMs) {
  assert(Number.isInteger(cue.startMs));
  assert(Number.isInteger(cue.endMs));
  assert(cue.startMs >= 0);
  assert(cue.endMs <= clipDurationMs);
  assert(cue.endMs > cue.startMs);
  assert(cue.endMs - cue.startMs <= 4_000);
  assert.equal(cue.text.includes("\n"), false);
  assert(measureKoreanWidthUnits(cue.text) <= 20);
  assert.equal(/[.\u3002\uff0e]$/u.test(cue.text), false);
  assert.equal(cue.placement, "bottom");
  assert.deepEqual(
    Object.keys(cue).sort(),
    [
      "endMs",
      "placement",
      "reviewRequired",
      "speakerId",
      "startMs",
      "text"
    ]
  );
}

test("kr-vtuber-clean-v1은 실측 레퍼런스에 맞춘 한 줄·하단·4초 프로필이다", () => {
  assert.equal(CAPTION_QUALITY_PROFILE_ID, "kr-vtuber-clean-v1");
  assert.equal(KR_VTUBER_CLEAN_PROFILE.id, CAPTION_QUALITY_PROFILE_ID);
  assert.equal(KR_VTUBER_CLEAN_PROFILE.maxLines, 1);
  assert.equal(KR_VTUBER_CLEAN_PROFILE.targetLineWidthUnits, 20);
  assert.equal(KR_VTUBER_CLEAN_PROFILE.maxLineWidthUnits, 20);
  assert.equal(KR_VTUBER_CLEAN_PROFILE.maxTotalWidthUnits, 20);
  assert.equal(KR_VTUBER_CLEAN_PROFILE.maxCueDurationMs, 4_000);
  assert.equal(KR_VTUBER_CLEAN_PROFILE.targetMinCueDurationMs, 650);
  assert.equal(
    KR_VTUBER_CLEAN_PROFILE.maxReadingRateUnitsPerSecond,
    16
  );
  assert.equal(KR_VTUBER_CLEAN_PROFILE.defaultPlacement, "bottom");
  assert.equal(KR_VTUBER_CLEAN_PROFILE.automaticTopPlacement, false);
});

test("한글 20폭은 한 줄로 유지하고 21·26폭은 다음 시간 cue로 분할한다", () => {
  for (const width of [20, 21, 26]) {
    const text = "가".repeat(width);
    const repaired = repairCaptionDraft([{
      startMs: 0,
      endMs: 4_000,
      text,
      speakerId: "main",
      reviewRequired: false,
      placement: "bottom"
    }], {
      clipDurationMs: 4_000
    });

    assert.equal(repaired.cues.length === 1, width === 20);
    assert.equal(flattenedCaptionText(repaired.cues), text);
    assert(repaired.cues.every(
      (cue) => measureKoreanWidthUnits(cue.text) <= 20
    ));
  }
});

test("Intl.Segmenter가 없는 런타임에서도 결합 문자와 emoji를 안전하게 센다", async () => {
  const originalSegmenter = Intl.Segmenter;
  try {
    Object.defineProperty(Intl, "Segmenter", {
      configurable: true,
      writable: true,
      value: undefined
    });
    const fallbackHarness = await import(
      `../src/caption-agent/caption-quality-harness.js?fallback=${Date.now()}`
    );
    assert.equal(fallbackHarness.measureKoreanWidthUnits("가"), 1);
    assert.equal(fallbackHarness.measureKoreanWidthUnits("👨‍👩‍👧‍👦"), 1);
    assert.equal(
      fallbackHarness.normalizeCaptionDisplayText("  안녕.  "),
      "안녕"
    );
  } finally {
    Object.defineProperty(Intl, "Segmenter", {
      configurable: true,
      writable: true,
      value: originalSegmenter
    });
  }
});

test("timed transcript를 ms로 정규화하고 범위·중복·종결 마침표를 결정적으로 정리한다", () => {
  const canonical = canonicalTimedTranscript({
    text: " 안녕. 반가워? ",
    segments: [
      { start: 0.1, end: 0.9, text: " 안녕. ", speaker: "main" },
      { startMs: 900, endMs: 1_700, text: "반가워?", speakerId: "guest" },
      { startMs: 900, endMs: 1_700, text: "반가워?", speakerId: "guest" },
      { startMs: 1_800, endMs: 1_800, text: "범위 없음" },
      { startMs: 1_900, endMs: 2_500, text: "끝.", speaker: "main" }
    ]
  }, {
    clipDurationMs: 2_000
  });

  assert.deepEqual(canonical.units, [
    {
      startMs: 100,
      endMs: 900,
      text: "안녕",
      speakerId: "main"
    },
    {
      startMs: 900,
      endMs: 1_700,
      text: "반가워?",
      speakerId: "guest"
    },
    {
      startMs: 1_900,
      endMs: 2_000,
      text: "끝",
      speakerId: "main"
    }
  ]);
  assert.equal(canonical.text, "안녕. 반가워?");
  assert(canonical.warnings.some(
    ({ code }) => code === "HARNESS_DEDUPLICATED_TRANSCRIPT_UNIT"
  ));
  assert(canonical.warnings.some(
    ({ code }) => code === "HARNESS_DROPPED_INVALID_TRANSCRIPT_UNIT"
  ));
  assert(canonical.warnings.some(
    ({ code }) => code === "HARNESS_CLAMPED_TRANSCRIPT_UNIT"
  ));
  assert(canonical.warnings.every(
    (warning) => (
      typeof warning.code === "string"
      && Number.isInteger(warning.cueIndex)
    )
  ));
});

test("segment 문장을 보존하면서 word를 중복 본문이 아닌 실제 경계 anchor로 결합한다", () => {
  const canonical = canonicalTimedTranscript({
    text: "안녕하세요 여러분",
    segments: [{
      startMs: 100,
      endMs: 1_900,
      text: "안녕하세요 여러분",
      speaker: "카린"
    }],
    words: [{
      startMs: 100,
      endMs: 800,
      text: "안녕하세요"
    }, {
      startMs: 1_000,
      endMs: 1_900,
      text: "여러분"
    }]
  }, {
    clipDurationMs: 2_000,
    editorialContext: {
      schema: "kr-vtuber-editorial-context/v1",
      glossary: [],
      speakers: [{
        id: "main",
        aliases: ["main", "카린", "karin"]
      }],
      style: {
        terminalPeriod: "omit",
        placement: "bottom",
        maxWidthUnits: 20,
        examples: []
      }
    }
  });

  assert.deepEqual(canonical.units, [{
    startMs: 100,
    endMs: 1_900,
    text: "안녕하세요 여러분",
    speakerId: "main",
    wordAnchors: [[100, 800], [1_000, 1_900]]
  }]);
  assert.equal(canonical.wordUnits.length, 2);
  assert.deepEqual(canonical.anchorCoverage, {
    segmentTextCoverage: 1,
    wordTextPrecision: 1
  });
  assert.equal(
    canonical.warnings.some(
      ({ code }) => code === "HARNESS_WORD_ANCHOR_COVERAGE_LOW"
    ),
    false
  );
});

test("긴 cue 분할 시 균등 나눗셈 대신 실제 STT word 경계를 사용한다", () => {
  const text = "안녕하세요 여러분 오늘도 정말 너무너무 반가워요 친구들";
  const words = [
    "안녕하세요",
    "여러분",
    "오늘도",
    "정말",
    "너무너무",
    "반가워요",
    "친구들"
  ];
  const repaired = repairCaptionDraft([{
    startMs: 0,
    endMs: 6_000,
    text,
    speakerId: "main",
    reviewRequired: false,
    placement: "bottom"
  }], {
    clipDurationMs: 6_000,
    transcript: {
      segments: [{ startMs: 0, endMs: 6_000, text }],
      words: words.map((word, index) => ({
        startMs: index * 800,
        endMs: index * 800 + 700,
        text: word
      }))
    },
    timingPolicy: "stt-boundaries"
  });

  assert.equal(repaired.harnessFingerprint, CAPTION_HARNESS_FINGERPRINT);
  assert.equal(repaired.cues.length, 2);
  assert.equal(repaired.cues[0].startMs, 0);
  assert.equal(repaired.cues[0].endMs, 2_350);
  assert.equal(repaired.cues[1].startMs, 2_350);
  assert.equal(repaired.cues[1].endMs, 6_000);
  assert(repaired.cues.every(
    (cue) => cue.startMs >= 0 && cue.endMs <= 6_000
  ));
  assert(repaired.warnings.some(
    ({ code }) => code === "HARNESS_ALIGNED_SPLIT_TO_WORD_BOUNDARY"
  ));
});

test("4초 초과 짧은 segment는 일치하는 word anchor 범위가 있을 때만 안전하게 축소한다", () => {
  const repaired = repairCaptionDraft([{
    startMs: 0,
    endMs: 10_000,
    text: "아!",
    speakerId: "main",
    reviewRequired: false,
    placement: "bottom"
  }], {
    clipDurationMs: 10_000,
    transcript: {
      segments: [{
        startMs: 0,
        endMs: 10_000,
        text: "아!",
        speaker: "main"
      }],
      words: [{
        startMs: 3_000,
        endMs: 3_500,
        text: "아"
      }]
    },
    timingPolicy: "stt-boundaries"
  });

  assert.deepEqual(
    repaired.cues.map(({ startMs, endMs, text }) => ({
      startMs,
      endMs,
      text
    })),
    [{
      startMs: 3_000,
      endMs: 3_500,
      text: "아!"
    }]
  );
  assert(repaired.warnings.some(
    ({ code }) => code === "HARNESS_CONSTRAINED_LONG_CUE_TO_WORD_ANCHORS"
  ));
  assert.notEqual(repaired.report.disposition, "rejected");
});

test("4초 초과 짧은 segment에 word anchor가 없으면 시간을 발명하지 않고 구조 실패로 남긴다", () => {
  const repaired = repairCaptionDraft([{
    startMs: 0,
    endMs: 10_000,
    text: "아",
    speakerId: "main",
    reviewRequired: false,
    placement: "bottom"
  }], {
    clipDurationMs: 10_000,
    transcript: {
      segments: [{
        startMs: 0,
        endMs: 10_000,
        text: "아",
        speaker: "main"
      }],
      words: []
    },
    timingPolicy: "stt-boundaries"
  });

  assert.deepEqual(
    repaired.cues.map(({ startMs, endMs }) => ({ startMs, endMs })),
    [{ startMs: 0, endMs: 10_000 }]
  );
  assert.equal(
    repaired.warnings.some(
      ({ code }) => code === "HARNESS_CONSTRAINED_LONG_CUE_TO_WORD_ANCHORS"
    ),
    false
  );
  assert.equal(repaired.report.disposition, "rejected");
  assert(repaired.report.violations.some(
    ({ code }) => code === "HARNESS_CUE_TOO_LONG"
  ));
});

test("STT 경계 보존 모드는 짧은 발화를 늘리지 않고 unknown 화자를 main으로 정리한다", () => {
  const repaired = repairCaptionDraft([{
    startMs: 250,
    endMs: 600,
    text: "짧은 발화.",
    speakerId: "unknown",
    reviewRequired: false,
    placement: "bottom"
  }], {
    clipDurationMs: 2_000,
    transcript: {
      segments: [{
        startMs: 250,
        endMs: 600,
        text: "짧은 발화.",
        speaker: "unknown"
      }],
      words: []
    },
    timingPolicy: "stt-boundaries"
  });

  assert.deepEqual(repaired.cues, [{
    startMs: 250,
    endMs: 600,
    text: "짧은 발화",
    speakerId: "main",
    reviewRequired: true,
    placement: "bottom"
  }]);
  assert.equal(
    repaired.warnings.some(
      ({ code }) => code === "HARNESS_EXPANDED_CUE_RANGE"
    ),
    false
  );
});

test("STT 경계 보존 모드는 짧은 동일 화자 겹침을 조용히 이동하지 않고 격리 대상으로 남긴다", () => {
  const repaired = repairCaptionDraft([{
    startMs: 0,
    endMs: 100,
    text: "가",
    speakerId: "main",
    reviewRequired: false,
    placement: "bottom"
  }, {
    startMs: 50,
    endMs: 150,
    text: "나",
    speakerId: "main",
    reviewRequired: false,
    placement: "bottom"
  }], {
    clipDurationMs: 1_000,
    transcript: {
      segments: [{
        startMs: 0,
        endMs: 100,
        text: "가",
        speaker: "main"
      }, {
        startMs: 50,
        endMs: 150,
        text: "나",
        speaker: "main"
      }],
      words: []
    },
    timingPolicy: "stt-boundaries"
  });

  assert.deepEqual(
    repaired.cues.map(({ startMs, endMs }) => ({ startMs, endMs })),
    [{
      startMs: 0,
      endMs: 100
    }, {
      startMs: 50,
      endMs: 150
    }]
  );
  assert(repaired.warnings.some(
    ({ code }) => code === "HARNESS_PRESERVED_SAME_SPEAKER_OVERLAP"
  ));
  assert.equal(repaired.warnings.some(
    ({ code }) => code === "HARNESS_REPAIRED_SAME_SPEAKER_OVERLAP"
  ), false);
  assert.equal(repaired.report.disposition, "rejected");
  assert(repaired.report.violations.some(
    ({ code, cueIndex }) => (
      code === "HARNESS_SAME_SPEAKER_OVERLAP"
      && cueIndex === 1
    )
  ));
});

test("Solar 초안을 발화 삭제 없이 한 줄 cue로 분할하고 시간·속도·겹침을 보정한다", () => {
  const clipDurationMs = 12_000;
  const rawCues = [
    {
      startMs: -100,
      endMs: 5_300,
      text: "아니 잠깐만 이건 정말 생각했던 것보다 훨씬 더 대단한 일이잖아.",
      speakerId: "main",
      reviewRequired: false,
      placement: "top"
    },
    {
      startMs: 4_900,
      endMs: 6_100,
      text: "그러니까 내 말이 그 말이야?",
      speakerId: "main",
      reviewRequired: false,
      placement: "center"
    },
    {
      startMs: 6_200,
      endMs: 6_300,
      text: "뭐라고?!",
      speakerId: "guest",
      reviewRequired: true,
      placement: "top"
    }
  ];
  const expectedSpeech = rawCues
    .map((cue) => normalizeCaptionDisplayText(cue.text))
    .join("")
    .replace(/\s+/gu, "");

  const repaired = repairCaptionDraft(rawCues, {
    clipDurationMs,
    includeSpeakerColors: true
  });

  assert.equal(repaired.profileId, CAPTION_QUALITY_PROFILE_ID);
  assert(repaired.cues.length > rawCues.length);
  for (const cue of repaired.cues) {
    assertCleanCue(cue, clipDurationMs);
  }
  assert.equal(flattenedCaptionText(repaired.cues), expectedSpeech);
  const bySpeaker = new Map();
  for (const cue of repaired.cues) {
    const previousEnd = bySpeaker.get(cue.speakerId);
    if (previousEnd != null) {
      assert(cue.startMs >= previousEnd);
    }
    bySpeaker.set(cue.speakerId, cue.endMs);
  }
  assert(repaired.warnings.some(
    ({ code }) => code === "HARNESS_SPLIT_CUE"
  ));
  assert(repaired.warnings.some(
    ({ code }) => code === "HARNESS_REPAIRED_SAME_SPEAKER_OVERLAP"
  ));
  assert.deepEqual(
    repaired.metadata.speakerColors,
    {
      guest: "#00E6A3",
      main: "#FFFFFF"
    }
  );
  assert.equal(repaired.report.valid, true);
  assert(repaired.report.metrics.maximumReadingRate <= 16);
});

test("자동 placement는 시각 점수가 극단적이어도 clip 전체에서 bottom으로 고정한다", () => {
  const visualPlacement = {
    samples: [
      { topScore: 0, bottomScore: 1_000 },
      { topScore: 0, bottomScore: 1_000 },
      { topScore: 0, bottomScore: 1_000 }
    ]
  };
  assert.equal(
    chooseStableCaptionPlacement(visualPlacement),
    "bottom"
  );

  const repaired = repairCaptionDraft([{
    startMs: 100,
    endMs: 1_000,
    text: "하단에 고정",
    speakerId: "main",
    reviewRequired: false,
    placement: "top"
  }], {
    clipDurationMs: 2_000,
    visualPlacement
  });
  assert.deepEqual(
    repaired.cues.map((cue) => cue.placement),
    ["bottom"]
  );
});

test("평가기는 transcript 누락·환각, 과속, 여러 줄과 같은 hard failure를 보고한다", () => {
  const report = evaluateCaptionDraft([{
    startMs: 0,
    endMs: 500,
    text: "영상에 없던 아주 긴 말\n두 번째 줄.",
    speakerId: "main",
    reviewRequired: false,
    placement: "top"
  }], {
    clipDurationMs: 2_000,
    transcript: {
      segments: [{
        startMs: 0,
        endMs: 1_000,
        text: "실제 발화"
      }]
    }
  });
  const codes = new Set(report.violations.map(({ code }) => code));

  assert.equal(report.valid, false);
  assert.equal(report.disposition, "rejected");
  assert.equal(report.cueReviews[0].status, "rejected");
  assert(codes.has("HARNESS_TERMINAL_PERIOD"));
  assert(codes.has("HARNESS_TOO_MANY_LINES"));
  assert(codes.has("HARNESS_READING_RATE_EXCEEDED"));
  assert(codes.has("HARNESS_UNSTABLE_PLACEMENT"));
  assert(codes.has("HARNESS_TRANSCRIPT_COVERAGE_LOW"));
  assert(codes.has("HARNESS_TRANSCRIPT_PRECISION_LOW"));
  assert(report.metrics.transcriptCoverage < 0.98);
  assert(report.metrics.transcriptPrecision < 0.98);
});

test("repairCaptionDraft는 같은 입력 상태에 재적용해도 cue와 report가 바뀌지 않는다", () => {
  const options = {
    clipDurationMs: 5_000,
    transcript: {
      segments: [
        {
          startMs: 250,
          endMs: 1_400,
          text: "오늘 진짜 재밌었어?",
          speaker: "main"
        },
        {
          startMs: 1_500,
          endMs: 2_300,
          text: "나도 그렇게 생각해!",
          speaker: "guest"
        }
      ]
    },
    includeSpeakerColors: true
  };
  const first = repairCaptionDraft([
    {
      startMs: 250,
      endMs: 1_400,
      text: "오늘 진짜 재밌었어?",
      speakerId: "main",
      reviewRequired: false,
      placement: "bottom"
    },
    {
      startMs: 1_500,
      endMs: 2_300,
      text: "나도 그렇게 생각해!",
      speakerId: "guest",
      reviewRequired: false,
      placement: "bottom"
    }
  ], options);
  const second = repairCaptionDraft(first.cues, options);

  assert.deepEqual(second.cues, first.cues);
  assert.deepEqual(second.report, first.report);
  assert.deepEqual(second.metadata, first.metadata);
  assert.equal(first.report.valid, true);
});
