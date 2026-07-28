import {
  KOREAN_VTUBER_SOLAR_SYSTEM_PROMPT,
  UPSTAGE_CAPTION_JSON_SCHEMA,
  CaptionProtocolError,
  createCaptionAgentResponse,
  normalizeCaptionCuesDetailed,
  validateCaptionAgentRequest
} from "./protocol.js";

export const UPSTAGE_CHAT_COMPLETIONS_URL =
  "https://api.upstage.ai/v1/chat/completions";
export const DEFAULT_SOLAR_MODEL = "solar-pro3";
export const DEFAULT_STT_MODEL = "whisper-1";
export const DEFAULT_MAX_AUDIO_BYTES = 64 * 1024 * 1024;
export const DEFAULT_SOLAR_MAX_TOKENS = 4_096;
export const DEFAULT_PIPELINE_TIMEOUT_MS = 15 * 60 * 1_000;
export const MAX_PIPELINE_TIMEOUT_MS = 20 * 60 * 1_000;
export const MAX_PROVIDER_RESPONSE_BYTES = 16 * 1024 * 1024;
export const MAX_STT_SEGMENTS = 10_000;
export const MAX_STT_WORDS = 50_000;
export const MAX_SOLAR_PROMPT_BYTES = 2 * 1024 * 1024;
export const MAX_PROVIDER_API_KEY_LENGTH = 4_096;
export const MAX_STT_ENDPOINT_LENGTH = 2_048;
export const MAX_STT_MODEL_LENGTH = 160;

export class CaptionGatewayError extends Error {
  constructor(message, {
    code = "CAPTION_GATEWAY_ERROR",
    httpStatus = 502,
    responseFormatUnsupported = false
  } = {}) {
    super(message);
    this.name = "CaptionGatewayError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.responseFormatUnsupported = responseFormatUnsupported;
  }
}

function requiredConfigurationValue(value, name, {
  required = true,
  httpStatus = 500
} = {}) {
  const normalized = String(value || "").trim();
  if (!normalized && required) {
    throw new CaptionGatewayError(`${name} 설정이 필요합니다.`, {
      code: "MISSING_CONFIGURATION",
      httpStatus
    });
  }
  return normalized;
}

function isLoopbackHostname(hostname) {
  return hostname === "127.0.0.1" || hostname === "localhost";
}

function externalEndpoint(value, name, {
  allowQuery = true,
  ...options
} = {}) {
  const normalized = requiredConfigurationValue(value, name, options);
  if (!normalized) {
    return "";
  }
  if (normalized.length > MAX_STT_ENDPOINT_LENGTH) {
    throw new CaptionGatewayError(`${name} URL이 너무 깁니다.`, {
      code: "INVALID_CONFIGURATION",
      httpStatus: options?.httpStatus ?? 500
    });
  }
  let url;
  try {
    url = new URL(normalized);
  } catch {
    throw new CaptionGatewayError(`${name} URL이 올바르지 않습니다.`, {
      code: "INVALID_CONFIGURATION",
      httpStatus: options?.httpStatus ?? 500
    });
  }
  if (
    url.username
    || url.password
    || (!allowQuery && url.search)
    || url.hash
  ) {
    throw new CaptionGatewayError(
      allowQuery
        ? `${name}에 사용자 정보나 # 조각을 넣을 수 없습니다.`
        : `${name}에 사용자 정보·쿼리 문자열·# 조각을 넣을 수 없습니다.`,
      {
        code: "INVALID_CONFIGURATION",
        httpStatus: options?.httpStatus ?? 500
      }
    );
  }
  const secureRemote = url.protocol === "https:";
  const localHttp = url.protocol === "http:" && isLoopbackHostname(url.hostname);
  if (!secureRemote && !localHttp) {
    throw new CaptionGatewayError(
      `${name}는 HTTPS 또는 loopback HTTP URL이어야 합니다.`,
      {
        code: "INVALID_CONFIGURATION",
        httpStatus: options?.httpStatus ?? 500
      }
    );
  }
  return url.href;
}

function providerApiKey(value, name, options) {
  const normalized = requiredConfigurationValue(value, name, options);
  if (!normalized) {
    return "";
  }
  if (
    normalized.length > MAX_PROVIDER_API_KEY_LENGTH
    || /[\r\n]/u.test(normalized)
  ) {
    throw new CaptionGatewayError(`${name} 형식이 올바르지 않습니다.`, {
      code: "INVALID_CONFIGURATION",
      httpStatus: options?.httpStatus ?? 500
    });
  }
  return normalized;
}

