#!/usr/bin/env node

import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  CAPTION_AGENT_REQUEST_SCHEMA_ID,
  CAPTION_AGENT_RESPONSE_SCHEMA_ID,
  MAX_CAPTION_CUE_DURATION_MS,
  MAX_CLIP_DURATION_MS,
  SUPPORTED_SOLAR_CAPTION_MODELS,
  CaptionProtocolError
} from "../src/caption-agent/protocol.js";
import {
  CaptionGatewayError,
  DEFAULT_TRANSCRIPTION_MODE,
  resolveCaptionPipelineConfig,
  resolveCaptionPipelineRequestConfig,
  runCaptionPipeline
} from "../src/caption-agent/solar-gateway-core.js";

export const CAPTION_AGENT_CAPABILITY_SCHEMA_ID =
  "chzzk-kirinuki-caption-agent/capability-v1";
export const DEFAULT_CAPTION_GATEWAY_PORT = 4319;
export const CAPTION_PROVIDER_REQUEST_HEADERS = Object.freeze({
  sttEndpoint: "x-kirinuki-stt-endpoint",
  sttModel: "x-kirinuki-stt-model",
  sttApiKey: "x-kirinuki-stt-api-key",
  upstageApiKey: "x-kirinuki-upstage-api-key"
});

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

export function resolveCaptionGatewayConfig(env = process.env) {
  const pipeline = resolveCaptionPipelineConfig(env, {
    allowMissingProviderConfig: true
  });
  const allowedOrigin = requiredServerValue(
    env.KIRINUKI_ALLOWED_ORIGIN,
    "KIRINUKI_ALLOWED_ORIGIN"
  );
  if (
    allowedOrigin === "*"
    || /[\r\n]/u.test(allowedOrigin)
  ) {
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
    throw new CaptionGatewayError("KIRINUKI_AGENT_PORT가 올바르지 않습니다.", {
      code: "INVALID_CONFIGURATION",
      httpStatus: 500
    });
  }
  const requestedBodyBytes = Number(env.KIRINUKI_MAX_BODY_BYTES);
  const minimumBodyBytes = Math.ceil(pipeline.maxAudioBytes * 4 / 3) + 1_048_576;
  return {
    agentToken: requiredServerValue(
      env.KIRINUKI_AGENT_TOKEN,
      "KIRINUKI_AGENT_TOKEN"
    ),
    allowedOrigin,
    port: portValue,
    maxBodyBytes: Number.isFinite(requestedBodyBytes) && requestedBodyBytes > 0
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
      "X-Kirinuki-Protocol",
      "X-Kirinuki-STT-Endpoint",
      "X-Kirinuki-STT-Model",
      "X-Kirinuki-STT-API-Key",
      "X-Kirinuki-Upstage-API-Key"
    ].join(", ")
  );
  response.setHeader("access-control-max-age", "600");
  response.setHeader("vary", "Origin");
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
    throw new CaptionGatewayError("Content-Type은 application/json이어야 합니다.", {
      code: "UNSUPPORTED_MEDIA_TYPE",
      httpStatus: 415
    });
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
    throw new CaptionGatewayError("요청 본문이 올바른 JSON이 아닙니다.", {
      code: "INVALID_JSON",
      httpStatus: 400
    });
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

function requestHeader(request, name, maxLength) {
  const distinctValues = request.headersDistinct?.[name];
  if (Array.isArray(distinctValues) && distinctValues.length > 1) {
    throw new CaptionGatewayError("중복된 제공자 설정 헤더를 사용할 수 없습니다.", {
      code: "INVALID_CONFIGURATION",
      httpStatus: 400
    });
  }
  const raw = request.headers[name];
  if (Array.isArray(raw)) {
    throw new CaptionGatewayError("중복된 제공자 설정 헤더를 사용할 수 없습니다.", {
      code: "INVALID_CONFIGURATION",
      httpStatus: 400
    });
  }
  const value = String(raw || "").trim();
  if (
    value.length > maxLength
    || /[\r\n]/u.test(value)
  ) {
    throw new CaptionGatewayError("제공자 설정 헤더가 올바르지 않습니다.", {
      code: "INVALID_CONFIGURATION",
      httpStatus: 400
    });
  }
  return value;
}

function providerOverrides(request) {
  return {
    sttEndpoint: requestHeader(
      request,
      CAPTION_PROVIDER_REQUEST_HEADERS.sttEndpoint,
      2_048
    ),
    sttModel: requestHeader(
      request,
      CAPTION_PROVIDER_REQUEST_HEADERS.sttModel,
      160
    ),
    sttApiKey: requestHeader(
      request,
      CAPTION_PROVIDER_REQUEST_HEADERS.sttApiKey,
      4_096
    ),
    upstageApiKey: requestHeader(
      request,
      CAPTION_PROVIDER_REQUEST_HEADERS.upstageApiKey,
      4_096
    )
  };
}

