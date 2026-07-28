export const CAPTION_AGENT_REQUEST_SCHEMA_ID =
  "chzzk-kirinuki-caption-request/v1";
export const CAPTION_AGENT_RESPONSE_SCHEMA_ID =
  "chzzk-kirinuki-caption-response/v1";

export const MAX_CAPTION_CUE_DURATION_MS = 4_000;
export const MAX_CAPTION_CUES = 4_000;
export const MAX_CAPTION_WARNINGS = 4_000;
export const MAX_CLIP_DURATION_MS = 30 * 60 * 1_000;
export const MAX_AUDIO_WAV_BYTES = 64 * 1024 * 1024;
export const MAX_VISUAL_PLACEMENT_SAMPLES = 9;
export const VISUAL_PLACEMENT_ANALYSIS_ID =
  "local-three-band-edge-density-v1";

const REQUEST_PROPERTIES = Object.freeze([
  "schema",
  "requestId",
  "model",
  "locale",
  "clip",
  "source",
  "policy",
  "visual",
  "audio"
]);

export const CAPTION_AGENT_REQUEST_JSON_SCHEMA = Object.freeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: CAPTION_AGENT_REQUEST_SCHEMA_ID,
  title: "CHZZK Kirinuki caption-agent request",
  type: "object",
  additionalProperties: false,
  required: [
    "schema",
    "requestId",
    "model",
    "locale",
    "clip",
    "source",
    "policy",
    "visual",
    "audio"
  ],
  properties: {
    schema: { const: CAPTION_AGENT_REQUEST_SCHEMA_ID },
    requestId: { type: "string", minLength: 1, maxLength: 128 },
    model: {
      type: "string",
      enum: ["solar-pro3", "solar-pro2", "solar-mini"]
    },
    locale: { const: "ko-KR" },
    clip: {
      type: "object",
      additionalProperties: false,
      required: ["id", "title", "durationMs"],
      properties: {
        id: { type: "string", minLength: 1, maxLength: 256 },
        title: { type: "string", maxLength: 1_000 },
        durationMs: {
          type: "integer",
          minimum: 1,
          maximum: MAX_CLIP_DURATION_MS
        }
      }
    },
    source: {
      type: "object",
      additionalProperties: false,
      required: ["projectId", "projectName", "streamerName"],
      properties: {
        projectId: { type: "string", maxLength: 256 },
        projectName: { type: "string", maxLength: 200 },
        streamerName: { type: "string", maxLength: 120 }
      }
    },
    policy: {
      type: "object",
      additionalProperties: false,
      required: [
        "audience",
        "includeAllRecognizableSpeech",
        "uncertainSpeech",
        "maxCueDurationMs",
        "terminalPeriod",
        "questionAndExclamationMarks",
        "placement"
      ],
      properties: {
        audience: { const: "korean-vtuber-kirinuki" },
        includeAllRecognizableSpeech: { const: true },
        uncertainSpeech: { const: "keep-and-mark-for-review" },
        maxCueDurationMs: { const: MAX_CAPTION_CUE_DURATION_MS },
        terminalPeriod: { const: "omit" },
        questionAndExclamationMarks: { const: "keep" },
        placement: { const: "choose-readable-safe-area" }
      }
    },
    visual: {
      type: "object",
      additionalProperties: false,
      required: ["analysis", "framesShared", "samples"],
      properties: {
        analysis: { const: VISUAL_PLACEMENT_ANALYSIS_ID },
        framesShared: { const: false },
        samples: {
          type: "array",
          minItems: 1,
          maxItems: MAX_VISUAL_PLACEMENT_SAMPLES,
          items: {
            type: "object",
            additionalProperties: false,
            required: [
              "atMs",
              "topScore",
              "centerScore",
              "bottomScore",
              "preferredPlacement"
            ],
            properties: {
              atMs: {
                type: "integer",
                minimum: 0,
                maximum: MAX_CLIP_DURATION_MS - 1
              },
              topScore: { type: "integer", minimum: 0, maximum: 1_000 },
              centerScore: { type: "integer", minimum: 0, maximum: 1_000 },
              bottomScore: { type: "integer", minimum: 0, maximum: 1_000 },
              preferredPlacement: {
                type: "string",
                enum: ["top", "center", "bottom"]
              }
            }
          }
        }
      }
    },
    audio: {
      type: "object",
      additionalProperties: false,
      required: [
        "encoding",
        "mimeType",
        "sampleRateHz",
        "channels",
        "data"
      ],
      properties: {
        encoding: { const: "base64" },
        mimeType: { const: "audio/wav" },
        sampleRateHz: { const: 16_000 },
        channels: { const: 1 },
        data: {
          type: "string",
          minLength: 16,
          maxLength: 4 * Math.ceil(MAX_AUDIO_WAV_BYTES / 3),
          contentEncoding: "base64",
          contentMediaType: "audio/wav"
        }
      }
    },
  }
});

