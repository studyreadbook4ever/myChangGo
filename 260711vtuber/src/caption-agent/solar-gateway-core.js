import {
  KOREAN_VTUBER_SOLAR_SYSTEM_PROMPT,
  LOCAL_WHISPER_CAPTION_MODEL,
  MAX_CAPTION_WARNINGS,
  SUPPORTED_CAPTION_MODELS,
  SUPPORTED_SOLAR_CAPTION_MODELS,
  UPSTAGE_CAPTION_JSON_SCHEMA,
  CaptionProtocolError,
  createCaptionAgentResponse,
  normalizeCaptionCuesDetailed,
  validateCaptionAgentRequest
} from "./protocol.js";
import {
  CAPTION_HARNESS_FINGERPRINT,
  CAPTION_QUALITY_PROFILE_ID,
  canonicalTimedTranscript,
  evaluateCaptionDraft,
  repairCaptionDraft
} from "./caption-quality-harness.js";
import {
  captionEditorialContextFingerprint
} from "./editorial-context.js";

export const UPSTAGE_CHAT_COMPLETIONS_URL =
  "https://api.upstage.ai/v1/chat/completions";
export const DEFAULT_CAPTION_MODEL = LOCAL_WHISPER_CAPTION_MODEL;
export const DEFAULT_SOLAR_MODEL = "solar-pro3";
export const DEFAULT_TRANSCRIPTION_MODE = "external-timed-stt";
export const LOCAL_WHISPERCPP_TRANSCRIPTION_MODE = "local-whispercpp";
export const DEFAULT_STT_MODEL = "whisper-1";
export const DEFAULT_MAX_AUDIO_BYTES = 64 * 1024 * 1024;
export const DEFAULT_SOLAR_MAX_TOKENS = 16_384;
export const SOLAR_PRO3_HIGH_REASONING_MIN_TOKENS = 16_384;
export const MAX_SOLAR_CALLS_PER_CLIP = 1;
export const DEFAULT_PIPELINE_TIMEOUT_MS = 45 * 60 * 1_000;
export const MAX_PIPELINE_TIMEOUT_MS = 60 * 60 * 1_000;
export const DEFAULT_STT_TIMEOUT_MS = DEFAULT_PIPELINE_TIMEOUT_MS;
export const MAX_PROVIDER_RESPONSE_BYTES = 16 * 1024 * 1024;
export const MAX_STT_SEGMENTS = 10_000;
export const MAX_STT_WORDS = 50_000;
export const MAX_SOLAR_PROMPT_BYTES = 2 * 1024 * 1024;
export const MAX_PROVIDER_API_KEY_LENGTH = 4_096;
export const MAX_STT_ENDPOINT_LENGTH = 2_048;
export const MAX_STT_MODEL_LENGTH = 160;

