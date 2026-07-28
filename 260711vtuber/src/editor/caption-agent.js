export const CAPTION_AGENT_SETTINGS_KEY = "chzzk-kirinuki-caption-agent-settings-v1";
export const CAPTION_AGENT_REQUEST_SCHEMA = "chzzk-kirinuki-caption-request/v1";
export const CAPTION_AGENT_RESPONSE_SCHEMA = "chzzk-kirinuki-caption-response/v1";
export const MAX_REMOTE_CUE_DURATION_MS = 4_000;
export const MAX_REMOTE_CUES = 4_000;
export const MAX_REMOTE_WARNINGS = 4_000;
export const MAX_CAPTION_AGENT_CLIPS_PER_RUN = 500;
export const MAX_CAPTION_AGENT_CUES_PER_RUN = 10_000;
export const MAX_CAPTION_AGENT_POLL_ATTEMPTS = 240;
export const CAPTION_AGENT_REQUEST_TIMEOUT_MS = 20 * 60 * 1_000;
export const CAPTION_AGENT_PROBE_TIMEOUT_MS = 10_000;
export const MAX_CAPTION_AGENT_RESPONSE_BYTES = 8 * 1024 * 1024;
export const MAX_CAPTION_AGENT_CLIP_DURATION_MS = 30 * 60 * 1_000;
export const MAX_CAPTION_AGENT_WAV_BYTES = 64 * 1024 * 1024;
export const CAPTION_AGENT_SAMPLE_RATE_HZ = 16_000;
export const MAX_PROVIDER_CREDENTIAL_LENGTH = 4_096;
export const MAX_STT_ENDPOINT_LENGTH = 2_048;
export const MAX_STT_MODEL_LENGTH = 160;
export const CAPTION_PLACEMENT_ANALYSIS =
  "local-three-band-edge-density-v1";
export const MAX_CAPTION_PLACEMENT_SAMPLES = 9;

export const CAPTION_AGENT_PROVIDER_HEADERS = Object.freeze({
  sttEndpoint: "X-Kirinuki-STT-Endpoint",
  sttModel: "X-Kirinuki-STT-Model",
  sttApiKey: "X-Kirinuki-STT-API-Key",
  upstageApiKey: "X-Kirinuki-Upstage-API-Key"
});

export const DEFAULT_CAPTION_AGENT_SETTINGS = Object.freeze({
  endpoint: "http://127.0.0.1:4319/v1/captions",
  model: "solar-pro3",
  sttEndpoint: "",
  sttModel: ""
});

const ALLOWED_SOLAR_MODELS = new Set([
  "solar-pro3",
  "solar-pro2",
  "solar-mini"
]);

const PLACEMENT_Y = Object.freeze({
  top: 0.18,
  center: 0.5,
  bottom: 0.84
});

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function isLoopbackHostname(hostname) {
  return hostname === "127.0.0.1" ||
    hostname === "localhost";
}

function isLoopbackAgentEndpoint(value) {
  const url = new URL(normalizeCaptionAgentEndpoint(value));
  return (
    url.protocol === "http:"
    && isLoopbackHostname(url.hostname)
  );
}

export function normalizeExternalSttEndpoint(value) {
  const input = String(value || "").trim();
  if (!input) {
    return "";
  }
  if (input.length > MAX_STT_ENDPOINT_LENGTH) {
    throw new Error("STT API 주소가 허용 길이를 넘었습니다.");
  }
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error("STT API 주소가 올바른 URL이 아닙니다.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      "STT API 주소에 인증 정보·쿼리 문자열·# 조각을 넣지 마세요."
    );
  }
  const secureRemote = url.protocol === "https:";
  const localHttp = (
    url.protocol === "http:"
    && isLoopbackHostname(url.hostname)
  );
  if (!secureRemote && !localHttp) {
    throw new Error("STT API 주소는 HTTPS 또는 loopback HTTP여야 합니다.");
  }
  return url.toString();
}

function normalizeProviderSecret(value, label) {
  const secret = String(value || "").trim();
  if (!secret) {
    return "";
  }
  if (
    secret.length > MAX_PROVIDER_CREDENTIAL_LENGTH
    || /[\r\n]/u.test(secret)
  ) {
    throw new Error(`${label} 형식이 올바르지 않습니다.`);
  }
  return secret;
}