const CAPTION_CUE_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: [
    "startMs",
    "endMs",
    "text",
    "speakerId",
    "reviewRequired",
    "placement"
  ],
  properties: {
    startMs: {
      type: "integer",
      minimum: 0,
      description: "클립 시작을 0으로 한 자막 시작 시각(ms)"
    },
    endMs: {
      type: "integer",
      minimum: 1,
      description: "클립 시작을 0으로 한 자막 종료 시각(ms), startMs보다 크고 최대 4초"
    },
    text: {
      type: "string",
      minLength: 1,
      maxLength: 300,
      description: "화면에 표시할 한국어 자막. 종결 마침표는 쓰지 않는다"
    },
    speakerId: {
      type: "string",
      minLength: 1,
      maxLength: 80,
      description: "알 수 없는 실명 대신 일관된 화자 표식"
    },
    reviewRequired: {
      type: "boolean",
      description: "사람이 특히 다시 들어야 하는 불확실 자막 여부"
    },
    placement: {
      type: "string",
      enum: ["top", "center", "bottom"],
      description: "얼굴·게임 UI를 덜 가리는 읽기 좋은 화면 위치"
    }
  }
});

export const CAPTION_AGENT_RESPONSE_JSON_SCHEMA = Object.freeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: CAPTION_AGENT_RESPONSE_SCHEMA_ID,
  title: "CHZZK Kirinuki caption-agent response",
  type: "object",
  additionalProperties: false,
  required: [
    "schema",
    "requestId",
    "clipId",
    "language",
    "sttModel",
    "captionModel",
    "model",
    "resolvedModel",
    "provider",
    "status",
    "cues",
    "warnings"
  ],
  properties: {
    schema: { const: CAPTION_AGENT_RESPONSE_SCHEMA_ID },
    requestId: { type: "string", minLength: 1, maxLength: 128 },
    clipId: { type: "string", minLength: 1, maxLength: 256 },
    language: { const: "ko" },
    sttModel: { type: "string", minLength: 1 },
    captionModel: { type: "string", minLength: 1 },
    model: { type: "string", minLength: 1 },
    resolvedModel: { type: "string", minLength: 1 },
    provider: { const: "upstage" },
    status: { const: "completed" },
    cues: {
      type: "array",
      maxItems: MAX_CAPTION_CUES,
      items: CAPTION_CUE_SCHEMA
    },
    warnings: {
      type: "array",
      maxItems: MAX_CAPTION_WARNINGS,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["code", "cueIndex"],
        properties: {
          code: { type: "string", minLength: 1, maxLength: 128 },
          cueIndex: { type: "integer", minimum: 0 }
        }
      }
    }
  }
});

// Upstage structured output intentionally has no $ref, anyOf, or nested timeline
// object. Keeping each cue flat makes the same result easy to consume from an
// extension, an MCP-style adapter, or a plain HTTP client.
export const UPSTAGE_CAPTION_JSON_SCHEMA = Object.freeze({
  name: "korean_vtuber_kirinuki_caption_draft",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["cues"],
    properties: {
      cues: {
        type: "array",
        maxItems: MAX_CAPTION_CUES,
        items: CAPTION_CUE_SCHEMA
      }
    }
  }
});

