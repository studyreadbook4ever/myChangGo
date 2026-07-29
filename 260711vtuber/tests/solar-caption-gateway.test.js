import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import test from "node:test";

import {
  CAPTION_AGENT_REQUEST_SCHEMA_ID,
  CAPTION_AGENT_RESPONSE_SCHEMA_ID,
  validateCaptionAgentRequest
} from "../src/caption-agent/protocol.js";
import {
  CAPTION_HARNESS_FINGERPRINT,
  CAPTION_QUALITY_PROFILE_ID
} from "../src/caption-agent/caption-quality-harness.js";
import {
  captionEditorialContextFingerprint
} from "../src/caption-agent/editorial-context.js";
import {
  DEFAULT_PIPELINE_TIMEOUT_MS,
  DEFAULT_SOLAR_MODEL,
  LOCAL_WHISPERCPP_TRANSCRIPTION_MODE,
  MAX_SOLAR_PROMPT_BYTES,
  MAX_STT_SEGMENTS,
  MAX_STT_WORDS,
  SOLAR_PRO3_HIGH_REASONING_MIN_TOKENS,
  UPSTAGE_CHAT_COMPLETIONS_URL,
  normalizeSolarCaptionModel,
  normalizeSttTranscript,
  requestExternalStt,
  requestSolarCaptions,
  resolveCaptionPipelineConfig,
  resolveCaptionPipelineRequestConfig,
  runCaptionPipeline
} from "../src/caption-agent/solar-gateway-core.js";
import {
  normalizeCaptionAgentCues,
  requestCaptionAgent
} from "../src/editor/caption-agent.js";
import {
  CAPTION_AGENT_CAPABILITY_SCHEMA_ID,
  CAPTION_AGENT_HEALTH_SCHEMA_ID,
  CAPTION_AGENT_SESSION_SCHEMA_ID,
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

test("local-whispercpp 모드는 loopback STT에 가짜 API 키를 요구하지 않는다", async () => {
  const config = resolveCaptionPipelineConfig({
    ...TEST_ENV,
    KIRINUKI_STT_MODE: LOCAL_WHISPERCPP_TRANSCRIPTION_MODE,
    KIRINUKI_STT_ENDPOINT:
      "http://127.0.0.1:4318/v1/audio/transcriptions",
    KIRINUKI_STT_API_KEY: ""
  });
  const requestConfig = resolveCaptionPipelineRequestConfig(config, {});
  assert.equal(
    requestConfig.transcriptionMode,
    LOCAL_WHISPERCPP_TRANSCRIPTION_MODE
  );
  assert.equal(requestConfig.sttApiKey, "");

  let receivedAuthorization = "not-called";
  await requestExternalStt(normalizedCaptionRequest(), {
    ...requestConfig,
    fetchImpl: async (_url, init) => {
      receivedAuthorization = init.headers.authorization;
      return jsonResponse({
        text: "로컬 전사",
        segments: [{ start: 0.1, end: 0.8, text: "로컬 전사" }]
      });
    },
    wavBytes: Buffer.from(testWavBase64(), "base64")
  });
  assert.equal(receivedAuthorization, undefined);

  assert.throws(
    () => resolveCaptionPipelineRequestConfig(config, {
      sttEndpoint: "https://stt.example/v1/audio/transcriptions"
    }),
    (error) => error?.code === "STT_PROVIDER_PAIR_REQUIRED"
  );
});

test("외부 STT 배열 개수와 Solar 전사 프롬프트 크기를 처리 전에 제한한다", () => {
  assert.throws(
    () => normalizeSttTranscript({
      text: "시간 정보 없는 전사문"
    }, {
      clipDurationMs: 8_000
    }),
    (error) => (
      error?.code === "TIMED_TRANSCRIPT_REQUIRED"
      && error?.httpStatus === 502
    )
  );
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
      text: "가".repeat(MAX_SOLAR_PROMPT_BYTES),
      segments: [{ start: 0, end: 1, text: "가" }]
    }, {
      clipDurationMs: 8_000
    }),
    (error) => error?.code === "STT_TRANSCRIPT_TOO_LARGE"
  );
});

