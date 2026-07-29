import assert from "node:assert/strict";
import test from "node:test";

import {
  CAPTION_AGENT_REQUEST_SCHEMA_ID,
  CAPTION_AGENT_REQUEST_JSON_SCHEMA,
  CAPTION_AGENT_RESPONSE_SCHEMA_ID,
  CAPTION_AGENT_RESPONSE_JSON_SCHEMA,
  KOREAN_VTUBER_SOLAR_SYSTEM_PROMPT,
  MAX_AUDIO_WAV_BYTES,
  MAX_CAPTION_CUE_DURATION_MS,
  MAX_CAPTION_CUES,
  MAX_CAPTION_WARNINGS,
  MAX_CLIP_DURATION_MS,
  SUPPORTED_SOLAR_CAPTION_MODELS,
  UPSTAGE_CAPTION_JSON_SCHEMA,
  CaptionProtocolError,
  createCaptionAgentResponse,
  normalizeCaptionCuesDetailed,
  stripTerminalPeriods,
  validateCaptionAgentRequest,
  validateCaptionCue,
  validateCaptionCues
} from "../src/caption-agent/protocol.js";
import {
  CAPTION_AGENT_REQUEST_SCHEMA as EDITOR_REQUEST_SCHEMA,
  CAPTION_AGENT_RESPONSE_SCHEMA as EDITOR_RESPONSE_SCHEMA,
  createCaptionAgentRequest,
  normalizeCaptionAgentCues
} from "../src/editor/caption-agent.js";

function wavBase64() {
  const wav = Buffer.alloc(44);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36, 4);
  wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16_000, 24);
  wav.writeUInt32LE(32_000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(0, 40);
  return wav.toString("base64");
}

function protocolRequest(overrides = {}) {
  return {
    schema: CAPTION_AGENT_REQUEST_SCHEMA_ID,
    requestId: "protocol-request-1",
    model: "solar-pro3",
    locale: "ko-KR",
    clip: {
      id: "clip-1",
      title: "첫 만남",
      durationMs: 12_345
    },
    source: {
      projectId: "project-1",
      projectName: "키리누키 프로젝트",
      streamerName: "엘리"
    },
    policy: {
      audience: "korean-vtuber-kirinuki",
      includeAllRecognizableSpeech: true,
      uncertainSpeech: "keep-and-mark-for-review",
      maxCueDurationMs: 4_000,
      terminalPeriod: "omit",
      questionAndExclamationMarks: "keep",
      placement: "choose-readable-safe-area"
    },
    visual: {
      analysis: "local-three-band-edge-density-v1",
      framesShared: false,
      samples: [{
        atMs: 500,
        topScore: 720,
        centerScore: 430,
        bottomScore: 110,
        preferredPlacement: "bottom"
      }]
    },
    audio: {
      encoding: "base64",
      mimeType: "audio/wav",
      sampleRateHz: 16_000,
      channels: 1,
      data: wavBase64()
    },
    ...overrides
  };
}