function sttModelName(value, {
  fallback = DEFAULT_STT_MODEL,
  httpStatus = 500
} = {}) {
  const normalized = String(value || fallback).trim() || fallback;
  if (
    normalized.length > MAX_STT_MODEL_LENGTH
    || /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    throw new CaptionGatewayError("STT 모델명이 올바르지 않습니다.", {
      code: "INVALID_CONFIGURATION",
      httpStatus
    });
  }
  return normalized;
}

export function resolveCaptionPipelineConfig(
  env = process.env,
  { allowMissingProviderConfig = false } = {}
) {
  const maxAudioBytes = Number(env.KIRINUKI_MAX_AUDIO_BYTES);
  const maxTokens = Number(env.KIRINUKI_SOLAR_MAX_TOKENS);
  const pipelineTimeoutMs = Number(env.KIRINUKI_PIPELINE_TIMEOUT_MS);
  const providerOptions = {
    required: !allowMissingProviderConfig,
    httpStatus: 500
  };
  return {
    sttEndpoint: externalEndpoint(
      env.KIRINUKI_STT_ENDPOINT,
      "KIRINUKI_STT_ENDPOINT",
      providerOptions
    ),
    sttApiKey: providerApiKey(
      env.KIRINUKI_STT_API_KEY,
      "KIRINUKI_STT_API_KEY",
      providerOptions
    ),
    sttModel: sttModelName(env.KIRINUKI_STT_MODEL),
    upstageApiKey: providerApiKey(
      env.UPSTAGE_API_KEY,
      "UPSTAGE_API_KEY",
      providerOptions
    ),
    solarModel: String(
      env.KIRINUKI_SOLAR_MODEL || DEFAULT_SOLAR_MODEL
    ).trim() || DEFAULT_SOLAR_MODEL,
    solarMaxTokens: Number.isFinite(maxTokens) && maxTokens >= 256
      ? Math.min(32_768, Math.floor(maxTokens))
      : DEFAULT_SOLAR_MAX_TOKENS,
    maxAudioBytes: Number.isFinite(maxAudioBytes) && maxAudioBytes > 0
      ? Math.floor(maxAudioBytes)
      : DEFAULT_MAX_AUDIO_BYTES,
    pipelineTimeoutMs: Number.isFinite(pipelineTimeoutMs) && pipelineTimeoutMs >= 1_000
      ? Math.min(MAX_PIPELINE_TIMEOUT_MS, Math.floor(pipelineTimeoutMs))
      : DEFAULT_PIPELINE_TIMEOUT_MS
  };
}

export function resolveCaptionPipelineRequestConfig(
  baseConfig = {},
  overrides = {}
) {
  const requestOptions = {
    required: true,
    httpStatus: 400
  };
  const optionalRequestOptions = {
    required: false,
    httpStatus: 400
  };
  const overrideSttEndpoint = String(
    overrides.sttEndpoint || ""
  ).trim();
  const baseSttEndpoint = externalEndpoint(
    baseConfig.sttEndpoint,
    "STT API 주소",
    optionalRequestOptions
  );
  const sttEndpoint = externalEndpoint(
    overrideSttEndpoint || baseSttEndpoint,
    "STT API 주소",
    {
      ...requestOptions,
      allowQuery: !overrideSttEndpoint
    }
  );
  const overrideSttApiKey = providerApiKey(
    overrides.sttApiKey,
    "STT API 키",
    optionalRequestOptions
  );
  if (
    overrideSttEndpoint
    && sttEndpoint !== baseSttEndpoint
    && !overrideSttApiKey
  ) {
    throw new CaptionGatewayError(
      "STT API 주소를 바꾸려면 같은 요청의 STT API 키도 함께 입력해야 합니다.",
      {
        code: "STT_PROVIDER_PAIR_REQUIRED",
        httpStatus: 400
      }
    );
  }
  return {
    ...baseConfig,
    sttEndpoint,
    sttApiKey: providerApiKey(
      overrideSttApiKey || baseConfig.sttApiKey,
      "STT API 키",
      requestOptions
    ),
    sttModel: sttModelName(
      overrides.sttModel || baseConfig.sttModel,
      { httpStatus: 400 }
    ),
    upstageApiKey: providerApiKey(
      overrides.upstageApiKey || baseConfig.upstageApiKey,
      "Upstage API 키",
      requestOptions
    )
  };
}