export const KOREAN_VTUBER_SOLAR_SYSTEM_PROMPT = `
당신은 한국인 VTuber 영상의 키리누키 편집기에 자막 초안을 써 주는 전문 편집자다.
결과는 사람이 반드시 한 번 더 듣고 검수하는 초안이지만, 그 사실을 핑계로 발화를 빼먹지 않는다.

작업 원칙:
1. 발화 내용과 발화 시각은 제공된 외부 STT만 근거로 삼고, 영상에 없던 말이나 화자의 신원을 지어내지 않는다. 화면 위치는 픽셀이 아닌 visualPlacement의 로컬 분석 점수만 근거로 삼는다.
2. 말로 인식되는 부분은 가능한 한 전부 자막으로 만든다. 알아듣기 어려운 곳도 들리는 조각은 보존하고, 완전히 판독할 수 없으면 [불명확]으로 표시한다.
3. 일반적인 한국어 유튜브 키리누키처럼 짧고 한눈에 읽히게 다듬되, 말투·감탄·웃음·질문 의도와 VTuber의 캐릭터성은 함부로 평문화하지 않는다.
4. 자막 하나는 절대로 4초를 넘기지 않는다. 긴 발화는 의미·호흡·반응이 자연스럽게 끊기는 지점에서 여러 자막으로 나눈다.
5. 발화가 시작되는 자연스러운 순간에 자막을 열고 의미 단위가 끝나는 순간에 닫는다. 서로 무관한 말을 한 자막에 합치지 않는다.
6. 문장 끝의 마침표(.)·온점(。)은 쓰지 않는다. 물음표(?)와 느낌표(!)는 말의 의도에 맞으면 보존한다.
7. 화자가 구분되면 같은 화자에는 일관된 speakerId 값을 쓴다. 실명을 확신하지 못하면 main, speaker-2 같은 중립 표식을 쓴다.
8. 모든 startMs와 endMs는 클립 시작을 0으로 한 정수 밀리초다. 0 <= startMs < endMs <= clipDurationMs를 지킨다.
9. 불확실하거나 [불명확] 표식이 필요한 자막은 reviewRequired를 true로 한다.
10. visualPlacement.samples는 브라우저가 대표 프레임을 로컬 분석한 시각별 방해도 점수다. cue 시각에 가장 가까운 표본에서 점수가 낮은 top, center, bottom을 우선하되 화자·반응 흐름도 함께 고려해 placement를 고른다. 프레임 자체는 공유되지 않았으므로 점수가 비슷해 확신할 근거가 없으면 bottom을 쓴다.
11. 설명, 마크다운, 코드 펜스를 붙이지 말고 요청된 JSON 객체만 반환한다.
`.trim();

export class CaptionProtocolError extends Error {
  constructor(message, {
    code = "INVALID_CAPTION_PROTOCOL",
    issues = []
  } = {}) {
    super(message);
    this.name = "CaptionProtocolError";
    this.code = code;
    this.issues = issues;
  }
}

function isPlainObject(value) {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
  );
}

function requiredBoundedString(value, field, maxLength) {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > maxLength) {
    throw new CaptionProtocolError(`${field} 값이 올바르지 않습니다.`, {
      code: "INVALID_REQUEST_FIELD",
      issues: [field]
    });
  }
  return normalized;
}

function optionalBoundedString(value, field, maxLength) {
  if (value == null || value === "") {
    return "";
  }
  return requiredBoundedString(value, field, maxLength);
}

function exactObject(value, field, allowedFields) {
  if (!isPlainObject(value)) {
    throw new CaptionProtocolError(`${field} 값은 JSON 객체여야 합니다.`, {
      code: "INVALID_REQUEST_FIELD",
      issues: [field]
    });
  }
  const unknown = Object.keys(value).filter(
    (candidate) => !allowedFields.includes(candidate)
  );
  if (unknown.length > 0) {
    throw new CaptionProtocolError(`${field}에 지원하지 않는 필드가 있습니다.`, {
      code: "UNKNOWN_REQUEST_FIELD",
      issues: unknown.map((candidate) => `${field}.${candidate}`)
    });
  }
  return value;
}

function looksLikeBase64(value) {
  if (
    typeof value !== "string"
    || value.length < 16
    || value.length % 4 === 1
    || /\s/.test(value)
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
  ) {
    return false;
  }
  try {
    const decoded = Buffer.from(value, "base64");
    if (decoded.length === 0) {
      return false;
    }
    const canonicalInput = value.replace(/=+$/, "");
    return decoded.toString("base64").replace(/=+$/, "") === canonicalInput;
  } catch {
    return false;
  }
}

