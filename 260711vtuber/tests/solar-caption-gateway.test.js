import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import test from "node:test";

import {
  CAPTION_AGENT_REQUEST_SCHEMA_ID,
  CAPTION_AGENT_RESPONSE_SCHEMA_ID,
  validateCaptionAgentRequest
} from "../src/caption-agent/protocol.js";
import {
  DEFAULT_SOLAR_MODEL,
  MAX_SOLAR_PROMPT_BYTES,
  MAX_STT_SEGMENTS,
  MAX_STT_WORDS,
  UPSTAGE_CHAT_COMPLETIONS_URL,
  normalizeSttTranscript,
  requestExternalStt,
  requestSolarCaptions,
  resolveCaptionPipelineConfig,
  runCaptionPipeline
} from "../src/caption-agent/solar-gateway-core.js";
import {
  normalizeCaptionAgentCues,
  requestCaptionAgent
} from "../src/editor/caption-agent.js";
import {
  CAPTION_AGENT_CAPABILITY_SCHEMA_ID,
  createSolarCaptionGatewayServer,
  resolveCaptionGatewayConfig
} from "../scripts/solar-caption-gateway.mjs";

const ALLOWED_ORIGIN = "chrome-extension://caption-agent-test";
const AGENT_TOKEN = "test-agent-token-123456";

const TEST_ENV = Object.freeze({
  KIRINUKI_STT_ENDPOINT: "https://stt.invalid/v1/audio/transcriptions",
  KIRINUKI_STT_API_KEY: "test-stt-key",
  KIRINUKI_STT_MODEL: "remote-korean-stt",
  UPSTAGE_API_KEY: "test-upstage-key",
  KIRINUKI_SOLAR_MODEL: "solar-pro3",
  KIRINUKI_AGENT_TOKEN: AGENT_TOKEN,
  KIRINUKI_ALLOWED_ORIGIN: ALLOWED_ORIGIN,
  KIRINUKI_MAX_AUDIO_BYTES: "1048576"
});

function testWavBase64() {
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

function captionRequest(overrides = {}) {
  return {
    schema: CAPTION_AGENT_REQUEST_SCHEMA_ID,
    requestId: "gateway-request-1",
    model: "solar-pro3",
    locale: "ko-KR",
    clip: {
      id: "gateway-clip-1",
      title: "게이트웨이 테스트 컷",
      durationMs: 8_000
    },
    source: {
      projectId: "gateway-project-1",
      projectName: "게이트웨이 테스트",
      streamerName: "테스트 VTuber"
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
        topScore: 710,
        centerScore: 420,
        bottomScore: 120,
        preferredPlacement: "bottom"
      }]
    },
    audio: {
      encoding: "base64",
      mimeType: "audio/wav",
      sampleRateHz: 16_000,
      channels: 1,
      data: testWavBase64()
    },
    ...overrides
  };
}

function normalizedCaptionRequest(overrides = {}) {
  return validateCaptionAgentRequest(captionRequest(overrides));
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  });
}

test("외부 STT의 segment·word 초 시각을 클립 기준 정수 밀리초로 정규화한다", () => {
  const transcript = normalizeSttTranscript({
    text: "안녕 반가워",
    words: [
      { start_ms: 120, end_ms: 610, word: "안녕" },
      { start_ms: 3_950, end_ms: 4_500, word: "반가워" }
    ],
    segments: [{
      start: -0.1,
      end: 3.9,
      text: " 안녕 ",
      speaker: "main",
      words: [
        { start: 0.12, end: 0.61, word: "안녕" }
      ]
    }, {
      start: 3.9,
      end: 9.2,
      text: "반가워"
    }]
  }, {
    clipDurationMs: 8_000
  });

  assert.deepEqual(transcript.segments, [
    { startMs: 0, endMs: 3_900, text: "안녕", speaker: "main" },
    { startMs: 3_900, endMs: 8_000, text: "반가워" }
  ]);
  assert.deepEqual(transcript.words, [
    { startMs: 120, endMs: 610, text: "안녕" },
    { startMs: 3_950, endMs: 4_500, text: "반가워" }
  ]);
});

