#!/usr/bin/env node

import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  CAPTION_AGENT_REQUEST_SCHEMA_ID,
  CAPTION_AGENT_RESPONSE_SCHEMA_ID,
  LOCAL_WHISPER_CAPTION_MODEL,
  MAX_CAPTION_CUE_DURATION_MS,
  MAX_CLIP_DURATION_MS,
  SUPPORTED_CAPTION_MODELS,
  CaptionProtocolError
} from "../src/caption-agent/protocol.js";
import {
  CAPTION_QUALITY_PROFILE_ID
} from "../src/caption-agent/caption-quality-harness.js";
import {
  CaptionGatewayError,
  LOCAL_WHISPERCPP_TRANSCRIPTION_MODE,
  resolveCaptionPipelineConfig,
  resolveCaptionPipelineRequestConfig,
  runCaptionPipeline
} from "../src/caption-agent/caption-gateway-core.js";

export const CAPTION_AGENT_CAPABILITY_SCHEMA_ID =
  "chzzk-kirinuki-caption-agent/capability-v1";
export const CAPTION_AGENT_SESSION_SCHEMA_ID =
  "chzzk-kirinuki-caption-agent/session-v1";
export const CAPTION_AGENT_HEALTH_SCHEMA_ID =
  "chzzk-kirinuki-caption-agent/health-v1";
export const DEFAULT_CAPTION_GATEWAY_PORT = 4319;
export const DEFAULT_PAIRING_LIMIT_PER_MINUTE = 12;

function requiredServerValue(value, name) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    throw new CaptionGatewayError(`${name} 환경 변수가 필요합니다.`, {
      code: "MISSING_CONFIGURATION",
      httpStatus: 500
    });
  }
  return normalized;
}

function enabledEnvironmentFlag(value) {
  return ["1", "true", "yes", "on"].includes(
    String(value || "").trim().toLowerCase()
  );
}

export function resolveCaptionGatewayConfig(env = process.env) {
  const pipeline = resolveCaptionPipelineConfig(env, {
    allowMissingProviderConfig: true
  });
  const allowedOrigin = requiredServerValue(
    env.KIRINUKI_ALLOWED_ORIGIN,
    "KIRINUKI_ALLOWED_ORIGIN"
  );
  if (allowedOrigin === "*" || /[\r\n]/u.test(allowedOrigin)) {
    throw new CaptionGatewayError(
      "KIRINUKI_ALLOWED_ORIGIN에는 정확한 단일 Origin이 필요합니다.",
      {
        code: "INVALID_CONFIGURATION",
        httpStatus: 500
      }
    );
  }
  const portValue = Number(
    env.KIRINUKI_AGENT_PORT || DEFAULT_CAPTION_GATEWAY_PORT
  );
  if (!Number.isInteger(portValue) || portValue < 1 || portValue > 65_535) {
    throw new CaptionGatewayError(
      "KIRINUKI_AGENT_PORT가 올바르지 않습니다.",
      {
        code: "INVALID_CONFIGURATION",
        httpStatus: 500
      }
    );
  }
  const requestedBodyBytes = Number(env.KIRINUKI_MAX_BODY_BYTES);
  const minimumBodyBytes =
    Math.ceil(pipeline.maxAudioBytes * 4 / 3) + 1_048_576;
  const autoPair = enabledEnvironmentFlag(env.KIRINUKI_AUTO_PAIR);
  const configuredAgentToken = String(
    env.KIRINUKI_AGENT_TOKEN || ""
  ).trim();
  if (!autoPair && !configuredAgentToken) {
    requiredServerValue(configuredAgentToken, "KIRINUKI_AGENT_TOKEN");
  }
  return {
    agentToken: configuredAgentToken,
    autoPair,
    allowedOrigin,
    port: portValue,
    maxBodyBytes: Number.isFinite(requestedBodyBytes)
      && requestedBodyBytes > 0
      ? Math.max(Math.floor(requestedBodyBytes), minimumBodyBytes)
      : minimumBodyBytes,
    pipeline
  };
}

function exactBearerToken(authorization, expectedToken) {
  const match = /^Bearer ([^\s]+)$/iu.exec(String(authorization || ""));
  if (!match) {
    return false;
  }
  const supplied = Buffer.from(match[1]);
  const expected = Buffer.from(expectedToken);
  return (
    supplied.length === expected.length
    && timingSafeEqual(supplied, expected)
  );
}

function setCorsHeaders(response, origin, allowedOrigin) {
  if (origin !== allowedOrigin) {
    return;
  }
  response.setHeader("access-control-allow-origin", allowedOrigin);
  response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  response.setHeader(
    "access-control-allow-headers",
    [
      "Authorization",
      "Content-Type",
      "X-Kirinuki-Protocol"
    ].join(", ")
  );
  response.setHeader("access-control-max-age", "600");
  response.setHeader("vary", "Origin");
}

function pairingAllowed(pairingState, now = Date.now()) {
  const windowMs = 60_000;
  if (now - pairingState.windowStartedAt >= windowMs) {
    pairingState.windowStartedAt = now;
    pairingState.count = 0;
  }
  pairingState.count += 1;
  return pairingState.count <= DEFAULT_PAIRING_LIMIT_PER_MINUTE;
}