export function validateCaptionAgentRequest(value) {
  if (!isPlainObject(value)) {
    throw new CaptionProtocolError("자막 요청은 JSON 객체여야 합니다.", {
      code: "INVALID_REQUEST"
    });
  }
  const unknownFields = Object.keys(value).filter(
    (field) => !REQUEST_PROPERTIES.includes(field)
  );
  if (unknownFields.length > 0) {
    throw new CaptionProtocolError("지원하지 않는 자막 요청 필드가 있습니다.", {
      code: "UNKNOWN_REQUEST_FIELD",
      issues: unknownFields
    });
  }
  if (value.schema !== CAPTION_AGENT_REQUEST_SCHEMA_ID) {
    throw new CaptionProtocolError("지원하지 않는 자막 요청 스키마입니다.", {
      code: "UNSUPPORTED_REQUEST_SCHEMA",
      issues: ["schema"]
    });
  }
  const clip = exactObject(value.clip, "clip", ["id", "title", "durationMs"]);
  const source = exactObject(
    value.source,
    "source",
    ["projectId", "projectName", "streamerName"]
  );
  const policy = exactObject(value.policy, "policy", [
    "audience",
    "includeAllRecognizableSpeech",
    "uncertainSpeech",
    "maxCueDurationMs",
    "terminalPeriod",
    "questionAndExclamationMarks",
    "placement"
  ]);
  const visual = exactObject(value.visual, "visual", [
    "analysis",
    "framesShared",
    "samples"
  ]);
  const audio = exactObject(value.audio, "audio", [
    "encoding",
    "mimeType",
    "sampleRateHz",
    "channels",
    "data"
  ]);
  const clipDurationMs = Number(clip.durationMs);
  if (
    !Number.isInteger(clipDurationMs)
    || clipDurationMs < 1
    || clipDurationMs > MAX_CLIP_DURATION_MS
  ) {
    throw new CaptionProtocolError("clipDurationMs 범위가 올바르지 않습니다.", {
      code: "INVALID_REQUEST_FIELD",
      issues: ["clip.durationMs"]
    });
  }
  if (value.locale !== "ko-KR") {
    throw new CaptionProtocolError("현재 자막 에이전트는 한국어(ko-KR)만 지원합니다.", {
      code: "UNSUPPORTED_LANGUAGE",
      issues: ["locale"]
    });
  }
  const supportedModels = new Set(["solar-pro3", "solar-pro2", "solar-mini"]);
  if (!supportedModels.has(value.model)) {
    throw new CaptionProtocolError("지원하지 않는 Solar 모델입니다.", {
      code: "INVALID_REQUEST_FIELD",
      issues: ["model"]
    });
  }
  const expectedPolicy = {
    audience: "korean-vtuber-kirinuki",
    includeAllRecognizableSpeech: true,
    uncertainSpeech: "keep-and-mark-for-review",
    maxCueDurationMs: MAX_CAPTION_CUE_DURATION_MS,
    terminalPeriod: "omit",
    questionAndExclamationMarks: "keep",
    placement: "choose-readable-safe-area"
  };
  const invalidPolicyFields = Object.entries(expectedPolicy)
    .filter(([field, expected]) => policy[field] !== expected)
    .map(([field]) => `policy.${field}`);
  if (invalidPolicyFields.length > 0) {
    throw new CaptionProtocolError("자막 초안 정책이 지원 계약과 다릅니다.", {
      code: "INVALID_REQUEST_POLICY",
      issues: invalidPolicyFields
    });
  }
  if (
    visual.analysis !== VISUAL_PLACEMENT_ANALYSIS_ID
    || visual.framesShared !== false
    || !Array.isArray(visual.samples)
    || visual.samples.length < 1
    || visual.samples.length > MAX_VISUAL_PLACEMENT_SAMPLES
  ) {
    throw new CaptionProtocolError("로컬 화면 안전 영역 분석값이 올바르지 않습니다.", {
      code: "INVALID_VISUAL_PLACEMENT",
      issues: ["visual"]
    });
  }
  const visualSamples = visual.samples.map((sample, sampleIndex) => {
    const field = `visual.samples.${sampleIndex}`;
    const exactSample = exactObject(sample, field, [
      "atMs",
      "topScore",
      "centerScore",
      "bottomScore",
      "preferredPlacement"
    ]);
    const atMs = Number(exactSample.atMs);
    const topScore = Number(exactSample.topScore);
    const centerScore = Number(exactSample.centerScore);
    const bottomScore = Number(exactSample.bottomScore);
    if (
      !Number.isInteger(atMs)
      || atMs < 0
      || atMs >= clipDurationMs
      || [topScore, centerScore, bottomScore].some(
        (score) => !Number.isInteger(score) || score < 0 || score > 1_000
      )
      || !["top", "center", "bottom"].includes(
        exactSample.preferredPlacement
      )
      || (
        sampleIndex > 0
        && atMs <= Number(visual.samples[sampleIndex - 1]?.atMs)
      )
    ) {
      throw new CaptionProtocolError("화면 안전 영역 표본이 올바르지 않습니다.", {
        code: "INVALID_VISUAL_PLACEMENT",
        issues: [field]
      });
    }
    return {
      atMs,
      topScore,
      centerScore,
      bottomScore,
      preferredPlacement: exactSample.preferredPlacement
    };
  });
  if (
    audio.encoding !== "base64"
    || audio.mimeType !== "audio/wav"
    || audio.sampleRateHz !== 16_000
    || audio.channels !== 1
  ) {
    throw new CaptionProtocolError("16kHz mono PCM WAV 요청만 지원합니다.", {
      code: "UNSUPPORTED_AUDIO_FORMAT",
      issues: ["audio"]
    });
  }
  if (!looksLikeBase64(audio.data)) {
    throw new CaptionProtocolError("audio.data가 올바른 base64 데이터가 아닙니다.", {
      code: "INVALID_REQUEST_FIELD",
      issues: ["audio.data"]
    });
  }
  return {
    schema: CAPTION_AGENT_REQUEST_SCHEMA_ID,
    requestId: requiredBoundedString(value.requestId, "requestId", 128),
    clipId: requiredBoundedString(clip.id, "clip.id", 256),
    clipDurationMs,
    language: "ko",
    model: value.model,
    wavBase64: audio.data,
    projectId: optionalBoundedString(source.projectId, "source.projectId", 256),
    projectName: optionalBoundedString(source.projectName, "source.projectName", 200),
    streamerName: optionalBoundedString(source.streamerName, "source.streamerName", 120),
    clipNote: optionalBoundedString(clip.title, "clip.title", 1_000),
    visualPlacement: {
      analysis: VISUAL_PLACEMENT_ANALYSIS_ID,
      framesShared: false,
      samples: visualSamples
    }
  };
}