function normalizeSttModel(value) {
  const model = String(value || "").trim();
  if (!model) {
    return "";
  }
  if (
    model.length > MAX_STT_MODEL_LENGTH
    || /[\u0000-\u001f\u007f]/u.test(model)
  ) {
    throw new Error("STT 모델명이 올바르지 않습니다.");
  }
  return model;
}

export function normalizeCaptionProviderConfig(raw = {}) {
  return {
    sttEndpoint: normalizeExternalSttEndpoint(raw.sttEndpoint),
    sttModel: normalizeSttModel(raw.sttModel),
    sttApiKey: normalizeProviderSecret(raw.sttApiKey, "STT API 키"),
    upstageApiKey: normalizeProviderSecret(
      raw.upstageApiKey,
      "Upstage API 키"
    )
  };
}

export function captionProviderHeaders(endpoint, raw = {}) {
  const provider = normalizeCaptionProviderConfig(raw);
  const supplied = Object.values(provider).some(Boolean);
  if (!supplied) {
    return {};
  }
  if (!isLoopbackAgentEndpoint(endpoint)) {
    throw new Error(
      "STT·Upstage API 키와 제공자 설정은 로컬 companion 주소로만 전달할 수 있습니다."
    );
  }
  return Object.fromEntries(
    Object.entries(provider)
      .filter(([, value]) => value)
      .map(([field, value]) => [
        CAPTION_AGENT_PROVIDER_HEADERS[field],
        value
      ])
  );
}

export function normalizeCaptionAgentEndpoint(value) {
  let url;
  try {
    url = new URL(String(value || "").trim());
  } catch {
    throw new Error("자막 에이전트 주소가 올바른 URL이 아닙니다.");
  }
  if (url.username || url.password) {
    throw new Error("자막 에이전트 주소에 아이디나 비밀번호를 넣지 마세요.");
  }
  if (url.hash) {
    throw new Error("자막 에이전트 주소에는 # 조각을 사용할 수 없습니다.");
  }
  const secureRemote = url.protocol === "https:";
  const localHttp = url.protocol === "http:" && isLoopbackHostname(url.hostname);
  if (!secureRemote && !localHttp) {
    throw new Error("외부 에이전트는 HTTPS, 로컬 에이전트는 127.0.0.1·localhost만 사용할 수 있습니다.");
  }
  return url.toString();
}

export function captionAgentPermissionOrigin(endpoint) {
  const url = new URL(normalizeCaptionAgentEndpoint(endpoint));
  return `${url.protocol}//${url.hostname}/*`;
}

export function normalizeCaptionAgentSettings(raw = {}) {
  const model = ALLOWED_SOLAR_MODELS.has(raw.model)
    ? raw.model
    : DEFAULT_CAPTION_AGENT_SETTINGS.model;
  let endpoint = DEFAULT_CAPTION_AGENT_SETTINGS.endpoint;
  try {
    endpoint = normalizeCaptionAgentEndpoint(
      raw.endpoint || DEFAULT_CAPTION_AGENT_SETTINGS.endpoint
    );
  } catch {
    // A stale or malformed saved setting must not prevent the editor from opening.
  }
  let sttEndpoint = "";
  try {
    sttEndpoint = normalizeExternalSttEndpoint(raw.sttEndpoint);
  } catch {
    // Invalid non-secret provider settings are discarded on load.
  }
  let sttModel = "";
  try {
    sttModel = normalizeSttModel(raw.sttModel);
  } catch {
    // Invalid non-secret provider settings are discarded on load.
  }
  return { endpoint, model, sttEndpoint, sttModel };
}

export async function loadCaptionAgentSettings(storageArea = chrome.storage.local) {
  const stored = await storageArea.get(CAPTION_AGENT_SETTINGS_KEY);
  return normalizeCaptionAgentSettings(stored[CAPTION_AGENT_SETTINGS_KEY]);
}

export async function saveCaptionAgentSettings(
  settings,
  storageArea = chrome.storage.local
) {
  const normalized = normalizeCaptionAgentSettings({
    ...settings,
    endpoint: normalizeCaptionAgentEndpoint(settings?.endpoint),
    sttEndpoint: normalizeExternalSttEndpoint(settings?.sttEndpoint),
    sttModel: normalizeSttModel(settings?.sttModel)
  });
  await storageArea.set({ [CAPTION_AGENT_SETTINGS_KEY]: normalized });
  return normalized;
}