function sendJson(response, statusCode, value) {
  const body = JSON.stringify(value);
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-length", Buffer.byteLength(body));
  response.end(body);
}

async function readJsonRequest(request, maxBodyBytes) {
  const contentType = String(request.headers["content-type"] || "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    throw new CaptionGatewayError(
      "Content-Type은 application/json이어야 합니다.",
      {
        code: "UNSUPPORTED_MEDIA_TYPE",
        httpStatus: 415
      }
    );
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBodyBytes) {
      throw new CaptionGatewayError("자막 요청 본문이 너무 큽니다.", {
        code: "REQUEST_TOO_LARGE",
        httpStatus: 413
      });
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new CaptionGatewayError(
      "요청 본문이 올바른 JSON이 아닙니다.",
      {
        code: "INVALID_JSON",
        httpStatus: 400
      }
    );
  }
}

function safeError(error) {
  if (error instanceof CaptionProtocolError) {
    return {
      status: error.code === "WAV_TOO_LARGE" ? 413 : 400,
      code: error.code,
      message: error.message
    };
  }
  if (error instanceof CaptionGatewayError) {
    return {
      status: error.httpStatus,
      code: error.code,
      message: error.message
    };
  }
  return {
    status: 500,
    code: "INTERNAL_ERROR",
    message: "자막 게이트웨이 내부 오류가 발생했습니다."
  };
}

function capabilityResponse(config) {
  const ready = Boolean(config.pipeline.sttEndpoint);
  return {
    schema: CAPTION_AGENT_CAPABILITY_SCHEMA_ID,
    status: "ok",
    provider: "local-whispercpp",
    models: {
      stt: config.pipeline.sttModel,
      captions: LOCAL_WHISPER_CAPTION_MODEL
    },
    model: LOCAL_WHISPER_CAPTION_MODEL,
    defaultModel: LOCAL_WHISPER_CAPTION_MODEL,
    availableModels: [...SUPPORTED_CAPTION_MODELS],
    transcription: {
      mode: LOCAL_WHISPERCPP_TRANSCRIPTION_MODE,
      requiresTimedTranscript: true,
      authentication: "none-loopback",
      ready
    },
    requestSchema: CAPTION_AGENT_REQUEST_SCHEMA_ID,
    responseSchema: CAPTION_AGENT_RESPONSE_SCHEMA_ID,
    qualityHarness: {
      profile: CAPTION_QUALITY_PROFILE_ID,
      automaticBodyLines: 1,
      placement: "bottom",
      paidRepairCalls: 0
    },
    maxCueDurationMs: MAX_CAPTION_CUE_DURATION_MS,
    maxClipDurationMs: MAX_CLIP_DURATION_MS,
    maxAudioBytes: config.pipeline.maxAudioBytes,
    pipelineTimeoutMs: config.pipeline.pipelineTimeoutMs,
    configured: {
      localWhisperReady: ready
    }
  };
}