function normalizeTranscriptText(value) {
  return String(value ?? "").replace(/\s+/gu, " ").trim();
}

function transcriptRange(candidate, clipDurationMs) {
  const directStartMs = Number(candidate?.startMs ?? candidate?.start_ms);
  const directEndMs = Number(candidate?.endMs ?? candidate?.end_ms);
  if (Number.isFinite(directStartMs) && Number.isFinite(directEndMs)) {
    const startMs = Math.max(
      0,
      Math.min(clipDurationMs, Math.round(directStartMs))
    );
    const endMs = Math.max(
      0,
      Math.min(clipDurationMs, Math.round(directEndMs))
    );
    return endMs > startMs ? { startMs, endMs } : null;
  }
  const timestamp = Array.isArray(candidate?.timestamp)
    ? candidate.timestamp
    : null;
  const startSeconds = Number(
    candidate?.start
    ?? candidate?.start_time
    ?? timestamp?.[0]
  );
  const endSeconds = Number(
    candidate?.end
    ?? candidate?.end_time
    ?? timestamp?.[1]
  );
  if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds)) {
    return null;
  }
  const startMs = Math.max(
    0,
    Math.min(clipDurationMs, Math.round(startSeconds * 1_000))
  );
  const endMs = Math.max(
    0,
    Math.min(clipDurationMs, Math.round(endSeconds * 1_000))
  );
  return endMs > startMs ? { startMs, endMs } : null;
}

function normalizeTranscriptUnit(candidate, clipDurationMs, textFields) {
  const range = transcriptRange(candidate, clipDurationMs);
  const text = normalizeTranscriptText(
    textFields.map((field) => candidate?.[field]).find(
      (value) => value != null && value !== ""
    )
  );
  if (!range || !text) {
    return null;
  }
  const speaker = normalizeTranscriptText(
    candidate?.speaker
    ?? candidate?.speaker_label
    ?? candidate?.speakerLabel
  );
  return {
    ...range,
    text,
    ...(speaker ? { speaker } : {})
  };
}

function deduplicateTranscriptUnits(units) {
  return units
    .sort((first, second) => (
      first.startMs - second.startMs
      || first.endMs - second.endMs
      || first.text.localeCompare(second.text)
    ))
    .filter((unit, index, all) => {
      const previous = all[index - 1];
      return !previous || !(
        previous.startMs === unit.startMs
        && previous.endMs === unit.endMs
        && previous.text === unit.text
        && previous.speaker === unit.speaker
      );
    });
}

export function normalizeSttTranscript(payload, { clipDurationMs } = {}) {
  const duration = Number(clipDurationMs);
  if (!Number.isInteger(duration) || duration < 1) {
    throw new CaptionGatewayError("STT 정규화용 클립 길이가 올바르지 않습니다.", {
      code: "INVALID_CLIP_DURATION",
      httpStatus: 400
    });
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new CaptionGatewayError("외부 STT가 JSON 객체를 반환하지 않았습니다.", {
      code: "INVALID_STT_RESPONSE"
    });
  }

  const rawSegments = Array.isArray(payload.segments)
    ? payload.segments
    : Array.isArray(payload.chunks)
      ? payload.chunks
      : [];
  if (rawSegments.length > MAX_STT_SEGMENTS) {
    throw new CaptionGatewayError("외부 STT의 segment 개수가 허용 상한을 넘었습니다.", {
      code: "STT_RESPONSE_TOO_LARGE"
    });
  }
  const segments = deduplicateTranscriptUnits(
    rawSegments
      .map((segment) => normalizeTranscriptUnit(
        segment,
        duration,
        ["text", "word"]
      ))
      .filter(Boolean)
  );

  let rawWords;
  if (Array.isArray(payload.words)) {
    if (payload.words.length > MAX_STT_WORDS) {
      throw new CaptionGatewayError("외부 STT의 word 개수가 허용 상한을 넘었습니다.", {
        code: "STT_RESPONSE_TOO_LARGE"
      });
    }
    rawWords = payload.words;
  } else {
    rawWords = [];
    for (const segment of rawSegments) {
      const words = Array.isArray(segment?.words) ? segment.words : [];
      if (rawWords.length + words.length > MAX_STT_WORDS) {
        throw new CaptionGatewayError("외부 STT의 word 개수가 허용 상한을 넘었습니다.", {
          code: "STT_RESPONSE_TOO_LARGE"
        });
      }
      for (const word of words) {
        rawWords.push(word);
      }
    }
  }
  const words = deduplicateTranscriptUnits(
    rawWords
      .map((word) => normalizeTranscriptUnit(
        word,
        duration,
        ["word", "text"]
      ))
      .filter(Boolean)
  );

  const text = normalizeTranscriptText(payload.text);
  if (segments.length === 0 && words.length === 0 && text) {
    segments.push({
      startMs: 0,
      endMs: duration,
      text
    });
  }
  const transcript = { text, segments, words };
  if (Buffer.byteLength(JSON.stringify(transcript)) > MAX_SOLAR_PROMPT_BYTES) {
    throw new CaptionGatewayError("외부 STT 전사문이 Solar 입력 상한을 넘었습니다.", {
      code: "STT_TRANSCRIPT_TOO_LARGE"
    });
  }
  return transcript;
}