test("외부 STT 배열 개수와 Solar 전사 프롬프트 크기를 처리 전에 제한한다", () => {
  assert.throws(
    () => normalizeSttTranscript({
      segments: Array.from(
        { length: MAX_STT_SEGMENTS + 1 },
        () => ({})
      )
    }, {
      clipDurationMs: 8_000
    }),
    (error) => error?.code === "STT_RESPONSE_TOO_LARGE"
  );
  assert.throws(
    () => normalizeSttTranscript({
      words: Array.from(
        { length: MAX_STT_WORDS + 1 },
        () => ({})
      )
    }, {
      clipDurationMs: 8_000
    }),
    (error) => error?.code === "STT_RESPONSE_TOO_LARGE"
  );
  assert.throws(
    () => normalizeSttTranscript({
      text: "가".repeat(MAX_SOLAR_PROMPT_BYTES)
    }, {
      clipDurationMs: 8_000
    }),
    (error) => error?.code === "STT_TRANSCRIPT_TOO_LARGE"
  );
});

test("파이프라인은 base64 WAV를 외부 STT에만 보내고 Solar json_schema 실패 시 json_object로 폴백한다", async () => {
  const config = resolveCaptionPipelineConfig(TEST_ENV);
  const calls = [];
  const rawAudio = captionRequest().audio.data;
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    if (calls.length === 1) {
      assert.equal(String(url), TEST_ENV.KIRINUKI_STT_ENDPOINT);
      assert.equal(init.redirect, "error");
      assert.equal(init.headers.authorization, `Bearer ${TEST_ENV.KIRINUKI_STT_API_KEY}`);
      assert(init.body instanceof FormData);
      assert.equal(init.body.get("model"), "remote-korean-stt");
      assert.equal(init.body.get("language"), "ko");
      assert.equal(init.body.has("visual"), false);
      assert.deepEqual(
        init.body.getAll("timestamp_granularities[]"),
        ["segment", "word"]
      );
      const file = init.body.get("file");
      assert.equal(file.type, "audio/wav");
      assert.equal(file.name, "clip.wav");
      assert.equal(file.name.includes("gateway-clip-1"), false);
      return jsonResponse({
        text: "안녕 반가워",
        segments: [{ start: 0.1, end: 5.2, text: "안녕 반가워" }],
        words: [
          { start: 0.1, end: 1.0, word: "안녕" },
          { start: 4.2, end: 5.2, word: "반가워" }
        ]
      });
    }

    assert.equal(String(url), UPSTAGE_CHAT_COMPLETIONS_URL);
    assert.equal(init.redirect, "error");
    assert.equal(init.headers.authorization, `Bearer ${TEST_ENV.UPSTAGE_API_KEY}`);
    const body = JSON.parse(init.body);
    assert.equal(body.model, DEFAULT_SOLAR_MODEL);
    assert.equal(body.messages[1].content.includes(rawAudio), false);
    const solarInput = JSON.parse(body.messages[1].content);
    assert.deepEqual(
      solarInput.visualPlacement.samples,
      captionRequest().visual.samples
    );
    assert.equal(body.messages[1].content.includes("base64"), false);
    if (calls.length === 2) {
      assert.equal(body.response_format.type, "json_schema");
      return jsonResponse({
        error: { message: "response_format json_schema is unsupported" }
      }, 400);
    }
    assert.equal(body.response_format.type, "json_object");
    return jsonResponse({
      choices: [{
        message: {
          content: JSON.stringify({
            cues: [{
              startMs: 100,
              endMs: 5_200,
              text: "안녕 반가워.",
              speakerId: "main",
              reviewRequired: false,
              placement: "bottom"
            }]
          })
        }
      }]
    });
  };

  const result = await runCaptionPipeline(captionRequest(), {
    fetchImpl,
    ...config
  });
  assert.equal(calls.length, 3);
  assert.equal(result.schema, CAPTION_AGENT_RESPONSE_SCHEMA_ID);
  assert.equal(result.sttModel, "remote-korean-stt");
  assert.equal(result.captionModel, "solar-pro3");
  assert.equal(result.cues.length, 2);
  assert(result.cues.every((cue) => cue.endMs - cue.startMs <= 4_000));
  assert.equal(result.cues.map((cue) => cue.text).join(" "), "안녕 반가워");
  assert(result.warnings.some((warning) => warning.code === "SPLIT_LONG_CUE"));
});