test("파이프라인은 base64 WAV를 STT에만 보내고 Solar에는 중복 없는 timed unit을 한 번 보낸다", async () => {
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
    assert.equal(body.reasoning_effort, "high");
    assert.equal(body.max_tokens, SOLAR_PRO3_HIGH_REASONING_MIN_TOKENS);
    assert.equal(body.messages[1].content.includes(rawAudio), false);
    const solarInput = JSON.parse(body.messages[1].content);
    assert.deepEqual(
      solarInput.visualPlacement.samples,
      captionRequest().visual.samples
    );
    assert.deepEqual(solarInput.timedUnits, [
      {
        startMs: 100,
        endMs: 5_200,
        text: "안녕 반가워",
        speakerId: "main",
        wordAnchors: [[100, 1_000], [4_200, 5_200]]
      }
    ]);
    assert.equal(Object.hasOwn(solarInput, "transcript"), false);
    assert.equal(body.messages[1].content.includes("base64"), false);
    assert.equal(body.response_format.type, "json_schema");
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
  assert.equal(calls.length, 2);
  assert.equal(result.schema, CAPTION_AGENT_RESPONSE_SCHEMA_ID);
  assert.equal(result.sttModel, "remote-korean-stt");
  assert.equal(result.captionModel, "solar-pro3");
  assert.equal(result.cues.length, 2);
  assert(result.cues.every((cue) => cue.endMs - cue.startMs <= 4_000));
  assert.equal(result.cues.map((cue) => cue.text).join(" "), "안녕 반가워");
  assert(result.warnings.some((warning) => warning.code === "SPLIT_LONG_CUE"));
});

test("전사와 어긋난 Solar 결과는 추가 호출 없이 cue별 review gate로 전달한다", async () => {
  const request = normalizedCaptionRequest({
    clip: {
      id: "quality-review-clip",
      title: "",
      durationMs: 3_000
    }
  });
  let solarCalls = 0;
  const result = await requestSolarCaptions(request, {
    text: "안녕",
    segments: [{ startMs: 100, endMs: 1_200, text: "안녕" }],
    words: [{ startMs: 100, endMs: 1_200, text: "안녕" }]
  }, {
    upstageApiKey: "fake-upstage-key",
    fetchImpl: async () => {
      solarCalls += 1;
      return jsonResponse({
        model: "solar-pro3",
        choices: [{
          finish_reason: "stop",
          message: {
            content: JSON.stringify({
              cues: [{
                startMs: 100,
                endMs: 1_200,
                text: "오늘 날씨가 정말 좋네요",
                speakerId: "main",
                reviewRequired: false,
                placement: "bottom"
              }]
            })
          }
        }]
      });
    }
  });

  assert.equal(solarCalls, 1);
  assert.equal(result.qualityReport.valid, false);
  assert.equal(result.qualityReport.disposition, "review-required");
  assert.deepEqual(result.cues[0].quality, {
    status: "review-required",
    codes: [
      "HARNESS_TRANSCRIPT_COVERAGE_LOW",
      "HARNESS_TRANSCRIPT_PRECISION_LOW"
    ]
  });
  assert.equal(result.cues[0].reviewRequired, true);
});