export async function ensureCaptionAgentPermission(
  endpoint,
  permissionsApi = chrome.permissions
) {
  const origin = captionAgentPermissionOrigin(endpoint);
  if (await permissionsApi.contains({ origins: [origin] })) {
    return true;
  }
  return permissionsApi.request({ origins: [origin] });
}

export function captionAgentAudioFootprint(durationMs) {
  const duration = Math.round(finiteNumber(durationMs));
  if (duration <= 0 || duration > MAX_CAPTION_AGENT_CLIP_DURATION_MS) {
    throw new RangeError("Solar 자막은 한 컷당 30분 이하만 처리할 수 있습니다.");
  }
  const sampleCount = Math.ceil(
    duration * CAPTION_AGENT_SAMPLE_RATE_HZ / 1_000
  );
  const floatPcmBytes = sampleCount * Float32Array.BYTES_PER_ELEMENT;
  const wavBytes = 44 + sampleCount * Int16Array.BYTES_PER_ELEMENT;
  if (wavBytes > MAX_CAPTION_AGENT_WAV_BYTES) {
    throw new RangeError("Solar 자막용 WAV가 64MiB 상한을 넘습니다.");
  }
  return {
    durationMs: duration,
    sampleCount,
    floatPcmBytes,
    wavBytes,
    base64Bytes: 4 * Math.ceil(wavBytes / 3)
  };
}

export function encodePcm16WavBase64(
  audio,
  sampleRateHz = CAPTION_AGENT_SAMPLE_RATE_HZ
) {
  if (!(audio instanceof Float32Array)) {
    throw new TypeError("16kHz Float32 PCM 오디오가 필요합니다.");
  }
  const sampleRate = Math.round(finiteNumber(sampleRateHz));
  if (sampleRate !== CAPTION_AGENT_SAMPLE_RATE_HZ) {
    throw new RangeError("Solar 자막은 16kHz PCM 오디오만 처리할 수 있습니다.");
  }
  const wavByteLength = 44 + audio.length * 2;
  if (wavByteLength > MAX_CAPTION_AGENT_WAV_BYTES) {
    throw new RangeError("Solar 자막용 WAV가 64MiB 상한을 넘습니다.");
  }
  const bytes = new Uint8Array(wavByteLength);
  const view = new DataView(bytes.buffer);
  const writeAscii = (offset, text) => {
    for (let index = 0; index < text.length; index += 1) {
      bytes[offset + index] = text.charCodeAt(index);
    }
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, bytes.length - 8, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, "data");
  view.setUint32(40, audio.length * 2, true);
  for (let index = 0; index < audio.length; index += 1) {
    const sample = clamp(finiteNumber(audio[index]), -1, 1);
    view.setInt16(
      44 + index * 2,
      Math.round(sample < 0 ? sample * 0x8000 : sample * 0x7fff),
      true
    );
  }

  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index];
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    const packed = (first << 16) | ((second || 0) << 8) | (third || 0);
    output += alphabet[(packed >>> 18) & 63];
    output += alphabet[(packed >>> 12) & 63];
    output += index + 1 < bytes.length ? alphabet[(packed >>> 6) & 63] : "=";
    output += index + 2 < bytes.length ? alphabet[packed & 63] : "=";
  }
  return output;
}