export function createCaptionGatewayServer({
  env = process.env,
  fetchImpl = globalThis.fetch,
  pipelineRunner = runCaptionPipeline,
  randomBytesImpl = randomBytes,
  now = Date.now
} = {}) {
  const resolvedConfig = resolveCaptionGatewayConfig(env);
  const generatedToken = resolvedConfig.agentToken
    ? ""
    : randomBytesImpl(32).toString("base64url");
  const config = {
    ...resolvedConfig,
    agentToken: resolvedConfig.agentToken || generatedToken
  };
  const pairingState = {
    windowStartedAt: now(),
    count: 0
  };
  const server = createServer(async (request, response) => {
    const origin = String(request.headers.origin || "");
    if (origin && origin !== config.allowedOrigin) {
      sendJson(response, 403, {
        error: {
          code: "ORIGIN_NOT_ALLOWED",
          message: "허용되지 않은 Origin입니다."
        }
      });
      return;
    }
    setCorsHeaders(response, origin, config.allowedOrigin);

    const requestUrl = new URL(
      request.url || "/",
      "http://127.0.0.1"
    );
    const isHealthRequest = requestUrl.pathname === "/v1/health";
    const isPairingRequest = requestUrl.pathname === "/v1/session";
    const isCaptionRequest = requestUrl.pathname === "/v1/captions";
    if (!isHealthRequest && !isPairingRequest && !isCaptionRequest) {
      sendJson(response, 404, {
        error: {
          code: "NOT_FOUND",
          message: "요청 경로를 찾지 못했습니다."
        }
      });
      return;
    }
    if (request.method === "OPTIONS") {
      response.statusCode = 204;
      response.setHeader("cache-control", "no-store");
      response.end();
      return;
    }
    if (isHealthRequest) {
      if (
        origin !== config.allowedOrigin
        || String(request.headers["x-kirinuki-protocol"] || "")
          !== CAPTION_AGENT_REQUEST_SCHEMA_ID
      ) {
        sendJson(response, 403, {
          error: {
            code: "HEALTH_PROBE_NOT_ALLOWED",
            message: "정확한 Origin과 자막 프로토콜이 필요합니다."
          }
        });
        return;
      }
      if (request.method !== "GET") {
        response.setHeader("allow", "GET, OPTIONS");
        sendJson(response, 405, {
          error: {
            code: "METHOD_NOT_ALLOWED",
            message: "GET 요청만 지원합니다."
          }
        });
        return;
      }
      sendJson(response, 200, {
        schema: CAPTION_AGENT_HEALTH_SCHEMA_ID,
        status: "ok",
        managed: config.autoPair,
        originBinding: "exact-extension",
        transcriptionMode: LOCAL_WHISPERCPP_TRANSCRIPTION_MODE
      });
      return;
    }
    if (isPairingRequest) {
      if (!config.autoPair) {
        sendJson(response, 404, {
          error: {
            code: "PAIRING_DISABLED",
            message: "자동 로컬 연결이 비활성화되어 있습니다."
          }
        });
        return;
      }
      if (origin !== config.allowedOrigin) {
        sendJson(response, 403, {
          error: {
            code: "ORIGIN_NOT_ALLOWED",
            message: "정확한 확장 프로그램 Origin에서만 연결할 수 있습니다."
          }
        });
        return;
      }
      if (request.method !== "POST") {
        response.setHeader("allow", "POST, OPTIONS");
        sendJson(response, 405, {
          error: {
            code: "METHOD_NOT_ALLOWED",
            message: "POST 요청만 지원합니다."
          }
        });
        return;
      }
      if (
        String(request.headers["x-kirinuki-protocol"] || "")
        !== CAPTION_AGENT_REQUEST_SCHEMA_ID
      ) {
        sendJson(response, 400, {
          error: {
            code: "PROTOCOL_REQUIRED",
            message: "지원하는 자막 프로토콜 헤더가 필요합니다."
          }
        });
        return;
      }
      if (!pairingAllowed(pairingState, now())) {
        response.setHeader("retry-after", "60");
        sendJson(response, 429, {
          error: {
            code: "PAIRING_RATE_LIMITED",
            message: "자동 연결 요청이 너무 많습니다. 잠시 뒤 다시 시도해 주세요."
          }
        });
        return;
      }
      sendJson(response, 200, {
        schema: CAPTION_AGENT_SESSION_SCHEMA_ID,
        status: "ok",
        authentication: "bearer-process-memory",
        expires: "companion-restart",
        token: config.agentToken
      });
      return;
    }
    if (request.method !== "GET" && request.method !== "POST") {
      response.setHeader("allow", "GET, POST, OPTIONS");
      sendJson(response, 405, {
        error: {
          code: "METHOD_NOT_ALLOWED",
          message: "GET 또는 POST 요청만 지원합니다."
        }
      });
      return;
    }
    if (!exactBearerToken(
      request.headers.authorization,
      config.agentToken
    )) {
      response.setHeader("www-authenticate", "Bearer");
      sendJson(response, 401, {
        error: {
          code: "UNAUTHORIZED",
          message: "Bearer 인증이 필요합니다."
        }
      });
      return;
    }
    if (request.method === "GET") {
      sendJson(response, 200, capabilityResponse(config));
      return;
    }

    const pipelineController = new AbortController();
    const abortPipeline = () => {
      if (!pipelineController.signal.aborted) {
        pipelineController.abort(
          new DOMException(
            "자막 요청 연결이 닫혔습니다.",
            "AbortError"
          )
        );
      }
    };
    request.once("aborted", abortPipeline);
    response.once("close", () => {
      if (!response.writableEnded) {
        abortPipeline();
      }
    });
    try {
      const pipelineConfig = resolveCaptionPipelineRequestConfig(
        config.pipeline
      );
      const body = await readJsonRequest(
        request,
        config.maxBodyBytes
      );
      const result = await pipelineRunner(body, {
        fetchImpl,
        ...pipelineConfig,
        signal: pipelineController.signal
      });
      if (!pipelineController.signal.aborted) {
        sendJson(response, 200, result);
      }
    } catch (error) {
      if (pipelineController.signal.aborted) {
        return;
      }
      const safe = safeError(error);
      sendJson(response, safe.status, {
        error: {
          code: safe.code,
          message: safe.message
        }
      });
    } finally {
      request.removeListener("aborted", abortPipeline);
    }
  });
  return { server, config };
}

export async function startCaptionGateway(options = {}) {
  const { server, config } = createCaptionGatewayServer(options);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, "127.0.0.1", resolve);
  });
  return { server, config };
}

function isMainModule() {
  return Boolean(
    process.argv[1]
    && import.meta.url === pathToFileURL(process.argv[1]).href
  );
}

if (isMainModule()) {
  startCaptionGateway()
    .then(({ server, config }) => {
      console.log(
        `Kirinuki caption gateway ready at http://127.0.0.1:${config.port}`
      );
      const close = () => {
        server.close(() => process.exit(0));
      };
      process.once("SIGINT", close);
      process.once("SIGTERM", close);
    })
    .catch((error) => {
      const safe = safeError(error);
      console.error(`Kirinuki caption gateway failed: ${safe.code}`);
      process.exitCode = 1;
    });
}