test("프로토콜은 한국어 VTuber 키리누키 규칙과 평평한 Solar cue 스키마를 공개한다", () => {
  assert.equal(
    CAPTION_AGENT_REQUEST_JSON_SCHEMA.$id,
    CAPTION_AGENT_REQUEST_SCHEMA_ID
  );
  assert.equal(
    CAPTION_AGENT_RESPONSE_JSON_SCHEMA.$id,
    CAPTION_AGENT_RESPONSE_SCHEMA_ID
  );
  assert(CAPTION_AGENT_REQUEST_JSON_SCHEMA.required.includes("requestId"));
  assert.deepEqual(
    CAPTION_AGENT_REQUEST_JSON_SCHEMA.properties.model.enum,
    ["solar-pro3", "solar-mini"]
  );
  assert.deepEqual(
    SUPPORTED_SOLAR_CAPTION_MODELS,
    ["solar-pro3", "solar-mini"]
  );
  assert.equal(
    CAPTION_AGENT_REQUEST_JSON_SCHEMA.properties.audio.properties.data.maxLength,
    4 * Math.ceil(MAX_AUDIO_WAV_BYTES / 3)
  );
  assert.equal(MAX_CLIP_DURATION_MS, 30 * 60 * 1_000);
  assert.equal(
    CAPTION_AGENT_RESPONSE_JSON_SCHEMA.properties.warnings.maxItems,
    MAX_CAPTION_WARNINGS
  );
  assert.match(KOREAN_VTUBER_SOLAR_SYSTEM_PROMPT, /사람이 반드시 한 번 더.*검수/u);
  assert.match(KOREAN_VTUBER_SOLAR_SYSTEM_PROMPT, /빼먹지/u);
  assert.match(KOREAN_VTUBER_SOLAR_SYSTEM_PROMPT, /4초를 넘기지/u);
  assert.match(KOREAN_VTUBER_SOLAR_SYSTEM_PROMPT, /마침표/u);
  assert.match(KOREAN_VTUBER_SOLAR_SYSTEM_PROMPT, /물음표/u);
  assert.match(KOREAN_VTUBER_SOLAR_SYSTEM_PROMPT, /의미·호흡/u);
  assert.match(KOREAN_VTUBER_SOLAR_SYSTEM_PROMPT, /visualPlacement/u);

  const serializedSchema = JSON.stringify(UPSTAGE_CAPTION_JSON_SCHEMA);
  assert.equal(serializedSchema.includes('"$ref"'), false);
  assert.equal(serializedSchema.includes('"anyOf"'), false);
  assert.deepEqual(
    UPSTAGE_CAPTION_JSON_SCHEMA.schema.properties.cues.items.required,
    [
      "startMs",
      "endMs",
      "text",
      "speakerId",
      "reviewRequired",
      "placement"
    ]
  );
  assert.equal(
    UPSTAGE_CAPTION_JSON_SCHEMA.schema.properties.cues.items
      .properties.startMs.type,
    "integer"
  );
});

test("caption-agent 요청은 스키마·한국어·클립 길이·base64를 엄격히 검증한다", () => {
  const request = validateCaptionAgentRequest(protocolRequest({
    requestId: "request-1"
  }));
  assert.deepEqual(
    {
      schema: request.schema,
      requestId: request.requestId,
      clipId: request.clipId,
      clipDurationMs: request.clipDurationMs,
      language: request.language,
      streamerName: request.streamerName,
      model: request.model
    },
    {
      schema: CAPTION_AGENT_REQUEST_SCHEMA_ID,
      requestId: "request-1",
      clipId: "clip-1",
      clipDurationMs: 12_345,
      language: "ko",
      streamerName: "엘리",
      model: "solar-pro3"
    }
  );

  assert.throws(
    () => validateCaptionAgentRequest(protocolRequest({
      requestId: ""
    })),
    /requestId/u
  );
  assert.throws(
    () => validateCaptionAgentRequest({
      ...protocolRequest(),
      unexpected: true
    }),
    (error) => (
      error instanceof CaptionProtocolError
      && error.code === "UNKNOWN_REQUEST_FIELD"
    )
  );
  assert.throws(
    () => validateCaptionAgentRequest(protocolRequest({ locale: "en-US" })),
    (error) => error.code === "UNSUPPORTED_LANGUAGE"
  );
  assert.throws(
    () => validateCaptionAgentRequest(protocolRequest({ model: "solar-pro2" })),
    (error) => error.code === "INVALID_REQUEST_FIELD"
  );
  assert.throws(
    () => validateCaptionAgentRequest(protocolRequest({ visual: undefined })),
    (error) => error.code === "INVALID_REQUEST_FIELD"
  );
  assert.throws(
    () => validateCaptionAgentRequest(protocolRequest({
      visual: {
        analysis: "local-three-band-edge-density-v1",
        framesShared: false,
        samples: [{
          atMs: 12_345,
          topScore: 0,
          centerScore: 0,
          bottomScore: 0,
          preferredPlacement: "bottom"
        }]
      }
    })),
    (error) => error.code === "INVALID_VISUAL_PLACEMENT"
  );
  assert.throws(
    () => validateCaptionAgentRequest(protocolRequest({
      clip: { id: "clip-1", title: "", durationMs: 0 }
    })),
    (error) => error.code === "INVALID_REQUEST_FIELD"
  );
  assert.throws(
    () => validateCaptionAgentRequest(protocolRequest({
      audio: {
        encoding: "base64",
        mimeType: "audio/wav",
        sampleRateHz: 16_000,
        channels: 1,
        data: "not base64"
      }
    })),
    (error) => error.code === "INVALID_REQUEST_FIELD"
  );
});