export function createCaptionAgentRequest({
  project,
  clip,
  model,
  audioBase64,
  placementHints
}) {
  const durationMs = Math.max(0, Math.round(
    finiteNumber(clip?.sourceEndMs) - finiteNumber(clip?.sourceStartMs)
  ));
  if (!clip?.id || durationMs <= 0) {
    throw new Error("자막을 만들 컷 구간이 올바르지 않습니다.");
  }
  captionAgentAudioFootprint(durationMs);
  if (!ALLOWED_SOLAR_MODELS.has(model)) {
    throw new Error("지원하지 않는 Solar 모델입니다.");
  }
  if (!audioBase64) {
    throw new Error("에이전트에 보낼 음성이 비어 있습니다.");
  }
  if (
    !placementHints
    || placementHints.analysis !== CAPTION_PLACEMENT_ANALYSIS
    || placementHints.framesShared !== false
    || !Array.isArray(placementHints.samples)
    || placementHints.samples.length < 1
    || placementHints.samples.length > MAX_CAPTION_PLACEMENT_SAMPLES
  ) {
    throw new Error("자막 위치용 로컬 화면 분석값이 올바르지 않습니다.");
  }
  const visualSamples = placementHints.samples.map((sample, sampleIndex) => {
    const atMs = Number(sample?.atMs);
    const topScore = Number(sample?.topScore);
    const centerScore = Number(sample?.centerScore);
    const bottomScore = Number(sample?.bottomScore);
    if (
      !Number.isInteger(atMs)
      || atMs < 0
      || atMs >= durationMs
      || [topScore, centerScore, bottomScore].some(
        (score) => !Number.isInteger(score) || score < 0 || score > 1_000
      )
      || !["top", "center", "bottom"].includes(
        sample?.preferredPlacement
      )
      || (
        sampleIndex > 0
        && atMs <= Number(placementHints.samples[sampleIndex - 1]?.atMs)
      )
    ) {
      throw new Error("자막 위치용 화면 분석 표본이 올바르지 않습니다.");
    }
    return {
      atMs,
      topScore,
      centerScore,
      bottomScore,
      preferredPlacement: sample.preferredPlacement
    };
  });
  return {
    schema: CAPTION_AGENT_REQUEST_SCHEMA,
    requestId: globalThis.crypto.randomUUID(),
    model,
    locale: "ko-KR",
    clip: {
      id: clip.id,
      title: String(clip.note ?? clip.title ?? "").slice(0, 1_000),
      durationMs
    },
    source: {
      projectId: String(project?.id || ""),
      projectName: String(project?.name || ""),
      streamerName: String(project?.source?.streamerName || "")
    },
    policy: {
      audience: "korean-vtuber-kirinuki",
      includeAllRecognizableSpeech: true,
      uncertainSpeech: "keep-and-mark-for-review",
      maxCueDurationMs: MAX_REMOTE_CUE_DURATION_MS,
      terminalPeriod: "omit",
      questionAndExclamationMarks: "keep",
      placement: "choose-readable-safe-area"
    },
    visual: {
      analysis: CAPTION_PLACEMENT_ANALYSIS,
      framesShared: false,
      samples: visualSamples
    },
    audio: {
      encoding: "base64",
      mimeType: "audio/wav",
      sampleRateHz: CAPTION_AGENT_SAMPLE_RATE_HZ,
      channels: 1,
      data: audioBase64
    }
  };
}