function decodeWavBase64(value, maxAudioBytes) {
  let bytes;
  try {
    bytes = Buffer.from(value, "base64");
  } catch {
    throw new CaptionProtocolError("WAV base64를 해석하지 못했습니다.", {
      code: "INVALID_WAV"
    });
  }
  if (bytes.length < 12 || bytes.length > maxAudioBytes) {
    throw new CaptionProtocolError("WAV 파일 크기가 허용 범위를 벗어났습니다.", {
      code: bytes.length > maxAudioBytes ? "WAV_TOO_LARGE" : "INVALID_WAV"
    });
  }
  const container = bytes.toString("ascii", 0, 4);
  const wave = bytes.toString("ascii", 8, 12);
  if ((container !== "RIFF" && container !== "RF64") || wave !== "WAVE") {
    throw new CaptionProtocolError("wavBase64가 RIFF/RF64 WAVE 파일이 아닙니다.", {
      code: "INVALID_WAV"
    });
  }
  return bytes;
}

async function responseTextLimited(
  response,
  {
    maxBytes = MAX_PROVIDER_RESPONSE_BYTES,
    serviceName = "외부 제공자"
  } = {}
) {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new CaptionGatewayError(`${serviceName} 응답 본문이 너무 큽니다.`, {
      code: "PROVIDER_RESPONSE_TOO_LARGE",
      httpStatus: 502
    });
  }
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) {
      throw new CaptionGatewayError(`${serviceName} 응답 본문이 너무 큽니다.`, {
        code: "PROVIDER_RESPONSE_TOO_LARGE",
        httpStatus: 502
      });
    }
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new CaptionGatewayError(`${serviceName} 응답 본문이 너무 큽니다.`, {
          code: "PROVIDER_RESPONSE_TOO_LARGE",
          httpStatus: 502
        });
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, totalBytes).toString("utf8");
}

async function responsePayload(response, options) {
  const text = await responseTextLimited(response, options);
  if (!text) {
    return { text: "", json: null };
  }
  try {
    return { text, json: JSON.parse(text) };
  } catch {
    return { text, json: null };
  }
}

function unsupportedResponseFormat(status, responseText) {
  if (status !== 400 && status !== 422) {
    return false;
  }
  const lower = String(responseText || "").toLowerCase();
  const namesFormat = (
    lower.includes("response_format")
    || lower.includes("response format")
    || lower.includes("json_schema")
    || lower.includes("json schema")
    || lower.includes("json_object")
    || lower.includes("json object")
  );
  const saysUnsupported = (
    lower.includes("unsupported")
    || lower.includes("not support")
    || lower.includes("unknown")
    || lower.includes("invalid")
    || lower.includes("not permitted")
    || lower.includes("extra input")
  );
  return namesFormat && saysUnsupported;
}

async function externalFetch(fetchImpl, url, init, serviceName) {
  let response;
  try {
    response = await fetchImpl(url, init);
  } catch (error) {
    if (init.signal?.aborted) {
      throw init.signal.reason || error;
    }
    throw new CaptionGatewayError(`${serviceName} 통신에 실패했습니다.`, {
      code: `${serviceName.toUpperCase()}_NETWORK_ERROR`
    });
  }
  return response;
}

function requestSignal(signal, timeoutMs) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return signal
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal;
}