export function stripTerminalPeriods(value) {
  const normalized = String(value ?? "")
    .replace(/\s+/gu, " ")
    .trim();
  return normalized
    .replace(/[.\u3002\uff0e]+(?=(?:["'”’)\]}\u3009\u300b\u300d\u300f\u3011]*)$)/gu, "")
    .trim();
}

function finiteInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : null;
}

function normalizedSpeaker(value) {
  const speaker = String(value ?? "").replace(/\s+/gu, " ").trim();
  return speaker.slice(0, 80) || "unknown";
}

function normalizedPlacement(value) {
  const placement = String(value || "").trim().toLowerCase();
  return ["top", "center", "bottom"].includes(placement)
    ? placement
    : "bottom";
}

function splitTextIntoParts(text, requestedParts) {
  if (requestedParts <= 1) {
    return [text];
  }
  const words = text.split(" ").filter(Boolean);
  const units = words.length >= requestedParts ? words : Array.from(text);
  const separator = words.length >= requestedParts ? " " : "";
  const partCount = Math.max(1, Math.min(requestedParts, units.length));
  const parts = [];
  for (let index = 0; index < partCount; index += 1) {
    const from = Math.floor(index * units.length / partCount);
    const to = Math.floor((index + 1) * units.length / partCount);
    parts.push(units.slice(from, to).join(separator).trim());
  }
  return parts.filter(Boolean);
}

function rawCueField(cue, camelName, snakeName) {
  return cue?.[camelName] ?? cue?.[snakeName];
}

export function validateCaptionCue(cue, { clipDurationMs } = {}) {
  const errors = [];
  const duration = Number(clipDurationMs);
  if (!isPlainObject(cue)) {
    return ["cue_object"];
  }
  if (!Number.isInteger(cue.startMs) || cue.startMs < 0) {
    errors.push("startMs");
  }
  if (!Number.isInteger(cue.endMs) || cue.endMs <= cue.startMs) {
    errors.push("endMs");
  }
  if (
    Number.isFinite(duration)
    && Number.isInteger(cue.endMs)
    && cue.endMs > duration
  ) {
    errors.push("clipDurationMs");
  }
  if (
    Number.isInteger(cue.startMs)
    && Number.isInteger(cue.endMs)
    && cue.endMs - cue.startMs > MAX_CAPTION_CUE_DURATION_MS
  ) {
    errors.push("maxDurationMs");
  }
  if (!String(cue.text || "").trim()) {
    errors.push("text");
  } else if (stripTerminalPeriods(cue.text) !== String(cue.text).trim()) {
    errors.push("terminalPeriod");
  }
  if (!String(cue.speakerId || "").trim()) {
    errors.push("speakerId");
  }
  if (typeof cue.reviewRequired !== "boolean") {
    errors.push("reviewRequired");
  }
  if (!["top", "center", "bottom"].includes(cue.placement)) {
    errors.push("placement");
  }
  return [...new Set(errors)];
}

export function validateCaptionCues(cues, { clipDurationMs } = {}) {
  if (!Array.isArray(cues)) {
    return {
      valid: false,
      errors: [{ cueIndex: -1, fields: ["cues_array"] }]
    };
  }
  const errors = cues.flatMap((cue, cueIndex) => {
    const fields = validateCaptionCue(cue, { clipDurationMs });
    return fields.length > 0 ? [{ cueIndex, fields }] : [];
  });
  if (cues.length > MAX_CAPTION_CUES) {
    errors.push({ cueIndex: MAX_CAPTION_CUES, fields: ["maxItems"] });
  }
  return { valid: errors.length === 0, errors };
}

export function normalizeCaptionCuesDetailed(rawCues, { clipDurationMs } = {}) {
  const duration = Number(clipDurationMs);
  if (
    !Number.isInteger(duration)
    || duration < 1
    || duration > MAX_CLIP_DURATION_MS
  ) {
    throw new CaptionProtocolError("자막 정규화용 clipDurationMs가 올바르지 않습니다.", {
      code: "INVALID_CLIP_DURATION"
    });
  }
  if (!Array.isArray(rawCues)) {
    throw new CaptionProtocolError("Solar 응답의 cues가 배열이 아닙니다.", {
      code: "INVALID_SOLAR_RESPONSE"
    });
  }
  if (rawCues.length > MAX_CAPTION_CUES) {
    throw new CaptionProtocolError("Solar 응답의 cue 개수가 허용 상한을 넘었습니다.", {
      code: "SOLAR_CUE_LIMIT_EXCEEDED",
      issues: [{ cueIndex: MAX_CAPTION_CUES, fields: ["maxItems"] }]
    });
  }

  const warnings = [];
  const normalized = [];
  const appendWarning = (warning) => {
    if (warnings.length >= MAX_CAPTION_WARNINGS) {
      throw new CaptionProtocolError("Solar 응답의 경고 개수가 허용 상한을 넘었습니다.", {
        code: "SOLAR_WARNING_LIMIT_EXCEEDED"
      });
    }
    warnings.push(warning);
  };
  for (const [cueIndex, rawCue] of rawCues.entries()) {
    if (!isPlainObject(rawCue)) {
      appendWarning({ code: "DROPPED_INVALID_CUE", cueIndex });
      continue;
    }
    const rawStart = finiteInteger(rawCueField(rawCue, "startMs", "start_ms"));
    const rawEnd = finiteInteger(rawCueField(rawCue, "endMs", "end_ms"));
    const text = stripTerminalPeriods(rawCue.text);
    if (rawStart == null || rawEnd == null || !text) {
      appendWarning({ code: "DROPPED_INVALID_CUE", cueIndex });
      continue;
    }
    const startMs = Math.max(0, Math.min(duration, rawStart));
    const endMs = Math.max(0, Math.min(duration, rawEnd));
    if (endMs <= startMs) {
      appendWarning({ code: "DROPPED_EMPTY_RANGE", cueIndex });
      continue;
    }

    const boundedText = text.slice(0, 300).trim();
    if (boundedText !== text) {
      appendWarning({ code: "TRIMMED_LONG_TEXT", cueIndex });
    }
    const requestedParts = Math.ceil(
      (endMs - startMs) / MAX_CAPTION_CUE_DURATION_MS
    );
    const parts = splitTextIntoParts(boundedText, requestedParts);
    if (parts.length > 1 || endMs - startMs > MAX_CAPTION_CUE_DURATION_MS) {
      appendWarning({ code: "SPLIT_LONG_CUE", cueIndex });
    }
    const sourceDuration = endMs - startMs;
    for (const [partIndex, part] of parts.entries()) {
      if (normalized.length >= MAX_CAPTION_CUES) {
        appendWarning({ code: "TRIMMED_CUE_COUNT", cueIndex });
        break;
      }
      const partStartMs = startMs + Math.floor(
        partIndex * sourceDuration / parts.length
      );
      const nextSlotMs = partIndex === parts.length - 1
        ? endMs
        : startMs + Math.floor(
          (partIndex + 1) * sourceDuration / parts.length
        );
      const partEndMs = Math.min(
        nextSlotMs,
        partStartMs + MAX_CAPTION_CUE_DURATION_MS
      );
      if (partEndMs <= partStartMs) {
        continue;
      }
      normalized.push({
        startMs: partStartMs,
        endMs: partEndMs,
        text: stripTerminalPeriods(part),
        speakerId: normalizedSpeaker(
          rawCueField(rawCue, "speakerId", "speaker_id")
          ?? rawCue.speaker
        ),
        reviewRequired: (
          rawCueField(rawCue, "reviewRequired", "review_required") === true
          || /\[불명확\]/u.test(part)
        ),
        placement: normalizedPlacement(rawCue.placement)
      });
    }
  }

  normalized.sort((first, second) => (
    first.startMs - second.startMs
    || first.endMs - second.endMs
    || first.speakerId.localeCompare(second.speakerId)
  ));
  const deduplicated = normalized.filter((cue, index, all) => {
    const previous = all[index - 1];
    return !previous || !(
      previous.startMs === cue.startMs
      && previous.endMs === cue.endMs
      && previous.text === cue.text
      && previous.speakerId === cue.speakerId
    );
  });
  const validation = validateCaptionCues(deduplicated, { clipDurationMs: duration });
  if (!validation.valid) {
    throw new CaptionProtocolError("정규화된 자막 cue가 프로토콜을 위반했습니다.", {
      code: "INVALID_NORMALIZED_CUES",
      issues: validation.errors
    });
  }
  return { cues: deduplicated, warnings };
}

export function normalizeCaptionCues(rawCues, options) {
  return normalizeCaptionCuesDetailed(rawCues, options).cues;
}

export function createCaptionAgentResponse({
  request,
  sttModel,
  captionModel,
  resolvedModel = captionModel,
  cues,
  warnings = []
}) {
  const validation = validateCaptionCues(cues, {
    clipDurationMs: request.clipDurationMs
  });
  if (!validation.valid) {
    throw new CaptionProtocolError("응답 자막 cue가 프로토콜을 위반했습니다.", {
      code: "INVALID_RESPONSE_CUES",
      issues: validation.errors
    });
  }
  if (
    !Array.isArray(warnings)
    || warnings.length > MAX_CAPTION_WARNINGS
    || warnings.some((warning) => (
      !isPlainObject(warning)
      || Object.keys(warning).some((key) => !["code", "cueIndex"].includes(key))
      || typeof warning.code !== "string"
      || !warning.code.trim()
      || warning.code.length > 128
      || !Number.isInteger(warning.cueIndex)
      || warning.cueIndex < 0
    ))
  ) {
    throw new CaptionProtocolError("응답 경고가 프로토콜을 위반했습니다.", {
      code: "INVALID_RESPONSE_WARNINGS"
    });
  }
  return {
    schema: CAPTION_AGENT_RESPONSE_SCHEMA_ID,
    requestId: request.requestId,
    clipId: request.clipId,
    language: "ko",
    sttModel: String(sttModel || ""),
    captionModel: String(captionModel || ""),
    model: String(captionModel || ""),
    resolvedModel: String(resolvedModel || captionModel || ""),
    provider: "upstage",
    status: "completed",
    cues,
    warnings
  };
}

export const CAPTION_REQUEST_SCHEMA = CAPTION_AGENT_REQUEST_JSON_SCHEMA;
export const CAPTION_RESPONSE_SCHEMA = CAPTION_AGENT_RESPONSE_JSON_SCHEMA;