test("동시 cue가 화자 alias 정규화로 재정렬돼도 전사 review는 해당 cue에 유지된다", async () => {
  const request = normalizedCaptionRequest({
    clip: {
      id: "quality-review-stable-identity",
      title: "",
      durationMs: 3_000
    },
    editorialContext: {
      schema: "kr-vtuber-editorial-context/v1",
      glossary: [],
      speakers: [{
        id: "main",
        aliases: ["main", "z-main"]
      }, {
        id: "z-speaker",
        aliases: ["z-speaker", "a-guest"]
      }],
      style: {
        terminalPeriod: "omit",
        placement: "bottom",
        maxWidthUnits: 20,
        examples: []
      }
    }
  });
  let solarCalls = 0;
  const result = await requestSolarCaptions(request, {
    text: "안녕 반가워",
    segments: [{
      startMs: 100,
      endMs: 1_200,
      text: "안녕"
    }, {
      startMs: 1_800,
      endMs: 2_600,
      text: "반가워"
    }],
    words: [{
      startMs: 100,
      endMs: 1_200,
      text: "안녕"
    }, {
      startMs: 1_800,
      endMs: 2_600,
      text: "반가워"
    }]
  }, {
    upstageApiKey: "fake-upstage-key",
    fetchImpl: async () => {
      solarCalls += 1;
      return jsonResponse({
        model: "solar-pro3",
        choices: [{
          finish_reason: "stop",
          message: {
            content: JSON.stringify({
              cues: [{
                startMs: 100,
                endMs: 1_200,
                text: "날씨가 좋네요",
                speakerId: "a-guest",
                reviewRequired: false,
                placement: "bottom"
              }, {
                startMs: 100,
                endMs: 1_200,
                text: "안녕",
                speakerId: "z-main",
                reviewRequired: false,
                placement: "bottom"
              }]
            })
          }
        }]
      });
    }
  });

  assert.equal(solarCalls, 1);
  assert.deepEqual(
    result.cues.map(({ text, speakerId }) => ({ text, speakerId })),
    [{
      text: "안녕",
      speakerId: "main"
    }, {
      text: "날씨가 좋네요",
      speakerId: "z-speaker"
    }]
  );
  assert.deepEqual(result.cues[0].quality, {
    status: "accepted",
    codes: []
  });
  assert.equal(result.cues[0].reviewRequired, false);
  assert.deepEqual(result.cues[1].quality, {
    status: "review-required",
    codes: [
      "HARNESS_TRANSCRIPT_COVERAGE_LOW",
      "HARNESS_TRANSCRIPT_PRECISION_LOW"
    ]
  });
  assert.equal(result.cues[1].reviewRequired, true);
  assert.deepEqual(
    result.qualityReport.cueReviews.map(
      ({ cueIndex, status, codes }) => ({ cueIndex, status, codes })
    ),
    [{
      cueIndex: 0,
      status: "accepted",
      codes: []
    }, {
      cueIndex: 1,
      status: "review-required",
      codes: [
        "HARNESS_TRANSCRIPT_COVERAGE_LOW",
        "HARNESS_TRANSCRIPT_PRECISION_LOW"
      ]
    }]
  );
});

test("Solar JSON 형식이 미지원이어도 승인 없는 유료 폴백 호출은 하지 않는다", async () => {
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
    return jsonResponse({
      error: { message: "invalid response_format: json_schema" }
    }, 422);
  };

  await assert.rejects(
    () => requestSolarCaptions(request, transcript, {
      fetchImpl,
      upstageApiKey: "test-upstage-key",
      solarModel: "solar-pro3"
    }),
    (error) => error?.code === "SOLAR_RESPONSE_FORMAT_UNSUPPORTED"
  );
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].response_format.type, "json_schema");
});

test("확인된 Solar 응답 형식은 프로세스 메모리에 캐시하고 매 컷 한 번만 호출한다", async () => {
  const request = normalizedCaptionRequest({
    clip: {
      id: "gateway-clip-cache",
      title: "",
      durationMs: 4_000
    }
  });
  const transcript = {
    text: "캐시 테스트",
    segments: [{ startMs: 100, endMs: 900, text: "캐시 테스트" }],
    words: []
  };
  const responseFormatCache = new Map();
  const attemptedFormats = [];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    attemptedFormats.push(body.response_format?.type || "plain");
    return jsonResponse({
      choices: [{
        message: {
          content: JSON.stringify({
            cues: [{
              startMs: 100,
              endMs: 900,
              text: "캐시 테스트",
              speakerId: "main",
              reviewRequired: false,
              placement: "bottom"
            }]
          })
        }
      }]
    });
  };

  await requestSolarCaptions(request, transcript, {
    fetchImpl,
    upstageApiKey: "test-upstage-key",
    responseFormatCache
  });
  await requestSolarCaptions(request, transcript, {
    fetchImpl,
    upstageApiKey: "test-upstage-key",
    responseFormatCache
  });

  assert.deepEqual(attemptedFormats, [
    "json_schema",
    "json_schema"
  ]);
  assert.equal(responseFormatCache.get("solar-pro3"), "json_schema");
});