test("편집기가 만드는 실제 요청과 companion 계약이 같은 버전·필드를 사용한다", () => {
  assert.equal(EDITOR_REQUEST_SCHEMA, CAPTION_AGENT_REQUEST_SCHEMA_ID);
  assert.equal(EDITOR_RESPONSE_SCHEMA, CAPTION_AGENT_RESPONSE_SCHEMA_ID);
  const editorRequest = createCaptionAgentRequest({
    project: {
      id: "editor-project",
      name: "실제 편집기 요청",
      source: { streamerName: "한국 VTuber" }
    },
    clip: {
      id: "editor-clip",
      title: "첫 만남",
      sourceStartMs: 1_000,
      sourceEndMs: 6_000
    },
    model: "solar-pro3",
    audioBase64: wavBase64(),
    placementHints: {
      analysis: "local-three-band-edge-density-v1",
      framesShared: false,
      samples: [{
        atMs: 500,
        topScore: 720,
        centerScore: 430,
        bottomScore: 110,
        preferredPlacement: "bottom"
      }]
    }
  });
  const normalized = validateCaptionAgentRequest(editorRequest);
  assert.equal(normalized.clipId, "editor-clip");
  assert.equal(normalized.clipDurationMs, 5_000);
  assert.equal(normalized.model, "solar-pro3");
  assert.deepEqual(normalized.visualPlacement, editorRequest.visual);

  const editorCues = normalizeCaptionAgentCues([{
    startMs: 100,
    endMs: 1_200,
    text: "연결됐어?",
    speakerId: "main",
    reviewRequired: false,
    placement: "bottom"
  }], 5_000);
  assert.equal(editorCues[0].text, "연결됐어?");
  assert.equal(editorCues[0].remoteMeta.speakerId, "main");
});

test("종결 마침표만 제거하고 물음표·느낌표는 보존한다", () => {
  assert.equal(stripTerminalPeriods("안녕하세요."), "안녕하세요");
  assert.equal(stripTerminalPeriods("진짜야?."), "진짜야?");
  assert.equal(stripTerminalPeriods("대박!..."), "대박!");
  assert.equal(stripTerminalPeriods("「괜찮아。」"), "「괜찮아」");
  assert.equal(stripTerminalPeriods("3.14"), "3.14");
});

test("Solar cue는 클립 안으로 맞추고 4초 이하 의미 조각으로 나눈다", () => {
  const result = normalizeCaptionCuesDetailed([
    {
      startMs: -500,
      endMs: 9_000,
      text: "하나 둘 셋 넷 다섯 여섯.",
      speaker: "main"
    },
    {
      start_ms: 9_100,
      end_ms: 15_000,
      text: "진짜야?.",
      speaker: "speaker-2"
    },
    {
      startMs: 10_000,
      endMs: 10_000,
      text: "범위가 없는 cue.",
      speaker: "main"
    }
  ], {
    clipDurationMs: 12_000
  });

  assert.equal(result.cues.length, 4);
  assert(result.cues.every((cue) => (
    cue.startMs >= 0
    && cue.startMs < cue.endMs
    && cue.endMs <= 12_000
    && cue.endMs - cue.startMs <= MAX_CAPTION_CUE_DURATION_MS
  )));
  assert.equal(
    result.cues.slice(0, 3).map((cue) => cue.text).join(" "),
    "하나 둘 셋 넷 다섯 여섯"
  );
  assert.equal(result.cues.at(-1).text, "진짜야?");
  assert.equal(result.cues.at(-1).speakerId, "speaker-2");
  assert.equal(result.cues.at(-1).placement, "bottom");
  assert(result.warnings.some((warning) => warning.code === "SPLIT_LONG_CUE"));
  assert(result.warnings.some((warning) => warning.code === "DROPPED_EMPTY_RANGE"));
  assert.equal(
    validateCaptionCues(result.cues, { clipDurationMs: 12_000 }).valid,
    true
  );
});