test("Solar는 json_schema와 json_object가 모두 미지원이면 response_format 없는 JSON 요청으로 폴백한다", async () => {
  const request = normalizedCaptionRequest({
    clip: {
      id: "gateway-clip-1",
      title: "",
      durationMs: 4_000
    }
  });
  const transcript = {
    text: "뭐야",
    segments: [{ startMs: 100, endMs: 900, text: "뭐야" }],
    words: []
  };
  const bodies = [];
  const fetchImpl = async (url, init) => {
    assert.equal(String(url), UPSTAGE_CHAT_COMPLETIONS_URL);
    const body = JSON.parse(init.body);
    bodies.push(body);
    if (bodies.length === 1) {
      return jsonResponse({
        error: { message: "invalid response_format: json_schema" }
      }, 422);
    }
    if (bodies.length === 2) {
      return jsonResponse({
        error: { message: "json_object response format is not supported" }
      }, 400);
    }
    return jsonResponse({
      choices: [{
        message: {
          content: "```json\n{\"cues\":[{\"startMs\":100,\"endMs\":900,\"text\":\"뭐야?.\",\"speakerId\":\"main\",\"reviewRequired\":false,\"placement\":\"bottom\"}]}\n```"
        }
      }]
    });
  };

  const result = await requestSolarCaptions(request, transcript, {
    fetchImpl,
    upstageApiKey: "test-upstage-key",
    solarModel: "solar-pro3"
  });
  assert.equal(bodies.length, 3);
  assert.equal(bodies[0].response_format.type, "json_schema");
  assert.equal(bodies[1].response_format.type, "json_object");
  assert.equal(Object.hasOwn(bodies[2], "response_format"), false);
  assert.equal(result.cues[0].text, "뭐야?");
});

test("Solar가 발화를 비우거나 잘못된 JSON을 주면 다음 안전한 응답 형식으로 재시도한다", async () => {
  const request = normalizedCaptionRequest({
    clip: {
      id: "gateway-clip-1",
      title: "",
      durationMs: 4_000
    }
  });
  const transcript = {
    text: "안 들렸어?",
    segments: [{ startMs: 100, endMs: 1_100, text: "안 들렸어?" }],
    words: []
  };
  let callCount = 0;
  const result = await requestSolarCaptions(request, transcript, {
    fetchImpl: async () => {
      callCount += 1;
      if (callCount === 1) {
        return jsonResponse({
          choices: [{ message: { content: "{\"cues\":[]}" } }]
        });
      }
      return jsonResponse({
        choices: [{
          message: {
            content: JSON.stringify({
              cues: [{
                startMs: 100,
                endMs: 1_100,
                text: "안 들렸어?",
                speakerId: "main",
                reviewRequired: false,
                placement: "bottom"
              }]
            })
          }
        }]
      });
    },
    upstageApiKey: "test-upstage-key",
    solarModel: "solar-pro3"
  });
  assert.equal(callCount, 2);
  assert.equal(result.cues[0].text, "안 들렸어?");
});