export async function requestExternalStt(request, {
  fetchImpl = globalThis.fetch,
  sttEndpoint,
  sttApiKey,
  sttModel = DEFAULT_STT_MODEL,
  maxAudioBytes = DEFAULT_MAX_AUDIO_BYTES,
  signal
}) {
  if (typeof fetchImpl !== "function") {
    throw new CaptionGatewayError("fetch 구현이 없습니다.", {
      code: "INVALID_CONFIGURATION",
      httpStatus: 500
    });
  }
  const wavBytes = decodeWavBase64(request.wavBase64, maxAudioBytes);
  const form = new FormData();
  form.append("file", new Blob([wavBytes], { type: "audio/wav" }), "clip.wav");
  form.append("model", sttModel);
  form.append("language", "ko");
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "segment");
  form.append("timestamp_granularities[]", "word");

  const response = await externalFetch(fetchImpl, sttEndpoint, {
    method: "POST",
    redirect: "error",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${sttApiKey}`
    },
    body: form,
    signal: requestSignal(signal, 10 * 60 * 1_000)
  }, "stt");
  const payload = await responsePayload(response, { serviceName: "외부 STT" });
  if (!response.ok || !payload.json) {
    throw new CaptionGatewayError("외부 STT 요청이 실패했습니다.", {
      code: "STT_REQUEST_FAILED",
      httpStatus: 502
    });
  }
  return normalizeSttTranscript(payload.json, {
    clipDurationMs: request.clipDurationMs
  });
}

export function buildSolarCaptionUserPrompt(request, transcript) {
  const prompt = JSON.stringify({
    instruction: "STT 근거를 키리누키 자막 cue JSON으로 다듬어 주세요.",
    clipDurationMs: request.clipDurationMs,
    context: {
      projectName: request.projectName,
      streamerName: request.streamerName,
      clipNote: request.clipNote
    },
    visualPlacement: request.visualPlacement,
    transcript
  });
  if (Buffer.byteLength(prompt) > MAX_SOLAR_PROMPT_BYTES) {
    throw new CaptionGatewayError("Solar 자막 프롬프트가 허용 상한을 넘었습니다.", {
      code: "SOLAR_PROMPT_TOO_LARGE"
    });
  }
  return prompt;
}

function responseFormatForAttempt(attempt) {
  if (attempt === "json_schema") {
    return {
      type: "json_schema",
      json_schema: UPSTAGE_CAPTION_JSON_SCHEMA
    };
  }
  if (attempt === "json_object") {
    return { type: "json_object" };
  }
  return null;
}

function messageContent(payload) {
  const message = payload?.choices?.[0]?.message;
  if (message?.parsed && typeof message.parsed === "object") {
    return message.parsed;
  }
  if (message?.content && typeof message.content === "object" && !Array.isArray(message.content)) {
    return message.content;
  }
  if (Array.isArray(message?.content)) {
    return message.content
      .map((part) => typeof part === "string" ? part : part?.text || "")
      .join("");
  }
  return message?.content;
}

function parseJsonObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value;
  }
  const text = String(value || "")
    .trim()
    .replace(/^```(?:json)?\s*/iu, "")
    .replace(/\s*```$/u, "")
    .trim();
  try {
    return JSON.parse(text);
  } catch {
    const firstBrace = text.indexOf("{");
    const lastBrace = text.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      try {
        return JSON.parse(text.slice(firstBrace, lastBrace + 1));
      } catch {
        // A safe protocol error is raised below without retaining model content.
      }
    }
  }
  throw new CaptionGatewayError("Solar가 올바른 JSON 자막을 반환하지 않았습니다.", {
    code: "INVALID_SOLAR_RESPONSE"
  });
}

function transcriptHasRecognizableContent(transcript) {
  return Boolean(
    normalizeTranscriptText(transcript?.text)
    || transcript?.segments?.some((segment) => normalizeTranscriptText(segment?.text))
    || transcript?.words?.some((word) => normalizeTranscriptText(word?.text))
  );
}

export async function requestSolarCaptions(request, transcript, {
  fetchImpl = globalThis.fetch,
  upstageApiKey,
  solarModel = DEFAULT_SOLAR_MODEL,
  solarMaxTokens = DEFAULT_SOLAR_MAX_TOKENS,
  signal
}) {
  const messages = [
    { role: "system", content: KOREAN_VTUBER_SOLAR_SYSTEM_PROMPT },
    { role: "user", content: buildSolarCaptionUserPrompt(request, transcript) }
  ];
  const attempts = ["json_schema", "json_object", "plain"];

  for (const [attemptIndex, attempt] of attempts.entries()) {
    const responseFormat = responseFormatForAttempt(attempt);
    const body = {
      model: solarModel,
      temperature: 0.1,
      max_tokens: solarMaxTokens,
      messages,
      ...(responseFormat ? { response_format: responseFormat } : {})
    };
    const response = await externalFetch(fetchImpl, UPSTAGE_CHAT_COMPLETIONS_URL, {
      method: "POST",
      redirect: "error",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${upstageApiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(body),
      signal: requestSignal(signal, 5 * 60 * 1_000)
    }, "solar");
    const payload = await responsePayload(response, { serviceName: "Upstage Solar" });
    if (!response.ok) {
      if (
        attemptIndex < attempts.length - 1
        && unsupportedResponseFormat(response.status, payload.text)
      ) {
        continue;
      }
      throw new CaptionGatewayError("Upstage Solar 요청이 실패했습니다.", {
        code: "SOLAR_REQUEST_FAILED",
        httpStatus: 502
      });
    }
    if (!payload.json) {
      throw new CaptionGatewayError("Upstage Solar 응답이 JSON이 아닙니다.", {
        code: "INVALID_SOLAR_RESPONSE"
      });
    }
    try {
      const parsed = parseJsonObject(messageContent(payload.json));
      const rawCues = parsed.cues ?? parsed.captions ?? parsed.subtitles;
      const normalized = normalizeCaptionCuesDetailed(rawCues, {
        clipDurationMs: request.clipDurationMs
      });
      if (
        transcriptHasRecognizableContent(transcript)
        && normalized.cues.length === 0
      ) {
        throw new CaptionGatewayError(
          "Solar가 인식된 발화에 대한 자막 cue를 반환하지 않았습니다.",
          { code: "EMPTY_SOLAR_CAPTIONS" }
        );
      }
      return {
        ...normalized,
        resolvedModel: String(payload.json.model || solarModel)
      };
    } catch (error) {
      if (
        attemptIndex < attempts.length - 1
        && (
          error instanceof CaptionProtocolError
          || error?.code === "INVALID_SOLAR_RESPONSE"
          || error?.code === "EMPTY_SOLAR_CAPTIONS"
        )
      ) {
        continue;
      }
      throw error;
    }
  }

  throw new CaptionGatewayError("사용 가능한 Solar JSON 응답 형식이 없습니다.", {
    code: "SOLAR_RESPONSE_FORMAT_UNSUPPORTED"
  });
}

export async function runCaptionPipeline(rawRequest, {
  fetchImpl = globalThis.fetch,
  signal,
  pipelineTimeoutMs = DEFAULT_PIPELINE_TIMEOUT_MS,
  ...config
} = {}) {
  const configuredTimeoutMs = Number(pipelineTimeoutMs);
  const deadlineMs = (
    Number.isFinite(configuredTimeoutMs)
    && configuredTimeoutMs >= 1
  )
    ? Math.min(MAX_PIPELINE_TIMEOUT_MS, Math.floor(configuredTimeoutMs))
    : DEFAULT_PIPELINE_TIMEOUT_MS;
  const pipelineSignal = requestSignal(signal, deadlineMs);

  try {
    const validatedRequest = validateCaptionAgentRequest(rawRequest);
    const request = validatedRequest;
    const captionModel = request.model || config.solarModel || DEFAULT_SOLAR_MODEL;
    const transcript = await requestExternalStt(request, {
      fetchImpl,
      ...config,
      signal: pipelineSignal
    });
    if (!transcriptHasRecognizableContent(transcript)) {
      return createCaptionAgentResponse({
        request,
        sttModel: config.sttModel || DEFAULT_STT_MODEL,
        captionModel,
        resolvedModel: captionModel,
        cues: [],
        warnings: [{
          code: "NO_RECOGNIZABLE_SPEECH",
          cueIndex: 0
        }]
      });
    }
    const result = await requestSolarCaptions(request, transcript, {
      fetchImpl,
      ...config,
      solarModel: captionModel,
      signal: pipelineSignal
    });
    return createCaptionAgentResponse({
      request,
      sttModel: config.sttModel || DEFAULT_STT_MODEL,
      captionModel,
      resolvedModel: result.resolvedModel,
      cues: result.cues,
      warnings: result.warnings
    });
  } catch (error) {
    if (
      !signal?.aborted
      && pipelineSignal.aborted
      && pipelineSignal.reason?.name === "TimeoutError"
    ) {
      throw new CaptionGatewayError(
        "자막 파이프라인의 전체 제한 시간을 초과했습니다.",
        {
          code: "PIPELINE_TIMEOUT",
          httpStatus: 504
        }
      );
    }
    throw error;
  }
}