function providerReadiness(baseConfig, overrides) {
  const configured = {
    sttEndpoint: Boolean(overrides.sttEndpoint || baseConfig.sttEndpoint),
    sttApiKey: Boolean(overrides.sttApiKey || baseConfig.sttApiKey),
    upstageApiKey: Boolean(
      overrides.upstageApiKey || baseConfig.upstageApiKey
    )
  };
  return {
    ...configured,
    ready: Object.values(configured).every(Boolean)
  };
}

function capabilityResponse(config, overrides) {
  const configured = providerReadiness(config.pipeline, overrides);
  const effectivePipeline = configured.ready
    ? resolveCaptionPipelineRequestConfig(config.pipeline, overrides)
    : {
      ...config.pipeline,
      sttModel: overrides.sttModel || config.pipeline.sttModel
    };
  return {
    schema: CAPTION_AGENT_CAPABILITY_SCHEMA_ID,
    status: "ok",
    provider: "upstage",
    models: {
      stt: effectivePipeline.sttModel,
      captions: effectivePipeline.solarModel
    },
    model: effectivePipeline.solarModel,
    defaultModel: effectivePipeline.solarModel,
    availableModels: [...SUPPORTED_SOLAR_CAPTION_MODELS],
    transcription: {
      mode: DEFAULT_TRANSCRIPTION_MODE,
      solarInput: "text-only",
      requiresTimedTranscript: true,
      ready: configured.sttEndpoint && configured.sttApiKey
    },
    requestSchema: CAPTION_AGENT_REQUEST_SCHEMA_ID,
    responseSchema: CAPTION_AGENT_RESPONSE_SCHEMA_ID,
    maxCueDurationMs: MAX_CAPTION_CUE_DURATION_MS,
    maxClipDurationMs: MAX_CLIP_DURATION_MS,
    maxAudioBytes: effectivePipeline.maxAudioBytes,
    pipelineTimeoutMs: effectivePipeline.pipelineTimeoutMs,
    configured
  };
}

export function createSolarCaptionGatewayServer({
  env = process.env,
  fetchImpl = globalThis.fetch,
  pipelineRunner = runCaptionPipeline
} = {}) {
  const config = resolveCaptionGatewayConfig(env);
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

    const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
    if (requestUrl.pathname !== "/v1/captions") {
      sendJson(response, 404, {
        error: { code: "NOT_FOUND", message: "요청 경로를 찾지 못했습니다." }
      });
      return;
    }
    if (request.method === "OPTIONS") {
      response.statusCode = 204;
      response.setHeader("cache-control", "no-store");
      response.end();
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
    if (!exactBearerToken(request.headers.authorization, config.agentToken)) {
      response.setHeader("www-authenticate", "Bearer");
      sendJson(response, 401, {
        error: { code: "UNAUTHORIZED", message: "Bearer 인증이 필요합니다." }
      });
      return;
    }
    if (request.method === "GET") {
      try {
        sendJson(
          response,
          200,
          capabilityResponse(config, providerOverrides(request))
        );
      } catch (error) {
        const safe = safeError(error);
        sendJson(response, safe.status, {
          error: { code: safe.code, message: safe.message }
        });
      }
      return;
    }

    const pipelineController = new AbortController();
    const abortPipeline = () => {
      if (!pipelineController.signal.aborted) {
        pipelineController.abort(
          new DOMException("자막 요청 연결이 닫혔습니다.", "AbortError")
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
        config.pipeline,
        providerOverrides(request)
      );
      const body = await readJsonRequest(request, config.maxBodyBytes);
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
        error: { code: safe.code, message: safe.message }
      });
    } finally {
      request.removeListener("aborted", abortPipeline);
    }
  });
  return { server, config };
}

export async function startSolarCaptionGateway(options = {}) {
  const { server, config } = createSolarCaptionGatewayServer(options);
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
  startSolarCaptionGateway()
    .then(({ server, config }) => {
      console.log(
        `Solar caption gateway ready at http://127.0.0.1:${config.port}`
      );
      const close = () => {
        server.close(() => process.exit(0));
      };
      process.once("SIGINT", close);
      process.once("SIGTERM", close);
    })
    .catch((error) => {
      const safe = safeError(error);
      console.error(`Solar caption gateway failed: ${safe.code}`);
      process.exitCode = 1;
    });
}