test("외부 STT가 인식한 발화가 전혀 없으면 Solar 호출 없이 검수 경고를 반환한다", async () => {
  const config = resolveCaptionPipelineConfig(TEST_ENV);
  let fetchCount = 0;
  const result = await runCaptionPipeline(captionRequest(), {
    fetchImpl: async (url) => {
      fetchCount += 1;
      assert.equal(String(url), TEST_ENV.KIRINUKI_STT_ENDPOINT);
      return jsonResponse({ text: "", segments: [], words: [] });
    },
    ...config
  });
  assert.equal(fetchCount, 1);
  assert.deepEqual(result.cues, []);
  assert.deepEqual(result.warnings, [{
    code: "NO_RECOGNIZABLE_SPEECH",
    cueIndex: 0
  }]);
});

test("외부 STT 실패 본문과 전사 내용은 안전한 오류에 포함하지 않는다", async () => {
  const secretBody = "do-not-log-secret transcript";
  await assert.rejects(
    requestExternalStt(normalizedCaptionRequest(), {
      fetchImpl: async () => jsonResponse({
        error: { message: secretBody }
      }, 500),
      sttEndpoint: TEST_ENV.KIRINUKI_STT_ENDPOINT,
      sttApiKey: TEST_ENV.KIRINUKI_STT_API_KEY,
      sttModel: TEST_ENV.KIRINUKI_STT_MODEL,
      maxAudioBytes: 1_048_576
    }),
    (error) => (
      error.code === "STT_REQUEST_FAILED"
      && !error.message.includes(secretBody)
      && !JSON.stringify(error).includes(secretBody)
    )
  );
});

test("외부 제공자의 과대 응답은 본문을 버퍼링하기 전에 거부한다", async () => {
  await assert.rejects(
    requestExternalStt(normalizedCaptionRequest(), {
      fetchImpl: async () => new Response("{}", {
        status: 200,
        headers: {
          "content-type": "application/json",
          "content-length": String(17 * 1024 * 1024)
        }
      }),
      sttEndpoint: TEST_ENV.KIRINUKI_STT_ENDPOINT,
      sttApiKey: TEST_ENV.KIRINUKI_STT_API_KEY,
      sttModel: TEST_ENV.KIRINUKI_STT_MODEL,
      maxAudioBytes: 1_048_576
    }),
    (error) => error?.code === "PROVIDER_RESPONSE_TOO_LARGE"
  );
});

function localHttpJson({
  port,
  method,
  path = "/v1/captions",
  headers = {},
  body
}) {
  return new Promise((resolve, reject) => {
    const encodedBody = body === undefined ? null : JSON.stringify(body);
    const request = httpRequest({
      host: "127.0.0.1",
      port,
      method,
      path,
      headers: {
        ...headers,
        ...(encodedBody ? {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(encodedBody)
        } : {})
      }
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({
          status: response.statusCode,
          headers: response.headers,
          body: text ? JSON.parse(text) : null
        });
      });
    });
    request.on("error", reject);
    if (encodedBody) {
      request.end(encodedBody);
    } else {
      request.end();
    }
  });
}