test("[불명확] 자막은 Solar가 false를 반환해도 사람 검수를 강제한다", () => {
  const result = normalizeCaptionCuesDetailed([{
    startMs: 0,
    endMs: 900,
    text: "[불명확]",
    speakerId: "main",
    reviewRequired: false,
    placement: "bottom"
  }], {
    clipDurationMs: 1_000
  });
  assert.equal(result.cues[0].reviewRequired, true);
});

test("Solar의 0.1초 미만 cue는 클립 경계 안에서 안전하게 늘린다", () => {
  const result = normalizeCaptionCuesDetailed([{
    startMs: 9_950,
    endMs: 10_000,
    text: "어",
    speakerId: "main",
    reviewRequired: false,
    placement: "bottom"
  }], {
    clipDurationMs: 10_000
  });
  assert.deepEqual(
    [result.cues[0].startMs, result.cues[0].endMs],
    [9_900, 10_000]
  );
  assert(
    result.warnings.some(
      (warning) => warning.code === "EXPANDED_SHORT_CUE"
    )
  );
});

test("Solar 원시 cue와 응답 warning 개수 상한을 처리 전에 강제한다", () => {
  assert.throws(
    () => normalizeCaptionCuesDetailed(
      Array.from({ length: MAX_CAPTION_CUES + 1 }, () => ({})),
      { clipDurationMs: 1_000 }
    ),
    (error) => error?.code === "SOLAR_CUE_LIMIT_EXCEEDED"
  );

  const request = validateCaptionAgentRequest(protocolRequest());
  assert.throws(
    () => createCaptionAgentResponse({
      request,
      sttModel: "external-stt",
      captionModel: "solar-pro3",
      cues: [],
      warnings: Array.from(
        { length: MAX_CAPTION_WARNINGS + 1 },
        (_, cueIndex) => ({ code: "TOO_MANY", cueIndex })
      )
    }),
    (error) => error?.code === "INVALID_RESPONSE_WARNINGS"
  );
});

test("cue 검증은 경계·최대 4초·종결 마침표를 각각 진단한다", () => {
  assert.deepEqual(
    validateCaptionCue({
      startMs: -1,
      endMs: 5_000,
      text: "너무 길다.",
      speakerId: "",
      reviewRequired: "no",
      placement: "side"
    }, {
      clipDurationMs: 4_500
    }),
    [
      "startMs",
      "clipDurationMs",
      "maxDurationMs",
      "terminalPeriod",
      "speakerId",
      "reviewRequired",
      "placement"
    ]
  );
});

test("응답 생성기는 정규화된 cue와 모델 식별자만 계약 형태로 내보낸다", () => {
  const request = validateCaptionAgentRequest(protocolRequest({
    requestId: "request-response",
    clip: {
      id: "clip-response",
      title: "",
      durationMs: 4_000
    }
  }));
  const response = createCaptionAgentResponse({
    request,
    sttModel: "external-stt",
    captionModel: "solar-pro3",
    cues: [{
      startMs: 0,
      endMs: 2_000,
      text: "안녕?",
      speakerId: "main",
      reviewRequired: false,
      placement: "bottom"
    }]
  });
  assert.equal(response.schema, CAPTION_AGENT_RESPONSE_SCHEMA_ID);
  assert.equal(response.requestId, "request-response");
  assert.equal(response.sttModel, "external-stt");
  assert.equal(response.captionModel, "solar-pro3");
  assert.equal(response.provider, "upstage");
  assert.equal(response.status, "completed");
  assert.deepEqual(response.warnings, []);
});