test("Solar Mini 선택은 실제 Upstage 모델까지 관통하고 Pro 3 전용 reasoning 필드를 보내지 않는다", async () => {
  const request = captionRequest({ model: "solar-mini" });
  const rawAudio = request.audio.data;
  let transcribeCalls = 0;
  let solarCalls = 0;
  const result = await runCaptionPipeline(request, {
    upstageApiKey: "test-upstage-key",
    sttModel: "local-deterministic-test",
    transcribeAudio: async (validatedRequest, transcriberOptions) => {
      transcribeCalls += 1;
      assert.equal(validatedRequest.model, "solar-mini");
      assert.equal(validatedRequest.wavBase64, rawAudio);
      assert.equal(
        Object.hasOwn(transcriberOptions, "upstageApiKey"),
        false
      );
      assert(Buffer.isBuffer(transcriberOptions.wavBytes));
      return {
        text: "빠른 초벌",
        segments: [{
          startMs: 100,
          endMs: 1_200,
          text: "빠른 초벌"
        }],
        words: []
      };
    },
    fetchImpl: async (url, init) => {
      solarCalls += 1;
      assert.equal(String(url), UPSTAGE_CHAT_COMPLETIONS_URL);
      const body = JSON.parse(init.body);
      assert.equal(body.model, "solar-mini");
      assert.equal(Object.hasOwn(body, "reasoning_effort"), false);
      assert.equal(body.messages[1].content.includes(rawAudio), false);
      return jsonResponse({
        model: "solar-mini-250422",
        choices: [{
          message: {
            content: JSON.stringify({
              cues: [{
                startMs: 100,
                endMs: 1_200,
                text: "빠른 초벌",
                speakerId: "main",
                reviewRequired: false,
                placement: "bottom"
              }]
            })
          }
        }]
      });
    }
  });

  assert.equal(transcribeCalls, 1);
  assert.equal(solarCalls, 1);
  assert.equal(result.sttModel, "local-deterministic-test");
  assert.equal(result.captionModel, "solar-mini");
  assert.equal(result.resolvedModel, "solar-mini-250422");
});

test("새 자막 모델 계약은 Solar Pro 3와 Solar Mini만 허용한다", () => {
  assert.equal(normalizeSolarCaptionModel("solar-pro3"), "solar-pro3");
  assert.equal(normalizeSolarCaptionModel("solar-mini"), "solar-mini");
  assert.throws(
    () => normalizeSolarCaptionModel("solar-pro2"),
    (error) => error?.code === "UNSUPPORTED_SOLAR_MODEL"
  );
  assert.throws(
    () => resolveCaptionPipelineConfig({
      ...TEST_ENV,
      KIRINUKI_SOLAR_MODEL: "made-up-audio-solar"
    }),
    (error) => error?.code === "UNSUPPORTED_SOLAR_MODEL"
  );
});

test("Solar가 발화를 비우면 자동 유료 재시도 없이 안전하게 실패한다", async () => {
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
  await assert.rejects(() => requestSolarCaptions(request, transcript, {
    fetchImpl: async () => {
      callCount += 1;
      return jsonResponse({
        choices: [{ message: { content: "{\"cues\":[]}" } }]
      });
    },
    upstageApiKey: "test-upstage-key",
    solarModel: "solar-pro3"
  }), (error) => error?.code === "EMPTY_SOLAR_CAPTIONS");
  assert.equal(callCount, 1);
});