test("HTTP 게이트웨이는 exact CORS·Bearer를 적용하고 인증된 GET 연결 확인을 외부 호출 없이 제공한다", async (t) => {
  const pipelineCalls = [];
  const { server } = createSolarCaptionGatewayServer({
    env: TEST_ENV,
    fetchImpl: async () => {
      throw new Error("GET capability must not call external fetch");
    },
    pipelineRunner: async (body) => {
      pipelineCalls.push(body);
      return {
        schema: CAPTION_AGENT_RESPONSE_SCHEMA_ID,
        requestId: body.requestId || "stub",
        clipId: body.clipId || "stub",
        language: "ko",
        sttModel: "remote-korean-stt",
        captionModel: "solar-pro3",
        cues: [],
        warnings: []
      };
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();

  const preflight = await localHttpJson({
    port,
    method: "OPTIONS",
    headers: { origin: ALLOWED_ORIGIN }
  });
  assert.equal(preflight.status, 204);
  assert.equal(
    preflight.headers["access-control-allow-origin"],
    ALLOWED_ORIGIN
  );
  assert.match(
    preflight.headers["access-control-allow-methods"],
    /GET, POST, OPTIONS/u
  );

  const unauthenticated = await localHttpJson({
    port,
    method: "GET",
    headers: { origin: ALLOWED_ORIGIN }
  });
  assert.equal(unauthenticated.status, 401);

  const rejectedOrigin = await localHttpJson({
    port,
    method: "GET",
    headers: {
      origin: `${ALLOWED_ORIGIN}.evil`,
      authorization: `Bearer ${AGENT_TOKEN}`
    }
  });
  assert.equal(rejectedOrigin.status, 403);
  assert.equal(
    rejectedOrigin.headers["access-control-allow-origin"],
    undefined
  );

  const capability = await localHttpJson({
    port,
    method: "GET",
    headers: {
      origin: ALLOWED_ORIGIN,
      authorization: `Bearer ${AGENT_TOKEN}`
    }
  });
  assert.equal(capability.status, 200);
  assert.equal(
    capability.headers["access-control-allow-origin"],
    ALLOWED_ORIGIN
  );
  assert.deepEqual(capability.body, {
    schema: CAPTION_AGENT_CAPABILITY_SCHEMA_ID,
    status: "ok",
    provider: "upstage",
    models: {
      stt: "remote-korean-stt",
      captions: "solar-pro3"
    },
    model: "solar-pro3",
    defaultModel: "solar-pro3",
    requestSchema: CAPTION_AGENT_REQUEST_SCHEMA_ID,
    responseSchema: CAPTION_AGENT_RESPONSE_SCHEMA_ID,
    maxCueDurationMs: 4_000,
    maxClipDurationMs: 30 * 60 * 1_000,
    maxAudioBytes: 1_048_576,
    pipelineTimeoutMs: 15 * 60 * 1_000
  });
  assert.equal(pipelineCalls.length, 0);

  const post = await localHttpJson({
    port,
    method: "POST",
    headers: {
      origin: ALLOWED_ORIGIN,
      authorization: `Bearer ${AGENT_TOKEN}`
    },
    body: captionRequest()
  });
  assert.equal(post.status, 200);
  assert.equal(post.body.schema, CAPTION_AGENT_RESPONSE_SCHEMA_ID);
  assert.equal(pipelineCalls.length, 1);
});

test("Extension 클라이언트는 loopback 게이트웨이의 인증 응답과 동시 발화 cue를 끝까지 수신한다", async (t) => {
  const request = captionRequest({ requestId: "browser-gateway-integration" });
  const { server } = createSolarCaptionGatewayServer({
    env: TEST_ENV,
    pipelineRunner: async (body) => ({
      schema: CAPTION_AGENT_RESPONSE_SCHEMA_ID,
      requestId: body.requestId,
      clipId: body.clip.id,
      language: "ko",
      sttModel: "remote-korean-stt",
      captionModel: "solar-pro3",
      model: "solar-pro3",
      resolvedModel: "solar-pro3",
      provider: "upstage",
      status: "completed",
      cues: [
        {
          startMs: 100,
          endMs: 1_400,
          text: "메인 발화",
          speakerId: "main",
          reviewRequired: false,
          placement: "bottom"
        },
        {
          startMs: 800,
          endMs: 1_800,
          text: "동시 게스트 발화",
          speakerId: "guest",
          reviewRequired: true,
          placement: "top"
        }
      ],
      warnings: []
    })
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();

  const payload = await requestCaptionAgent({
    endpoint: `http://127.0.0.1:${port}/v1/captions`,
    token: AGENT_TOKEN,
    request,
    fetchImpl: (url, init = {}) => {
      const headers = new Headers(init.headers);
      headers.set("Origin", ALLOWED_ORIGIN);
      return fetch(url, { ...init, headers });
    }
  });
  const cues = normalizeCaptionAgentCues(
    payload.cues,
    request.clip.durationMs
  );

  assert.equal(payload.requestId, request.requestId);
  assert.deepEqual(
    cues.map((cue) => [
      cue.remoteMeta.speakerId,
      cue.remoteMeta.reviewRequired
    ]),
    [
      ["main", false],
      ["guest", true]
    ]
  );
  assert(cues[1].startOffsetMs < cues[0].endOffsetMs);
});

test("게이트웨이 설정은 wildcard Origin과 빠진 외부 provider 설정을 거절한다", () => {
  assert.throws(
    () => resolveCaptionGatewayConfig({
      ...TEST_ENV,
      KIRINUKI_ALLOWED_ORIGIN: "*"
    }),
    (error) => error.code === "INVALID_CONFIGURATION"
  );
  assert.throws(
    () => resolveCaptionPipelineConfig({
      ...TEST_ENV,
      UPSTAGE_API_KEY: ""
    }),
    (error) => error.code === "MISSING_CONFIGURATION"
  );
  assert.throws(
    () => resolveCaptionPipelineConfig({
      ...TEST_ENV,
      KIRINUKI_STT_ENDPOINT: "http://stt.example.com/v1/audio/transcriptions"
    }),
    (error) => error.code === "INVALID_CONFIGURATION"
  );
  assert.throws(
    () => resolveCaptionPipelineConfig({
      ...TEST_ENV,
      KIRINUKI_STT_ENDPOINT: "https://secret@stt.example.com/v1/audio/transcriptions"
    }),
    (error) => error.code === "INVALID_CONFIGURATION"
  );
  assert.equal(
    resolveCaptionPipelineConfig({
      ...TEST_ENV,
      KIRINUKI_STT_ENDPOINT: "http://127.0.0.1:4318/v1/audio/transcriptions"
    }).sttEndpoint,
    "http://127.0.0.1:4318/v1/audio/transcriptions"
  );
});

test("사용자가 자막 요청을 취소하면 외부 STT 요청 신호도 즉시 중단된다", async () => {
  const controller = new AbortController();
  let receivedSignal = null;
  const pending = requestExternalStt(normalizedCaptionRequest(), {
    fetchImpl: async (_url, init) => {
      receivedSignal = init.signal;
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          reject(init.signal.reason);
        }, { once: true });
      });
    },
    sttEndpoint: TEST_ENV.KIRINUKI_STT_ENDPOINT,
    sttApiKey: TEST_ENV.KIRINUKI_STT_API_KEY,
    sttModel: TEST_ENV.KIRINUKI_STT_MODEL,
    maxAudioBytes: 1_048_576,
    signal: controller.signal
  });
  controller.abort(new DOMException("테스트 취소", "AbortError"));
  await assert.rejects(pending, (error) => error?.name === "AbortError");
  assert.equal(receivedSignal?.aborted, true);
});

test("전체 파이프라인 deadline은 STT 이후 대기 중인 Solar 요청까지 중단한다", async () => {
  const config = resolveCaptionPipelineConfig(TEST_ENV);
  let fetchCount = 0;
  let solarSignal = null;
  const pending = runCaptionPipeline(captionRequest(), {
    fetchImpl: async (url, init) => {
      fetchCount += 1;
      if (String(url) === TEST_ENV.KIRINUKI_STT_ENDPOINT) {
        return jsonResponse({
          text: "안녕",
          segments: [{ start: 0.1, end: 0.9, text: "안녕" }],
          words: []
        });
      }
      assert.equal(String(url), UPSTAGE_CHAT_COMPLETIONS_URL);
      solarSignal = init.signal;
      return new Promise((_resolve, reject) => {
        const rejectAborted = () => reject(init.signal.reason);
        if (init.signal.aborted) {
          rejectAborted();
          return;
        }
        init.signal.addEventListener("abort", rejectAborted, { once: true });
      });
    },
    ...config,
    pipelineTimeoutMs: 20
  });

  await assert.rejects(
    pending,
    (error) => error?.code === "PIPELINE_TIMEOUT" && error.httpStatus === 504
  );
  assert.equal(fetchCount, 2);
  assert.equal(solarSignal?.aborted, true);
});