function boundedCaptionWarnings(...groups) {
  const warnings = [];
  const seen = new Set();
  let truncated = false;
  for (const warning of groups.flat()) {
    const code = String(warning?.code || "").trim().slice(0, 128);
    const cueIndex = Number(warning?.cueIndex);
    if (!code || !Number.isInteger(cueIndex) || cueIndex < 0) {
      continue;
    }
    const key = `${code}\u0000${cueIndex}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    if (warnings.length >= MAX_CAPTION_WARNINGS - 1) {
      truncated = true;
      break;
    }
    warnings.push({ code, cueIndex });
  }
  if (truncated) {
    warnings.push({ code: "TRIMMED_WARNING_COUNT", cueIndex: 0 });
  }
  return warnings;
}

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

function isLoopbackEndpoint(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "http:" && isLoopbackHostname(url.hostname);
  } catch {
    return false;
  }
}

function normalizeTranscriptionMode(value, { httpStatus = 500 } = {}) {
  const normalized = String(
    value || DEFAULT_TRANSCRIPTION_MODE
  ).trim() || DEFAULT_TRANSCRIPTION_MODE;
  if (![
    DEFAULT_TRANSCRIPTION_MODE,
    LOCAL_WHISPERCPP_TRANSCRIPTION_MODE
  ].includes(normalized)) {
    throw new CaptionGatewayError(
      "STT 모드는 external-timed-stt 또는 local-whispercpp여야 합니다.",
      {
        code: "UNSUPPORTED_TRANSCRIPTION_MODE",
        httpStatus
      }
    );
  }
  return normalized;
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

export function normalizeSolarCaptionModel(value, {
  fallback = DEFAULT_SOLAR_MODEL,
  httpStatus = 500
} = {}) {
  const normalized = String(value || fallback).trim() || fallback;
  if (!SUPPORTED_SOLAR_CAPTION_MODELS.includes(normalized)) {
    throw new CaptionGatewayError(
      `Solar 자막 모델은 ${SUPPORTED_SOLAR_CAPTION_MODELS.join(" 또는 ")}만 지원합니다.`,
      {
        code: "UNSUPPORTED_SOLAR_MODEL",
        httpStatus
      }
    );
  }
  return normalized;
}

export function normalizeCaptionModel(value, {
  fallback = DEFAULT_CAPTION_MODEL,
  httpStatus = 500
} = {}) {
  const normalized = String(value || fallback).trim() || fallback;
  if (!SUPPORTED_CAPTION_MODELS.includes(normalized)) {
    throw new CaptionGatewayError(
      `자막 초벌 모델은 ${SUPPORTED_CAPTION_MODELS.join(" 또는 ")}만 지원합니다.`,
      {
        code: "UNSUPPORTED_CAPTION_MODEL",
        httpStatus
      }
    );
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
  const transcriptionMode = normalizeTranscriptionMode(
    env.KIRINUKI_STT_MODE
  );
  const sttKeyOptions = {
    required: (
      transcriptionMode !== LOCAL_WHISPERCPP_TRANSCRIPTION_MODE
      && !allowMissingProviderConfig
    ),
    httpStatus: 500
  };
  return {
    transcriptionMode,
    sttEndpoint: externalEndpoint(
      env.KIRINUKI_STT_ENDPOINT,
      "KIRINUKI_STT_ENDPOINT",
      providerOptions
    ),
    sttApiKey: providerApiKey(
      env.KIRINUKI_STT_API_KEY,
      "KIRINUKI_STT_API_KEY",
      sttKeyOptions
    ),
    sttModel: sttModelName(env.KIRINUKI_STT_MODEL),
    upstageApiKey: providerApiKey(
      env.UPSTAGE_API_KEY,
      "UPSTAGE_API_KEY",
      {
        required: false,
        httpStatus: 500
      }
    ),
    solarModel: normalizeSolarCaptionModel(
      env.KIRINUKI_SOLAR_MODEL || DEFAULT_SOLAR_MODEL
    ),
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
      ...optionalRequestOptions,
      allowQuery: !overrideSttEndpoint
    }
  );
  const overrideSttApiKey = providerApiKey(
    overrides.sttApiKey,
    "STT API 키",
    optionalRequestOptions
  );
  const requestedTranscriptionMode = normalizeTranscriptionMode(
    baseConfig.transcriptionMode,
    { httpStatus: 400 }
  );
  const localWhisperMode = (
    requestedTranscriptionMode === LOCAL_WHISPERCPP_TRANSCRIPTION_MODE
    && isLoopbackEndpoint(sttEndpoint)
  );
  if (
    overrideSttEndpoint
    && sttEndpoint !== baseSttEndpoint
    && !overrideSttApiKey
    && !localWhisperMode
  ) {
    throw new CaptionGatewayError(
      "STT API 주소를 바꾸려면 같은 요청의 STT API 키도 함께 입력해야 합니다.",
      {
        code: "STT_PROVIDER_PAIR_REQUIRED",
        httpStatus: 400
      }
    );
  }
  const sttApiKey = providerApiKey(
    overrideSttApiKey || baseConfig.sttApiKey,
    "STT API 키",
    optionalRequestOptions
  );
  if (!sttEndpoint || (!localWhisperMode && !sttApiKey)) {
    throw new CaptionGatewayError(
      "Solar Chat은 음성을 직접 전사하지 않습니다. 로컬 Whisper 또는 시간 정보가 있는 외부 STT API 주소와 키가 필요합니다.",
      {
        code: "TIMED_STT_REQUIRED",
        httpStatus: 400
      }
    );
  }
  return {
    ...baseConfig,
    transcriptionMode: localWhisperMode
      ? LOCAL_WHISPERCPP_TRANSCRIPTION_MODE
      : DEFAULT_TRANSCRIPTION_MODE,
    sttEndpoint,
    sttApiKey,
    sttModel: sttModelName(
      overrides.sttModel || baseConfig.sttModel,
      { httpStatus: 400 }
    ),
    upstageApiKey: providerApiKey(
      overrides.upstageApiKey || baseConfig.upstageApiKey,
      "Upstage API 키",
      optionalRequestOptions
    ),
    solarModel: normalizeSolarCaptionModel(baseConfig.solarModel, {
      httpStatus: 400
    })
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
    throw new CaptionGatewayError(
      "외부 STT가 발화 텍스트만 반환하고 시간 정보를 반환하지 않았습니다.",
      {
        code: "TIMED_TRANSCRIPT_REQUIRED",
        httpStatus: 502
      }
    );
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
  return validateWavBytes(bytes, maxAudioBytes);
}

function validateWavBytes(bytes, maxAudioBytes) {
  if (!Buffer.isBuffer(bytes)) {
    throw new CaptionProtocolError("WAV 바이트가 Buffer가 아닙니다.", {
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
  wavBytes,
  signal,
  timeoutMs = DEFAULT_STT_TIMEOUT_MS
}) {
  if (typeof fetchImpl !== "function") {
    throw new CaptionGatewayError("fetch 구현이 없습니다.", {
      code: "INVALID_CONFIGURATION",
      httpStatus: 500
    });
  }
  const audioBytes = wavBytes === undefined
    ? decodeWavBase64(request.wavBase64, maxAudioBytes)
    : validateWavBytes(wavBytes, maxAudioBytes);
  const form = new FormData();
  form.append("file", new Blob([audioBytes], { type: "audio/wav" }), "clip.wav");
  form.append("model", sttModel);
  form.append("language", "ko");
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "segment");
  form.append("timestamp_granularities[]", "word");

  const requestedTimeoutMs = Number(timeoutMs);
  const sttTimeoutMs = (
    Number.isFinite(requestedTimeoutMs)
    && requestedTimeoutMs >= 1
  )
    ? Math.min(MAX_PIPELINE_TIMEOUT_MS, Math.floor(requestedTimeoutMs))
    : DEFAULT_STT_TIMEOUT_MS;
  const sttSignal = requestSignal(signal, sttTimeoutMs);
  let response;
  try {
    response = await externalFetch(fetchImpl, sttEndpoint, {
      method: "POST",
      redirect: "error",
      headers: {
        accept: "application/json",
        ...(sttApiKey
          ? { authorization: `Bearer ${sttApiKey}` }
          : {})
      },
      body: form,
      signal: sttSignal
    }, "stt");
  } catch (error) {
    if (
      !signal?.aborted
      && sttSignal.aborted
      && sttSignal.reason?.name === "TimeoutError"
    ) {
      throw new CaptionGatewayError(
        "음성 전사 제한 시간을 초과했습니다.",
        {
          code: "STT_TIMEOUT",
          httpStatus: 504
        }
      );
    }
    throw error;
  }
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
  const canonical = Array.isArray(transcript?.units)
    ? transcript
    : canonicalTimedTranscript(transcript, {
      clipDurationMs: request.clipDurationMs,
      editorialContext: request.editorialContext
    });
  const timedUnits = canonical.units.map((unit) => ({
    startMs: unit.startMs,
    endMs: unit.endMs,
    text: unit.text,
    speakerId: unit.speakerId,
    ...(Array.isArray(unit.wordAnchors) && unit.wordAnchors.length > 0
      ? { wordAnchors: unit.wordAnchors }
      : {})
  }));
  const prompt = JSON.stringify({
    instruction: [
      "timedUnits만 근거로 발화의 맞춤법·말맛·화자를 정리해",
      "한국 VTuber 키리누키용 cue JSON을 만드세요.",
      "본문은 하단 고정 한 줄이며 한 cue가 한글 폭 약 20자를 넘지 않게",
      "의미·호흡·질문·반응 경계에서 다음 시간 cue로 나누세요.",
      "시각 스타일은 로컬 품질 하네스가 결정하므로 꾸밈 지시를 만들지 마세요."
    ].join(" "),
    qualityProfile: CAPTION_QUALITY_PROFILE_ID,
    harnessFingerprint: CAPTION_HARNESS_FINGERPRINT,
    clipDurationMs: request.clipDurationMs,
    context: {
      projectName: request.projectName,
      streamerName: request.streamerName,
      clipNote: request.clipNote
    },
    editorialContext: request.editorialContext,
    editorialContextFingerprint: captionEditorialContextFingerprint(
      request.editorialContext
    ),
    visualPlacement: request.visualPlacement,
    timedUnits
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

function orderedResponseFormatAttempts(cache, model) {
  const supported = ["json_schema", "json_object", "plain"];
  const cached = cache?.get?.(model);
  if (!supported.includes(cached)) {
    return supported;
  }
  return [
    cached,
    ...supported.filter((attempt) => attempt !== cached)
  ];
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

export function buildLocalWhisperCaptionDraft(request, transcript) {
  const canonicalTranscript = canonicalTimedTranscript(transcript, {
    clipDurationMs: request.clipDurationMs,
    editorialContext: request.editorialContext
  });
  const rawCues = canonicalTranscript.units.map((unit) => ({
    startMs: unit.startMs,
    endMs: unit.endMs,
    text: unit.text,
    speakerId: !unit.speakerId || unit.speakerId === "unknown"
      ? "main"
      : unit.speakerId,
    reviewRequired: false,
    placement: "bottom"
  }));
  // Let the local harness see each original STT range and its word anchors
  // before enforcing the four-second protocol limit. Pre-normalizing here
  // would split long segments at evenly distributed times and lose the best
  // available speech boundary for the draft.
  const repaired = repairCaptionDraft(rawCues, {
    clipDurationMs: request.clipDurationMs,
    transcript: canonicalTranscript,
    visualPlacement: request.visualPlacement,
    editorialContext: request.editorialContext,
    timingPolicy: "stt-boundaries"
  });
  // repairCaptionDraft already emits protocol-shaped cues. Running the generic
  // normalizer here would silently expand sub-100 ms STT ranges and could
  // reintroduce an overlap after the boundary-preserving harness pass.
  const finalizedCues = repaired.cues;
  const qualityReport = repaired.report;
  if (qualityReport.disposition === "rejected") {
    throw new CaptionGatewayError(
      "로컬 품질 하네스가 원래 STT 경계를 움직이지 않고 구조 충돌 cue를 격리했습니다. 자막은 적용하지 않았습니다.",
      {
        code: "CAPTION_QUALITY_GATE_FAILED",
        httpStatus: 422
      }
    );
  }
  const reviewsByCue = new Map(
    qualityReport.cueReviews.map((review) => [review.cueIndex, review])
  );
  const cues = finalizedCues.map((cue, cueIndex) => {
    const review = reviewsByCue.get(cueIndex);
    const status = review?.status === "review-required"
      ? "review-required"
      : "accepted";
    return {
      ...cue,
      reviewRequired: cue.reviewRequired || status === "review-required",
      quality: {
        status,
        codes: (review?.codes || []).slice(0, 32)
      }
    };
  });
  return {
    cues,
    warnings: boundedCaptionWarnings(
      canonicalTranscript.warnings,
      repaired.warnings,
      qualityReport.violations.map(({ code, cueIndex }) => ({
        code,
        cueIndex
      }))
    ),
    qualityProfile: repaired.profileId,
    harnessFingerprint: repaired.harnessFingerprint,
    qualityReport
  };
}

export async function requestSolarCaptions(request, transcript, {
  fetchImpl = globalThis.fetch,
  upstageApiKey,
  solarModel = DEFAULT_SOLAR_MODEL,
  solarMaxTokens = DEFAULT_SOLAR_MAX_TOKENS,
  responseFormatCache,
  signal
}) {
  const selectedModel = normalizeSolarCaptionModel(solarModel, {
    httpStatus: 400
  });
  const canonicalTranscript = canonicalTimedTranscript(transcript, {
    clipDurationMs: request.clipDurationMs,
    editorialContext: request.editorialContext
  });
  const apiKey = providerApiKey(
    upstageApiKey,
    "Upstage API 키",
    { required: true, httpStatus: 400 }
  );
  const messages = [
    { role: "system", content: KOREAN_VTUBER_SOLAR_SYSTEM_PROMPT },
    {
      role: "user",
      content: buildSolarCaptionUserPrompt(request, canonicalTranscript)
    }
  ];
  const attempts = orderedResponseFormatAttempts(
    responseFormatCache,
    selectedModel
  ).slice(0, MAX_SOLAR_CALLS_PER_CLIP);
  const effectiveMaxTokens = selectedModel === "solar-pro3"
    ? Math.max(SOLAR_PRO3_HIGH_REASONING_MIN_TOKENS, solarMaxTokens)
    : solarMaxTokens;

  for (const [attemptIndex, attempt] of attempts.entries()) {
    const responseFormat = responseFormatForAttempt(attempt);
    const body = {
      model: selectedModel,
      temperature: 0.1,
      max_tokens: effectiveMaxTokens,
      messages,
      ...(selectedModel === "solar-pro3"
        ? { reasoning_effort: "high" }
        : {}),
      ...(responseFormat ? { response_format: responseFormat } : {})
    };
    const response = await externalFetch(fetchImpl, UPSTAGE_CHAT_COMPLETIONS_URL, {
      method: "POST",
      redirect: "error",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${apiKey}`,
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
      if (unsupportedResponseFormat(response.status, payload.text)) {
        throw new CaptionGatewayError(
          "이 Solar 모델이 요청한 JSON 형식을 지원하지 않습니다. 유료 자동 재호출은 하지 않았습니다.",
          {
            code: "SOLAR_RESPONSE_FORMAT_UNSUPPORTED",
            httpStatus: 502
          }
        );
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
      const finishReason = String(
        payload.json?.choices?.[0]?.finish_reason || ""
      ).trim();
      if (finishReason && finishReason !== "stop") {
        throw new CaptionGatewayError(
          "Solar 응답이 완전히 생성되기 전에 중단되었습니다.",
          { code: "INCOMPLETE_SOLAR_RESPONSE" }
        );
      }
      const parsed = parseJsonObject(messageContent(payload.json));
      const rawCues = parsed.cues ?? parsed.captions ?? parsed.subtitles;
      const normalized = normalizeCaptionCuesDetailed(rawCues, {
        clipDurationMs: request.clipDurationMs
      });
      const repaired = repairCaptionDraft(normalized.cues, {
        clipDurationMs: request.clipDurationMs,
        transcript: canonicalTranscript,
        visualPlacement: request.visualPlacement,
        editorialContext: request.editorialContext
      });
      const finalized = normalizeCaptionCuesDetailed(repaired.cues, {
        clipDurationMs: request.clipDurationMs
      });
      const finalEvaluation = evaluateCaptionDraft(finalized.cues, {
        clipDurationMs: request.clipDurationMs,
        transcript: canonicalTranscript,
        visualPlacement: request.visualPlacement,
        editorialContext: request.editorialContext
      });
      const anchorCoverageLow = canonicalTranscript.warnings.some(
        ({ code }) => code === "HARNESS_WORD_ANCHOR_COVERAGE_LOW"
      );
      const qualityReport = anchorCoverageLow
        ? {
          ...finalEvaluation,
          valid: false,
          disposition: finalEvaluation.disposition === "rejected"
            ? "rejected"
            : "review-required",
          violations: [
            ...finalEvaluation.violations,
            ...finalEvaluation.cueReviews
              .filter((review) => !review.codes.includes(
                "HARNESS_WORD_ANCHOR_COVERAGE_LOW"
              ))
              .map((review) => ({
                code: "HARNESS_WORD_ANCHOR_COVERAGE_LOW",
                cueIndex: review.cueIndex,
                severity: "error"
              }))
          ],
          cueReviews: finalEvaluation.cueReviews.map((review) => ({
            ...review,
            status: review.status === "rejected"
              ? "rejected"
              : "review-required",
            codes: [...new Set([
              ...review.codes,
              "HARNESS_WORD_ANCHOR_COVERAGE_LOW"
            ])]
          }))
        }
        : finalEvaluation;
      if (qualityReport.disposition === "rejected") {
        throw new CaptionGatewayError(
          "로컬 품질 하네스가 구조 계약을 만족하지 못한 Solar 결과를 격리했습니다. 유료 자동 재호출은 하지 않았습니다.",
          {
            code: "CAPTION_QUALITY_GATE_FAILED",
            httpStatus: 422
          }
        );
      }
      if (
        transcriptHasRecognizableContent(transcript)
        && finalized.cues.length === 0
      ) {
        throw new CaptionGatewayError(
          "Solar가 인식된 발화에 대한 자막 cue를 반환하지 않았습니다.",
          { code: "EMPTY_SOLAR_CAPTIONS" }
        );
      }
      const reviewsByCue = new Map(
        qualityReport.cueReviews.map((review) => [
          review.cueIndex,
          review
        ])
      );
      const qualityCues = finalized.cues.map((cue, cueIndex) => {
        const review = reviewsByCue.get(cueIndex);
        const status = review?.status === "review-required"
          ? "review-required"
          : "accepted";
        return {
          ...cue,
          reviewRequired: cue.reviewRequired || status === "review-required",
          quality: {
            status,
            codes: (review?.codes || []).slice(0, 32)
          }
        };
      });
      responseFormatCache?.set?.(selectedModel, attempt);
      return {
        cues: qualityCues,
        warnings: boundedCaptionWarnings(
          canonicalTranscript.warnings,
          normalized.warnings,
          repaired.warnings,
          finalized.warnings,
          qualityReport.violations.map(({ code, cueIndex }) => ({
            code,
            cueIndex
          }))
        ),
        qualityProfile: repaired.profileId,
        harnessFingerprint: repaired.harnessFingerprint,
        qualityReport,
        editorialContextFingerprint: captionEditorialContextFingerprint(
          request.editorialContext
        ),
        resolvedModel: String(payload.json.model || selectedModel)
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
  transcribeAudio = requestExternalStt,
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
    const captionModel = normalizeCaptionModel(
      request.model || DEFAULT_CAPTION_MODEL,
      { httpStatus: 400 }
    );
    const localWhisperDraft = captionModel === LOCAL_WHISPER_CAPTION_MODEL;
    if (typeof transcribeAudio !== "function") {
      throw new CaptionGatewayError(
        "오디오를 시간 정보가 있는 전사문으로 바꿀 transcribeAudio 구현이 필요합니다.",
        {
          code: "TIMED_TRANSCRIBER_REQUIRED",
          httpStatus: 500
        }
      );
    }
    const wavBytes = decodeWavBase64(
      request.wavBase64,
      config.maxAudioBytes || DEFAULT_MAX_AUDIO_BYTES
    );
    const transcriptPayload = await transcribeAudio(request, {
      fetchImpl,
      sttEndpoint: config.sttEndpoint,
      sttApiKey: config.sttApiKey,
      sttModel: config.sttModel,
      maxAudioBytes: config.maxAudioBytes,
      wavBytes,
      signal: pipelineSignal,
      timeoutMs: deadlineMs
    });
    const transcript = normalizeSttTranscript(transcriptPayload, {
      clipDurationMs: request.clipDurationMs
    });
    if (!transcriptHasRecognizableContent(transcript)) {
      return createCaptionAgentResponse({
        request,
        sttModel: config.sttModel || DEFAULT_STT_MODEL,
        captionModel,
        resolvedModel: localWhisperDraft
          ? config.sttModel || DEFAULT_STT_MODEL
          : captionModel,
        provider: localWhisperDraft ? "local-whispercpp" : "upstage",
        cues: [],
        warnings: [{
          code: "NO_RECOGNIZABLE_SPEECH",
          cueIndex: 0
        }],
        qualityReport: {
          profileId: CAPTION_QUALITY_PROFILE_ID,
          harnessFingerprint: CAPTION_HARNESS_FINGERPRINT,
          valid: true,
          disposition: "review-required",
          violations: [{
            code: "NO_RECOGNIZABLE_SPEECH",
            cueIndex: 0,
            severity: "warning"
          }],
          cueReviews: [],
          metrics: {
            cueCount: 0,
            maximumDurationMs: 0,
            maximumLineWidthUnits: 0,
            maximumTotalWidthUnits: 0,
            maximumReadingRate: 0,
            transcriptCoverage: null,
            transcriptPrecision: null,
            wordAnchorCoverage: null,
            placement: "bottom"
          }
        }
      });
    }
    if (localWhisperDraft) {
      const result = buildLocalWhisperCaptionDraft(request, transcript);
      return createCaptionAgentResponse({
        request,
        sttModel: config.sttModel || DEFAULT_STT_MODEL,
        captionModel,
        resolvedModel: config.sttModel || DEFAULT_STT_MODEL,
        provider: "local-whispercpp",
        cues: result.cues,
        warnings: result.warnings,
        qualityProfile: result.qualityProfile,
        harnessFingerprint: result.harnessFingerprint,
        qualityReport: result.qualityReport
      });
    }
    const result = await requestSolarCaptions(request, transcript, {
      fetchImpl,
      ...config,
      solarModel: captionModel,
      responseFormatCache: config.solarResponseFormatCache,
      signal: pipelineSignal
    });
    return createCaptionAgentResponse({
      request,
      sttModel: config.sttModel || DEFAULT_STT_MODEL,
      captionModel,
      resolvedModel: result.resolvedModel,
      cues: result.cues,
      warnings: result.warnings,
      qualityProfile: result.qualityProfile,
      harnessFingerprint: result.harnessFingerprint,
      qualityReport: result.qualityReport
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