function stripTerminalPeriod(text) {
  return String(text || "")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/[.\u3002\uff0e]+(?=(?:["'”’)\]}\u3009\u300b\u300d\u300f\u3011]*)$)/gu, "")
    .trim();
}

function normalizedColor(value) {
  const color = String(value || "").trim();
  return /^#[0-9a-f]{6}$/iu.test(color) ? color.toLowerCase() : undefined;
}

function normalizedRemoteMeta(raw, placement) {
  return {
    speakerId: String(raw?.speakerId ?? raw?.speaker_id ?? "unknown")
      .replace(/\s+/gu, " ")
      .trim()
      .slice(0, 80) || "unknown",
    reviewRequired: Boolean(raw?.reviewRequired ?? raw?.review_required),
    placement
  };
}

export function normalizeCaptionAgentCues(cues, clipDurationMs) {
  const durationMs = Math.max(0, Math.round(finiteNumber(clipDurationMs)));
  if (!Array.isArray(cues)) {
    throw new Error("자막 에이전트 응답에 cues 배열이 없습니다.");
  }
  if (cues.length > MAX_REMOTE_CUES) {
    throw new Error(`자막 에이전트 응답이 ${MAX_REMOTE_CUES}개 cue 상한을 넘었습니다.`);
  }
  const normalized = cues.map((raw, index) => {
    const text = stripTerminalPeriod(raw?.text);
    const rawStartMs = Number(raw?.startMs ?? raw?.start_ms);
    const rawEndMs = Number(raw?.endMs ?? raw?.end_ms);
    if (!text) {
      throw new Error(`${index + 1}번째 원격 자막의 텍스트가 비어 있습니다.`);
    }
    if (
      !Number.isFinite(rawStartMs) ||
      !Number.isFinite(rawEndMs) ||
      rawStartMs < 0 ||
      rawEndMs > durationMs ||
      rawEndMs - rawStartMs < 100
    ) {
      throw new Error(`${index + 1}번째 원격 자막의 시간 범위가 올바르지 않습니다.`);
    }
    if (rawEndMs - rawStartMs > MAX_REMOTE_CUE_DURATION_MS) {
      throw new Error(`${index + 1}번째 원격 자막이 4초 제한을 넘었습니다.`);
    }
    const startOffsetMs = Math.round(rawStartMs);
    const endOffsetMs = Math.round(rawEndMs);
    const requestedPlacement = String(raw?.placement || "bottom").toLowerCase();
    const placement = Object.hasOwn(PLACEMENT_Y, requestedPlacement)
      ? requestedPlacement
      : "bottom";
    const y = Object.hasOwn(PLACEMENT_Y, requestedPlacement)
      ? PLACEMENT_Y[requestedPlacement]
      : clamp(finiteNumber(raw?.y, PLACEMENT_Y.bottom), 0.08, 0.92);
    const color = normalizedColor(raw?.color);
    return {
      startOffsetMs,
      endOffsetMs,
      text,
      y,
      ...(color ? { color } : {}),
      remoteMeta: normalizedRemoteMeta(raw, placement)
    };
  }).sort((left, right) => (
    left.startOffsetMs - right.startOffsetMs ||
    left.endOffsetMs - right.endOffsetMs
  ));

  return normalized;
}

async function readResponseTextLimited(
  response,
  maxBytes = MAX_CAPTION_AGENT_RESPONSE_BYTES
) {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error("자막 에이전트 응답 본문이 너무 큽니다.");
  }
  if (!response.body?.getReader) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new Error("자막 에이전트 응답 본문이 너무 큽니다.");
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
        throw new Error("자막 에이전트 응답 본문이 너무 큽니다.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

async function parseResponse(response) {
  const text = await readResponseTextLimited(response);
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      if (response.ok) {
        throw new Error("자막 에이전트가 JSON이 아닌 응답을 보냈습니다.");
      }
    }
  }
  if (!response.ok) {
    const detail = payload?.error?.message || payload?.message || text;
    throw new Error(
      `자막 에이전트 요청 실패 (${response.status})${detail ? `: ${String(detail).slice(0, 240)}` : ""}`
    );
  }
  return payload || {};
}

function abortableDelay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error
        ? signal.reason
        : new DOMException("작업이 취소되었습니다.", "AbortError"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("작업이 취소되었습니다.", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function throwIfAborted(signal) {
  if (!signal?.aborted) {
    return;
  }
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException("작업이 취소되었습니다.", "AbortError");
}

function createDeadlineSignal(parentSignal, timeoutMs) {
  const normalizedTimeoutMs = Number(timeoutMs);
  if (!Number.isFinite(normalizedTimeoutMs) || normalizedTimeoutMs <= 0) {
    throw new RangeError("자막 에이전트 요청 제한 시간이 올바르지 않습니다.");
  }
  const controller = new AbortController();
  const onParentAbort = () => {
    if (!controller.signal.aborted) {
      controller.abort(
        parentSignal.reason instanceof Error
          ? parentSignal.reason
          : new DOMException("작업이 취소되었습니다.", "AbortError")
      );
    }
  };
  if (parentSignal?.aborted) {
    onParentAbort();
  } else {
    parentSignal?.addEventListener("abort", onParentAbort, { once: true });
  }
  const timeout = setTimeout(() => {
    if (!controller.signal.aborted) {
      controller.abort(
        new DOMException("자막 에이전트 요청 제한 시간을 넘었습니다.", "TimeoutError")
      );
    }
  }, Math.floor(normalizedTimeoutMs));
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timeout);
      parentSignal?.removeEventListener("abort", onParentAbort);
    }
  };
}

function isPlainObject(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function requiredResponseString(payload, field) {
  if (typeof payload[field] !== "string" || !payload[field].trim()) {
    throw new Error(`자막 에이전트 응답의 ${field} 필드가 올바르지 않습니다.`);
  }
  return payload[field];
}

function assertExactResponseFields(value, allowedFields, label) {
  const unknownFields = Object.keys(value).filter(
    (field) => !allowedFields.includes(field)
  );
  if (unknownFields.length > 0) {
    throw new Error(
      `${label}에 지원하지 않는 필드가 있습니다: ${unknownFields.join(", ")}`
    );
  }
}

function validateCompletedCaptionAgentResponse(payload, request) {
  if (!isPlainObject(payload)) {
    throw new Error("자막 에이전트 완료 응답이 JSON 객체가 아닙니다.");
  }
  assertExactResponseFields(payload, [
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
  ], "자막 에이전트 완료 응답");
  if (payload.schema !== CAPTION_AGENT_RESPONSE_SCHEMA) {
    throw new Error("자막 에이전트 응답 스키마 버전이 맞지 않습니다.");
  }
  if (payload.status !== "completed") {
    throw new Error("자막 에이전트 완료 응답의 status가 올바르지 않습니다.");
  }

  const requestId = requiredResponseString(payload, "requestId");
  const clipId = requiredResponseString(payload, "clipId");
  if (requestId.length > 128 || clipId.length > 256) {
    throw new Error("자막 에이전트 응답 식별자가 허용 길이를 넘었습니다.");
  }
  if (requestId !== String(request?.requestId || "")) {
    throw new Error("자막 에이전트 응답의 요청 ID가 현재 요청과 다릅니다.");
  }
  if (clipId !== String(request?.clip?.id || "")) {
    throw new Error("자막 에이전트 응답의 컷 ID가 요청과 다릅니다.");
  }
  if (payload.language !== "ko") {
    throw new Error("자막 에이전트 응답 언어가 한국어가 아닙니다.");
  }
  for (const field of [
    "sttModel",
    "captionModel",
    "model",
    "resolvedModel",
    "provider"
  ]) {
    requiredResponseString(payload, field);
  }
  if (payload.provider !== "upstage") {
    throw new Error("자막 에이전트 응답 제공자가 Upstage가 아닙니다.");
  }
  if (!Array.isArray(payload.cues) || payload.cues.length > MAX_REMOTE_CUES) {
    throw new Error("자막 에이전트 응답의 cues 필드가 올바르지 않습니다.");
  }
  const clipDurationMs = Number(request?.clip?.durationMs);
  for (const [index, cue] of payload.cues.entries()) {
    if (
      !isPlainObject(cue) ||
      !Number.isInteger(cue.startMs) ||
      !Number.isInteger(cue.endMs) ||
      cue.startMs < 0 ||
      cue.endMs <= cue.startMs ||
      cue.endMs > clipDurationMs ||
      cue.endMs - cue.startMs > MAX_REMOTE_CUE_DURATION_MS ||
      typeof cue.text !== "string" ||
      !cue.text.trim() ||
      cue.text.length > 300 ||
      typeof cue.speakerId !== "string" ||
      !cue.speakerId.trim() ||
      cue.speakerId.length > 80 ||
      typeof cue.reviewRequired !== "boolean" ||
      !["top", "center", "bottom"].includes(cue.placement)
    ) {
      throw new Error(`${index + 1}번째 자막 에이전트 응답 cue가 올바르지 않습니다.`);
    }
    assertExactResponseFields(cue, [
      "startMs",
      "endMs",
      "text",
      "speakerId",
      "reviewRequired",
      "placement"
    ], `${index + 1}번째 자막 에이전트 응답 cue`);
  }
  if (
    !Array.isArray(payload.warnings)
    || payload.warnings.length > MAX_REMOTE_WARNINGS
  ) {
    throw new Error("자막 에이전트 응답의 warnings 필드가 올바르지 않습니다.");
  }
  for (const [index, warning] of payload.warnings.entries()) {
    if (
      !isPlainObject(warning) ||
      typeof warning.code !== "string" ||
      !warning.code.trim() ||
      warning.code.length > 128 ||
      !Number.isInteger(warning.cueIndex) ||
      warning.cueIndex < 0
    ) {
      throw new Error(`${index + 1}번째 자막 에이전트 응답 warning이 올바르지 않습니다.`);
    }
    assertExactResponseFields(
      warning,
      ["code", "cueIndex"],
      `${index + 1}번째 자막 에이전트 응답 warning`
    );
  }
  return payload;
}

function assertSafeStatusUrl(statusUrl, endpoint) {
  const status = new URL(statusUrl, endpoint);
  const requested = new URL(endpoint);
  if (status.username || status.password || status.hash) {
    throw new Error("자막 에이전트 작업 상태 주소에 인증 정보나 # 조각을 넣을 수 없습니다.");
  }
  if (status.origin !== requested.origin) {
    throw new Error("자막 에이전트가 다른 출처의 작업 상태 주소를 반환했습니다.");
  }
  return status.toString();
}

export async function requestCaptionAgent({
  endpoint,
  token,
  providerConfig,
  request,
  signal,
  fetchImpl = fetch,
  onProgress = () => {},
  timeoutMs = CAPTION_AGENT_REQUEST_TIMEOUT_MS,
  maxPollAttempts = MAX_CAPTION_AGENT_POLL_ATTEMPTS
}) {
  const normalizedEndpoint = normalizeCaptionAgentEndpoint(endpoint);
  throwIfAborted(signal);
  const normalizedMaxPollAttempts = Number(maxPollAttempts);
  if (
    !Number.isInteger(normalizedMaxPollAttempts) ||
    normalizedMaxPollAttempts < 1
  ) {
    throw new RangeError("자막 에이전트 폴링 횟수 상한이 올바르지 않습니다.");
  }
  const deadline = createDeadlineSignal(signal, timeoutMs);
  const requestSignal = deadline.signal;
  try {
    throwIfAborted(requestSignal);
    const headers = {
      "Content-Type": "application/json",
      "X-Kirinuki-Protocol": CAPTION_AGENT_REQUEST_SCHEMA,
      ...captionProviderHeaders(normalizedEndpoint, providerConfig)
    };
    if (String(token || "").trim()) {
      headers.Authorization = `Bearer ${String(token).trim()}`;
    }
    onProgress(0.08, "외부 자막 에이전트에 음성을 보내는 중");
    throwIfAborted(requestSignal);
    let response = await fetchImpl(normalizedEndpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(request),
      signal: requestSignal,
      cache: "no-store",
      credentials: "omit",
      redirect: "error"
    });
    let payload = await parseResponse(response);
    let statusUrl = payload.statusUrl
      ? assertSafeStatusUrl(payload.statusUrl, normalizedEndpoint)
      : null;
    let pollCount = 0;
    while (
      response.status === 202 ||
      ["queued", "transcribing", "captioning", "running"].includes(payload.status)
    ) {
      if (!statusUrl) {
        throw new Error("비동기 자막 작업에 상태 확인 주소가 없습니다.");
      }
      if (pollCount >= normalizedMaxPollAttempts) {
        throw new Error("자막 에이전트 상태 확인 횟수 상한을 넘었습니다.");
      }
      pollCount += 1;
      onProgress(
        clamp(finiteNumber(payload.progress, 0.15 + pollCount * 0.025), 0.12, 0.92),
        String(payload.message || "외부 음성인식과 Solar 자막 정리 중")
      );
      await abortableDelay(
        clamp(finiteNumber(payload.retryAfterMs, 1_200), 300, 10_000),
        requestSignal
      );
      throwIfAborted(requestSignal);
      response = await fetchImpl(statusUrl, {
        method: "GET",
        headers: {
          "X-Kirinuki-Protocol": CAPTION_AGENT_REQUEST_SCHEMA,
          ...(String(token || "").trim()
            ? { Authorization: `Bearer ${String(token).trim()}` }
            : {})
        },
        signal: requestSignal,
        cache: "no-store",
        credentials: "omit",
        redirect: "error"
      });
      payload = await parseResponse(response);
      statusUrl = payload.statusUrl
        ? assertSafeStatusUrl(payload.statusUrl, normalizedEndpoint)
        : statusUrl;
    }
    throwIfAborted(requestSignal);
    validateCompletedCaptionAgentResponse(payload, request);
    onProgress(1, "Solar 자막 초안 수신 완료");
    return payload;
  } finally {
    deadline.cleanup();
  }
}

export async function probeCaptionAgent({
  endpoint,
  token,
  providerConfig,
  signal,
  fetchImpl = fetch,
  timeoutMs = CAPTION_AGENT_PROBE_TIMEOUT_MS
}) {
  const normalizedEndpoint = normalizeCaptionAgentEndpoint(endpoint);
  throwIfAborted(signal);
  const deadline = createDeadlineSignal(signal, timeoutMs);
  try {
    const headers = {
      "X-Kirinuki-Protocol": CAPTION_AGENT_REQUEST_SCHEMA,
      ...captionProviderHeaders(normalizedEndpoint, providerConfig)
    };
    if (String(token || "").trim()) {
      headers.Authorization = `Bearer ${String(token).trim()}`;
    }
    const response = await fetchImpl(normalizedEndpoint, {
      method: "GET",
      headers,
      signal: deadline.signal,
      cache: "no-store",
      credentials: "omit",
      redirect: "error"
    });
    return parseResponse(response);
  } finally {
    deadline.cleanup();
  }
}