test("Solar가 길이 제한 등으로 중단한 부분 JSON은 완료 자막으로 받지 않는다", async () => {
  const request = normalizedCaptionRequest({
    clip: {
      id: "gateway-clip-1",
      title: "",
      durationMs: 4_000
    }
  });
  let callCount = 0;
  await assert.rejects(
    requestSolarCaptions(request, {
      text: "앞 문장 뒤 문장",
      segments: [{
        startMs: 100,
        endMs: 3_000,
        text: "앞 문장 뒤 문장"
      }],
      words: []
    }, {
      fetchImpl: async () => {
        callCount += 1;
        return jsonResponse({
          choices: [{
            finish_reason: "length",
            message: {
              content: JSON.stringify({
                cues: [{
                  startMs: 100,
                  endMs: 900,
                  text: "앞 문장",
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
    }),
    (error) => error?.code === "INCOMPLETE_SOLAR_RESPONSE"
  );
  assert.equal(callCount, 1);
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

test("managed 게이트웨이는 exact Extension Origin에만 메모리 세션을 자동 발급한다", async (t) => {
  const env = {
    ...TEST_ENV,
    KIRINUKI_AGENT_TOKEN: "",
    KIRINUKI_AUTO_PAIR: "1"
  };
  const { server, config } = createSolarCaptionGatewayServer({
    env,
    randomBytesImpl: () => Buffer.alloc(32, 7)
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();

  for (let index = 0; index < 16; index += 1) {
    const health = await localHttpJson({
      port,
      method: "GET",
      path: "/v1/health",
      headers: {
        origin: ALLOWED_ORIGIN,
        "x-kirinuki-protocol": CAPTION_AGENT_REQUEST_SCHEMA_ID
      }
    });
    assert.equal(health.status, 200);
    assert.deepEqual(health.body, {
      schema: CAPTION_AGENT_HEALTH_SCHEMA_ID,
      status: "ok",
      managed: true,
      originBinding: "exact-extension",
      transcriptionMode: "external-timed-stt"
    });
  }

  const missingOrigin = await localHttpJson({
    port,
    method: "POST",
    path: "/v1/session",
    headers: {
      "x-kirinuki-protocol": CAPTION_AGENT_REQUEST_SCHEMA_ID
    }
  });
  assert.equal(missingOrigin.status, 403);

  const wrongProtocol = await localHttpJson({
    port,
    method: "POST",
    path: "/v1/session",
    headers: {
      origin: ALLOWED_ORIGIN,
      "x-kirinuki-protocol": "unknown"
    }
  });
  assert.equal(wrongProtocol.status, 400);

  const paired = await localHttpJson({
    port,
    method: "POST",
    path: "/v1/session",
    headers: {
      origin: ALLOWED_ORIGIN,
      "x-kirinuki-protocol": CAPTION_AGENT_REQUEST_SCHEMA_ID
    }
  });
  assert.equal(paired.status, 200);
  assert.deepEqual(paired.body, {
    schema: CAPTION_AGENT_SESSION_SCHEMA_ID,
    status: "ok",
    authentication: "bearer-process-memory",
    expires: "companion-restart",
    token: config.agentToken
  });
  assert.equal(config.agentToken, Buffer.alloc(32, 7).toString("base64url"));
  assert.equal(paired.headers["cache-control"], "no-store");

  const capability = await localHttpJson({
    port,
    method: "GET",
    headers: {
      origin: ALLOWED_ORIGIN,
      authorization: `Bearer ${paired.body.token}`
    }
  });
  assert.equal(capability.status, 200);
  assert.equal(JSON.stringify(capability.body).includes(paired.body.token), false);
});

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
  assert.match(
    preflight.headers["access-control-allow-headers"],
    /X-Kirinuki-Upstage-API-Key/iu
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
    availableModels: ["solar-pro3", "solar-mini"],
    transcription: {
      mode: "external-timed-stt",
      solarInput: "text-only",
      requiresTimedTranscript: true,
      authentication: "bearer",
      ready: true
    },
    requestSchema: CAPTION_AGENT_REQUEST_SCHEMA_ID,
    responseSchema: CAPTION_AGENT_RESPONSE_SCHEMA_ID,
    qualityHarness: {
      profile: "kr-vtuber-clean-v1",
      automaticBodyLines: 1,
      placement: "bottom",
      paidRepairCalls: 0
    },
    maxSolarCallsPerClip: 1,
    maxCueDurationMs: 4_000,
    maxClipDurationMs: 30 * 60 * 1_000,
    maxAudioBytes: 1_048_576,
    pipelineTimeoutMs: DEFAULT_PIPELINE_TIMEOUT_MS,
    configured: {
      sttEndpoint: true,
      sttApiKey: true,
      upstageApiKey: true,
      ready: true
    }
  });
  assert.equal(pipelineCalls.length, 0);

  const endpointOnlyOverride = await localHttpJson({
    port,
    method: "POST",
    headers: {
      origin: ALLOWED_ORIGIN,
      authorization: `Bearer ${AGENT_TOKEN}`,
      "x-kirinuki-stt-endpoint":
        "https://untrusted-stt.example/v1/audio/transcriptions"
    },
    body: captionRequest()
  });
  assert.equal(endpointOnlyOverride.status, 400);
  assert.equal(
    endpointOnlyOverride.body.error.code,
    "STT_PROVIDER_PAIR_REQUIRED"
  );
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

test("브라우저에서 입력한 STT·Upstage 키는 요청 단위로 환경 설정을 안전하게 보완한다", async (t) => {
  const runtimeEnv = {
    KIRINUKI_AGENT_TOKEN: AGENT_TOKEN,
    KIRINUKI_ALLOWED_ORIGIN: ALLOWED_ORIGIN,
    KIRINUKI_MAX_AUDIO_BYTES: "1048576",
    KIRINUKI_SOLAR_MODEL: "solar-pro3"
  };
  const pipelineCalls = [];
  const { server } = createSolarCaptionGatewayServer({
    env: runtimeEnv,
    pipelineRunner: async (body, options) => {
      pipelineCalls.push({ body, options });
      return {
        schema: CAPTION_AGENT_RESPONSE_SCHEMA_ID,
        requestId: body.requestId,
        clipId: body.clip.id,
        language: "ko",
        sttModel: options.sttModel,
        captionModel: "solar-pro3",
        model: "solar-pro3",
        resolvedModel: "solar-pro3",
        provider: "upstage",
        status: "completed",
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
  const authHeaders = {
    origin: ALLOWED_ORIGIN,
    authorization: `Bearer ${AGENT_TOKEN}`
  };

  const incomplete = await localHttpJson({
    port,
    method: "GET",
    headers: authHeaders
  });
  assert.equal(incomplete.status, 200);
  assert.deepEqual(incomplete.body.configured, {
    sttEndpoint: false,
    sttApiKey: false,
    upstageApiKey: false,
    ready: false
  });

  const upstageOnlyHeaders = {
    ...authHeaders,
    "x-kirinuki-upstage-api-key": "runtime-upstage-secret"
  };
  const upstageOnly = await localHttpJson({
    port,
    method: "GET",
    headers: upstageOnlyHeaders
  });
  assert.deepEqual(upstageOnly.body.configured, {
    sttEndpoint: false,
    sttApiKey: false,
    upstageApiKey: true,
    ready: false
  });
  assert.equal(upstageOnly.body.transcription.ready, false);

  const upstageOnlyPost = await localHttpJson({
    port,
    method: "POST",
    headers: upstageOnlyHeaders,
    body: captionRequest()
  });
  assert.equal(upstageOnlyPost.status, 400);
  assert.equal(
    upstageOnlyPost.body.error.code,
    "TIMED_STT_REQUIRED"
  );
  assert.equal(pipelineCalls.length, 0);

  const missingPost = await localHttpJson({
    port,
    method: "POST",
    headers: authHeaders,
    body: captionRequest()
  });
  assert.equal(missingPost.status, 400);
  assert.equal(missingPost.body.error.code, "TIMED_STT_REQUIRED");
  assert.match(missingPost.body.error.message, /직접 전사하지 않습니다/u);
  assert.equal(pipelineCalls.length, 0);

  const providerHeaders = {
    ...authHeaders,
    "x-kirinuki-stt-endpoint": "https://stt.runtime.example/v1/audio/transcriptions",
    "x-kirinuki-stt-model": "runtime-timestamp-model",
    "x-kirinuki-stt-api-key": "runtime-stt-secret",
    "x-kirinuki-upstage-api-key": "runtime-upstage-secret"
  };
  const ready = await localHttpJson({
    port,
    method: "GET",
    headers: providerHeaders
  });
  assert.equal(ready.status, 200);
  assert.equal(ready.body.configured.ready, true);

  const completed = await localHttpJson({
    port,
    method: "POST",
    headers: providerHeaders,
    body: captionRequest({ requestId: "runtime-keys-request" })
  });
  assert.equal(completed.status, 200);
  assert.equal(pipelineCalls.length, 1);
  assert.equal(
    pipelineCalls[0].options.sttEndpoint,
    "https://stt.runtime.example/v1/audio/transcriptions"
  );
  assert.equal(
    pipelineCalls[0].options.sttModel,
    "runtime-timestamp-model"
  );
  assert.equal(
    pipelineCalls[0].options.sttApiKey,
    "runtime-stt-secret"
  );
  assert.equal(
    pipelineCalls[0].options.upstageApiKey,
    "runtime-upstage-secret"
  );

  const invalidEndpoint = await localHttpJson({
    port,
    method: "POST",
    headers: {
      ...providerHeaders,
      "x-kirinuki-stt-endpoint": "http://remote.example/transcriptions"
    },
    body: captionRequest()
  });
  assert.equal(invalidEndpoint.status, 400);
  assert.equal(invalidEndpoint.body.error.code, "INVALID_CONFIGURATION");
  assert.equal(pipelineCalls.length, 1);

  const queryEndpoint = await localHttpJson({
    port,
    method: "POST",
    headers: {
      ...providerHeaders,
      "x-kirinuki-stt-endpoint":
        "https://stt.runtime.example/v1/audio/transcriptions?key=secret"
    },
    body: captionRequest()
  });
  assert.equal(queryEndpoint.status, 400);
  assert.equal(queryEndpoint.body.error.code, "INVALID_CONFIGURATION");
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
      warnings: [],
      qualityProfile: CAPTION_QUALITY_PROFILE_ID,
      harnessFingerprint: CAPTION_HARNESS_FINGERPRINT,
      editorialContextFingerprint: captionEditorialContextFingerprint(
        body.editorialContext
      ),
      qualityReport: {
        profileId: CAPTION_QUALITY_PROFILE_ID,
        harnessFingerprint: CAPTION_HARNESS_FINGERPRINT,
        valid: true,
        disposition: "review-required",
        violations: [],
        cueReviews: [{
          cueIndex: 0,
          status: "accepted",
          codes: [],
          metrics: {}
        }, {
          cueIndex: 1,
          status: "review-required",
          codes: [],
          metrics: {}
        }],
        metrics: { cueCount: 2 }
      }
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

test("STT 자체 deadline은 안전한 STT_TIMEOUT으로 번역하고 fetch를 중단한다", async () => {
  let receivedSignal = null;
  await assert.rejects(
    requestExternalStt(normalizedCaptionRequest(), {
      fetchImpl: async (_url, init) => {
        receivedSignal = init.signal;
        return new Promise((_resolve, reject) => {
          const rejectAborted = () => reject(init.signal.reason);
          if (init.signal.aborted) {
            rejectAborted();
            return;
          }
          init.signal.addEventListener("abort", rejectAborted, { once: true });
        });
      },
      sttEndpoint: TEST_ENV.KIRINUKI_STT_ENDPOINT,
      sttApiKey: TEST_ENV.KIRINUKI_STT_API_KEY,
      sttModel: TEST_ENV.KIRINUKI_STT_MODEL,
      maxAudioBytes: 1_048_576,
      timeoutMs: 20
    }),
    (error) => error?.code === "STT_TIMEOUT" && error.httpStatus === 504
  );
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
