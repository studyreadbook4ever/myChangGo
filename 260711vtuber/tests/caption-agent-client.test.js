import assert from "node:assert/strict";
import test from "node:test";

import {
  CAPTION_HARNESS_FINGERPRINT,
  CAPTION_QUALITY_PROFILE_ID
} from "../src/caption-agent/caption-quality-harness.js";
import {
  captionEditorialContextFingerprint
} from "../src/caption-agent/editorial-context.js";
import {
  CAPTION_AGENT_REQUEST_SCHEMA,
  CAPTION_AGENT_RESPONSE_SCHEMA,
  CAPTION_AGENT_SESSION_SCHEMA,
  MAX_CAPTION_AGENT_CLIPS_PER_RUN,
  MAX_CAPTION_AGENT_CLIP_DURATION_MS,
  MAX_CAPTION_AGENT_CUES_PER_RUN,
  MAX_REMOTE_WARNINGS,
  captionAgentAudioFootprint,
  captionAgentPermissionOrigin,
  captionAgentResumePlan,
  captionAgentRunEstimate,
  captionAgentSessionEndpoint,
  captionProviderHeaders,
  createCaptionAgentCheckpoint,
  createCaptionAgentRequest,
  discardCaptionAgentCheckpointsForClips,
  encodePcm16WavBase64,
  ensureCaptionAgentSession,
  normalizeCaptionAgentCues,
  normalizeCaptionAgentEndpoint,
  normalizeCaptionAgentSettings,
  normalizeExternalSttEndpoint,
  pairCaptionAgent,
  probeCaptionAgent,
  requestCaptionAgent,
  requestCaptionAgentWithSessionRetry,
  sameCaptionMediaIdentity,
  saveCaptionAgentSettings,
  upsertCaptionAgentCheckpoint
} from "../src/editor/caption-agent.js";

function jsonResponse(payload, {
  status = 200
} = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function agentRequest({
  requestId = "request-1",
  clipId = "clip-1",
  durationMs = 5_000
} = {}) {
  return {
    schema: CAPTION_AGENT_REQUEST_SCHEMA,
    requestId,
    clip: {
      id: clipId,
      durationMs
    }
  };
}

function completedAgentResponse(request, overrides = {}) {
  const qualityEnvelope = {
    qualityProfile: CAPTION_QUALITY_PROFILE_ID,
    harnessFingerprint: CAPTION_HARNESS_FINGERPRINT,
    editorialContextFingerprint: captionEditorialContextFingerprint(
      request.editorialContext
    ),
    qualityReport: {
      profileId: CAPTION_QUALITY_PROFILE_ID,
      harnessFingerprint: CAPTION_HARNESS_FINGERPRINT,
      valid: true,
      disposition: "accepted",
      violations: [],
      cueReviews: [],
      metrics: {}
    }
  };
  return {
    schema: CAPTION_AGENT_RESPONSE_SCHEMA,
    requestId: request.requestId,
    clipId: request.clip.id,
    language: "ko",
    sttModel: "external-stt",
    captionModel: "solar-pro3",
    model: "solar-pro3",
    resolvedModel: "solar-pro3",
    provider: "upstage",
    status: "completed",
    cues: [],
    warnings: [],
    ...qualityEnvelope,
    ...overrides
  };
}

test("에이전트 주소는 HTTPS 또는 loopback HTTP만 허용하고 인증정보를 거부한다", () => {
  assert.equal(
    normalizeCaptionAgentEndpoint("http://127.0.0.1:4319/v1/captions"),
    "http://127.0.0.1:4319/v1/captions"
  );
  assert.equal(
    normalizeCaptionAgentEndpoint("https://captions.example/v1/captions"),
    "https://captions.example/v1/captions"
  );
  assert.equal(
    captionAgentPermissionOrigin("https://captions.example:8443/v1/captions"),
    "https://captions.example/*"
  );
  assert.throws(
    () => normalizeCaptionAgentEndpoint("http://captions.example/v1/captions"),
    /HTTPS/u
  );
  assert.throws(
    () => normalizeCaptionAgentEndpoint("https://user:secret@captions.example/v1/captions"),
    /아이디나 비밀번호/u
  );
  assert.throws(
    () => normalizeCaptionAgentEndpoint(
      "https://captions.example/v1/captions?token=secret"
    ),
    /쿼리 문자열/u
  );
});

test("로컬 companion 세션 주소는 경로만 치환하고 저장될 쿼리를 거부한다", () => {
  assert.equal(
    captionAgentSessionEndpoint(
      "http://127.0.0.1:4319/custom/captions"
    ),
    "http://127.0.0.1:4319/v1/session"
  );
  assert.throws(
    () => captionAgentSessionEndpoint(
      "http://127.0.0.1:4319/custom/captions?token=secret"
    ),
    /쿼리 문자열/u
  );
  assert.throws(
    () => captionAgentSessionEndpoint(
      "https://captions.example/v1/captions"
    ),
    /로컬 companion/u
  );
});

test("자동 연결 토큰은 로컬 session 응답에서만 받아 호출자 메모리로 반환한다", async () => {
  const calls = [];
  const token = await pairCaptionAgent({
    endpoint: "http://127.0.0.1:4319/v1/captions",
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return jsonResponse({
        schema: CAPTION_AGENT_SESSION_SCHEMA,
        status: "ok",
        authentication: "bearer-process-memory",
        expires: "companion-restart",
        token: "ephemeral-local-session"
      });
    }
  });
  assert.equal(token, "ephemeral-local-session");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://127.0.0.1:4319/v1/session");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(
    calls[0].options.headers["X-Kirinuki-Protocol"],
    CAPTION_AGENT_REQUEST_SCHEMA
  );
  assert.equal(calls[0].options.credentials, "omit");
  assert.equal(calls[0].options.redirect, "error");
  assert.equal("Authorization" in calls[0].options.headers, false);
});

test("gateway 재시작으로 만료된 로컬 세션은 무과금 probe 뒤 자동으로 다시 연결한다", async () => {
  const calls = [];
  const token = await ensureCaptionAgentSession({
    endpoint: "http://127.0.0.1:4319/v1/captions",
    token: "stale-process-session",
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      if (calls.length === 1) {
        return jsonResponse({
          error: {
            code: "UNAUTHORIZED",
            message: "세션이 만료되었습니다."
          }
        }, { status: 401 });
      }
      return jsonResponse({
        schema: CAPTION_AGENT_SESSION_SCHEMA,
        status: "ok",
        authentication: "bearer-process-memory",
        expires: "companion-restart",
        token: "refreshed-process-session"
      });
    }
  });
  assert.equal(token, "refreshed-process-session");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.method, "GET");
  assert.equal(
    calls[0].options.headers.Authorization,
    "Bearer stale-process-session"
  );
  assert.equal(calls[1].url, "http://127.0.0.1:4319/v1/session");
  assert.equal(calls[1].options.method, "POST");
  assert.equal("Authorization" in calls[1].options.headers, false);
});

test("작업 중 만료된 로컬 세션은 한 번만 재발급해 같은 요청을 이어간다", async () => {
  const request = agentRequest();
  const calls = [];
  let refreshedToken = "";
  const result = await requestCaptionAgentWithSessionRetry({
    endpoint: "http://127.0.0.1:4319/v1/captions",
    token: "stale-process-session",
    providerConfig: {
      upstageApiKey: "upstage-memory-only"
    },
    request,
    onSessionToken: (token) => {
      refreshedToken = token;
    },
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      if (calls.length === 1) {
        return jsonResponse({
          error: {
            code: "UNAUTHORIZED",
            message: "세션이 만료되었습니다."
          }
        }, { status: 401 });
      }
      if (calls.length === 2) {
        return jsonResponse({
          schema: CAPTION_AGENT_SESSION_SCHEMA,
          status: "ok",
          authentication: "bearer-process-memory",
          expires: "companion-restart",
          token: "refreshed-process-session"
        });
      }
      return jsonResponse(completedAgentResponse(request));
    }
  });
  assert.equal(result.status, "completed");
  assert.equal(refreshedToken, "refreshed-process-session");
  assert.equal(calls.length, 3);
  assert.equal(
    calls[0].options.headers.Authorization,
    "Bearer stale-process-session"
  );
  assert.equal(calls[1].url, "http://127.0.0.1:4319/v1/session");
  assert.equal(
    calls[2].options.headers.Authorization,
    "Bearer refreshed-process-session"
  );
});

test("자막 실행 예상량은 활성 컷과 유료 요청 상한을 실행 전에 계산한다", () => {
  const estimate = captionAgentRunEstimate([
    { sourceStartMs: 1_000, sourceEndMs: 5_000 },
    { sourceStartMs: 5_000, sourceEndMs: 20_000 },
    { sourceStartMs: 0, sourceEndMs: 99_000, enabled: false }
  ]);
  assert.deepEqual(estimate, {
    clipCount: 2,
    totalDurationMs: 19_000,
    plannedSolarRequests: 2,
    maximumSolarRequests: 2
  });
  assert.equal(MAX_CAPTION_AGENT_CLIPS_PER_RUN, 16);
});

test("실패 재개 계획은 같은 컷 범위·Solar 모델의 완료 체크포인트만 건너뛴다", () => {
  const clips = [{
    id: "clip-1",
    sourceStartMs: 1_000,
    sourceEndMs: 5_000
  }, {
    id: "clip-2",
    sourceStartMs: 8_000,
    sourceEndMs: 12_000
  }];
  const checkpoint = createCaptionAgentCheckpoint(
    clips[0],
    "solar-pro3",
    {
      requestId: "request-completed",
      completedAt: "2026-07-29T00:00:00.000Z"
    }
  );
  const stored = upsertCaptionAgentCheckpoint([], checkpoint);
  assert.deepEqual(
    captionAgentResumePlan(clips, stored, "solar-pro3", { resume: true }),
    {
      clips: [clips[1]],
      skippedClipIds: ["clip-1"]
    }
  );
  assert.deepEqual(
    captionAgentResumePlan(clips, stored, "solar-mini", { resume: true }),
    {
      clips,
      skippedClipIds: []
    }
  );
  assert.deepEqual(
    captionAgentResumePlan(
      [{ ...clips[0], sourceEndMs: 5_100 }, clips[1]],
      stored,
      "solar-pro3",
      { resume: true }
    ).skippedClipIds,
    []
  );
  assert.deepEqual(
    captionAgentResumePlan(clips, stored, "solar-pro3", { resume: false }),
    {
      clips,
      skippedClipIds: []
    }
  );
});

test("재개 체크포인트는 현재 자막 품질 하네스 프로필과 일치할 때만 재사용한다", () => {
  const clip = {
    id: "clip-harness",
    sourceStartMs: 1_000,
    sourceEndMs: 5_000
  };
  const matchingCheckpoint = createCaptionAgentCheckpoint(
    clip,
    "solar-pro3",
    {
      requestId: "request-current-harness",
      completedAt: "2026-07-29T00:00:00.000Z"
    }
  );
  const legacyCheckpoint = { ...matchingCheckpoint };
  delete legacyCheckpoint.qualityProfile;
  delete legacyCheckpoint.harnessFingerprint;
  const differentCheckpoint = {
    ...matchingCheckpoint,
    qualityProfile: "legacy-unharnessed-v0"
  };
  const staleHarnessCheckpoint = {
    ...matchingCheckpoint,
    harnessFingerprint: "kr-vtuber-clean-v1:old-logic"
  };

  assert.equal(matchingCheckpoint.qualityProfile, "kr-vtuber-clean-v1");
  assert.match(
    matchingCheckpoint.harnessFingerprint,
    /^kr-vtuber-clean-v1:/u
  );
  assert.deepEqual(
    captionAgentResumePlan(
      [clip],
      [matchingCheckpoint],
      "solar-pro3",
      { resume: true }
    ),
    {
      clips: [],
      skippedClipIds: ["clip-harness"]
    }
  );
  for (const staleCheckpoint of [
    legacyCheckpoint,
    differentCheckpoint,
    staleHarnessCheckpoint
  ]) {
    assert.deepEqual(
      captionAgentResumePlan(
        [clip],
        [staleCheckpoint],
        "solar-pro3",
        { resume: true }
      ),
      {
        clips: [clip],
        skippedClipIds: []
      }
    );
  }
});

test("편집 문맥 지문이 달라지면 완료 컷을 낡은 문맥으로 재사용하지 않는다", () => {
  const clip = {
    id: "clip-context-fingerprint",
    sourceStartMs: 1_000,
    sourceEndMs: 5_000
  };
  const checkpoint = createCaptionAgentCheckpoint(clip, "solar-pro3", {
    editorialContextFingerprint: "ctx-v1-1111111111111111"
  });

  assert.deepEqual(
    captionAgentResumePlan([clip], [checkpoint], "solar-pro3", {
      resume: true,
      editorialContextFingerprint: "ctx-v1-1111111111111111"
    }).skippedClipIds,
    ["clip-context-fingerprint"]
  );
  assert.deepEqual(
    captionAgentResumePlan([clip], [checkpoint], "solar-pro3", {
      resume: true,
      editorialContextFingerprint: "ctx-v1-2222222222222222"
    }).skippedClipIds,
    []
  );
});

test("새 전체 실행은 대상 컷의 이전 체크포인트만 먼저 폐기한다", () => {
  const clips = [{
    id: "clip-1",
    sourceStartMs: 1_000,
    sourceEndMs: 5_000
  }, {
    id: "clip-2",
    sourceStartMs: 8_000,
    sourceEndMs: 12_000
  }];
  const checkpoints = clips.map((clip, index) => (
    createCaptionAgentCheckpoint(clip, "solar-pro3", {
      requestId: `old-request-${index + 1}`
    })
  ));
  assert.deepEqual(
    discardCaptionAgentCheckpointsForClips(checkpoints, [clips[0]]),
    [checkpoints[1]]
  );
  assert.deepEqual(
    discardCaptionAgentCheckpointsForClips(checkpoints, clips),
    []
  );
});

test("재개 체크포인트는 같은 로컬 원본 identity에서만 유지한다", () => {
  const media = {
    name: "source.webm",
    size: 123_456,
    lastModified: 1_753_700_000_000,
    durationMs: 600_000,
    mediaOriginMs: 0,
    width: 1920,
    height: 1080,
    codec: "vp09",
    audioCodec: "opus"
  };
  assert.equal(sameCaptionMediaIdentity(media, { ...media }), true);
  assert.equal(
    sameCaptionMediaIdentity(media, {
      ...media,
      lastModified: media.lastModified + 1
    }),
    false
  );
  assert.equal(
    sameCaptionMediaIdentity(media, {
      ...media,
      durationMs: media.durationMs + 10
    }),
    false
  );
});

test("STT·Upstage 설정은 검증 후 로컬 companion으로만 전달한다", () => {
  const provider = {
    sttEndpoint: "https://stt.example/v1/audio/transcriptions",
    sttModel: "timestamp-model",
    sttApiKey: "stt-secret",
    upstageApiKey: "upstage-secret"
  };
  assert.equal(
    normalizeExternalSttEndpoint(provider.sttEndpoint),
    provider.sttEndpoint
  );
  assert.deepEqual(
    captionProviderHeaders(
      "http://127.0.0.1:4319/v1/captions",
      provider
    ),
    {
      "X-Kirinuki-STT-Endpoint": provider.sttEndpoint,
      "X-Kirinuki-STT-Model": provider.sttModel,
      "X-Kirinuki-STT-API-Key": provider.sttApiKey,
      "X-Kirinuki-Upstage-API-Key": provider.upstageApiKey
    }
  );
  assert.throws(
    () => captionProviderHeaders(
      "https://captions.example/v1/captions",
      provider
    ),
    /로컬 companion/u
  );
  assert.throws(
    () => normalizeExternalSttEndpoint(
      "http://stt.example/v1/audio/transcriptions"
    ),
    /HTTPS/u
  );
  assert.throws(
    () => normalizeExternalSttEndpoint(
      "https://stt.example/v1/audio/transcriptions?api_key=must-not-persist"
    ),
    /쿼리 문자열/u
  );
});

test("쿼리가 있는 STT 주소는 Chrome 저장소에 쓰기 전에 거절한다", async () => {
  let storageWrites = 0;
  await assert.rejects(
    saveCaptionAgentSettings({
      endpoint: "http://127.0.0.1:4319/v1/captions",
      model: "solar-pro3",
      sttEndpoint:
        "https://stt.example/v1/audio/transcriptions?token=must-not-persist",
      sttModel: "timestamp-model"
    }, {
      async set() {
        storageWrites += 1;
      }
    }),
    /쿼리 문자열/u
  );
  assert.equal(storageWrites, 0);
});

test("비밀 API 키는 자막 에이전트 저장 설정에 포함하지 않는다", async () => {
  let persisted = null;
  const storageArea = {
    async set(value) {
      persisted = structuredClone(value);
    }
  };
  const settings = await saveCaptionAgentSettings({
    endpoint: "http://127.0.0.1:4319/v1/captions",
    model: "solar-pro3",
    sttEndpoint: "https://stt.example/v1/audio/transcriptions",
    sttModel: "timestamp-model",
    sttApiKey: "must-not-persist",
    upstageApiKey: "must-not-persist"
  }, storageArea);
  assert.deepEqual(settings, {
    endpoint: "http://127.0.0.1:4319/v1/captions",
    model: "solar-pro3",
    sttEndpoint: "https://stt.example/v1/audio/transcriptions",
    sttModel: "timestamp-model"
  });
  assert.deepEqual(
    persisted["chzzk-kirinuki-caption-agent-settings-v1"],
    settings
  );
  assert.equal(JSON.stringify(persisted).includes("must-not-persist"), false);
  assert.deepEqual(normalizeCaptionAgentSettings(settings), settings);
  assert.equal(
    normalizeCaptionAgentSettings({ ...settings, model: "solar-mini" }).model,
    "solar-mini"
  );
  assert.equal(
    normalizeCaptionAgentSettings({ ...settings, model: "solar-pro2" }).model,
    "solar-pro3"
  );
});

test("16kHz mono Float32 PCM을 올바른 PCM16 WAV base64로 만든다", () => {
  const encoded = encodePcm16WavBase64(
    new Float32Array([-1, 0, 1]),
    16_000
  );
  const wav = Buffer.from(encoded, "base64");
  assert.equal(wav.subarray(0, 4).toString("ascii"), "RIFF");
  assert.equal(wav.subarray(8, 12).toString("ascii"), "WAVE");
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(24), 16_000);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.readUInt32LE(40), 6);
  assert.equal(wav.readInt16LE(44), -32_768);
  assert.equal(wav.readInt16LE(46), 0);
  assert.equal(wav.readInt16LE(48), 32_767);
});

test("요청은 실제 컷 메모·길이와 한국어 키리누키 4초 정책을 담는다", () => {
  const request = createCaptionAgentRequest({
    project: {
      id: "project-1",
      name: "새 프로젝트",
      source: { streamerName: "스트리머" }
    },
    clip: {
      id: "clip-1",
      note: "첫 장면",
      sourceStartMs: 10_000,
      sourceEndMs: 15_500
    },
    model: "solar-pro3",
    audioBase64: "UklGRg==",
    placementHints: {
      analysis: "local-three-band-edge-density-v1",
      framesShared: false,
      samples: [{
        atMs: 500,
        topScore: 700,
        centerScore: 400,
        bottomScore: 100,
        preferredPlacement: "bottom"
      }]
    }
  });
  assert.equal(request.schema, CAPTION_AGENT_REQUEST_SCHEMA);
  assert.match(
    request.requestId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
  );
  assert.equal(request.clip.durationMs, 5_500);
  assert.equal(request.clip.title, "첫 장면");
  assert.equal(request.locale, "ko-KR");
  assert.equal(request.policy.includeAllRecognizableSpeech, true);
  assert.equal(request.policy.maxCueDurationMs, 4_000);
  assert.equal(request.policy.terminalPeriod, "omit");
  assert.equal(request.visual.framesShared, false);
  assert.equal(request.visual.samples[0].preferredPlacement, "bottom");
  assert.equal(request.editorialContext.style.maxWidthUnits, 20);
  assert.equal(request.editorialContext.style.placement, "bottom");
  assert.equal(request.editorialContext.speakers[0].id, "main");
  assert(
    request.editorialContext.speakers[0].aliases.includes("스트리머")
  );
  assert.equal(request.audio.data, "UklGRg==");
  assert.throws(
    () => createCaptionAgentRequest({
      project: {
        id: "project-1",
        name: "새 프로젝트",
        source: { streamerName: "스트리머" }
      },
      clip: {
        id: "clip-1",
        note: "첫 장면",
        sourceStartMs: 10_000,
        sourceEndMs: 15_500
      },
      model: "solar-pro2",
      audioBase64: "UklGRg==",
      placementHints: request.visual
    }),
    /지원하지 않는 Solar 모델/u
  );
});

test("원격 cue는 정렬·경계·4초를 검증하고 동시 발화와 표시 메타를 보존한다", () => {
  const cues = normalizeCaptionAgentCues([
    {
      startMs: 1_000,
      endMs: 2_000,
      text: "진짜야?.",
      speakerId: " guest ",
      reviewRequired: true,
      placement: "top",
      color: "#00FF88"
    },
    {
      start_ms: 0,
      end_ms: 1_000,
      text: "「안녕하세요。」",
      speaker_id: " main ",
      review_required: false,
      placement: "bottom"
    }
  ], 5_000);

  assert.deepEqual(cues.map((cue) => cue.text), [
    "「안녕하세요」",
    "진짜야?"
  ]);
  assert.deepEqual(cues[0].remoteMeta, {
    speakerId: "main",
    reviewRequired: false,
    placement: "bottom"
  });
  assert.deepEqual(cues[1].remoteMeta, {
    speakerId: "guest",
    reviewRequired: true,
    placement: "top"
  });
  assert.equal(cues[1].color, "#00ff88");
  assert.equal(cues[1].y, 0.18);

  assert.throws(
    () => normalizeCaptionAgentCues([{
      startMs: 0,
      endMs: 4_001,
      text: "너무 긴 자막"
    }], 5_000),
    /4초/u
  );
  assert.throws(
    () => normalizeCaptionAgentCues([{
      startMs: -1,
      endMs: 1_000,
      text: "범위 밖"
    }], 5_000),
    /시간 범위/u
  );
  const simultaneous = normalizeCaptionAgentCues([
    {
      startMs: 0,
      endMs: 1_500,
      text: "첫 자막",
      speakerId: "main"
    },
    {
      startMs: 1_000,
      endMs: 2_000,
      text: "동시 발화",
      speakerId: "guest"
    }
  ], 5_000);
  assert.deepEqual(
    simultaneous.map((cue) => cue.remoteMeta.speakerId),
    ["main", "guest"]
  );
});

test("cue별 품질 사유는 remoteMeta에 남고 review-required를 강제한다", () => {
  const [cue] = normalizeCaptionAgentCues([{
    startMs: 0,
    endMs: 1_000,
    text: "다시 들어볼 자막",
    speakerId: "main",
    reviewRequired: false,
    placement: "bottom",
    quality: {
      status: "review-required",
      codes: ["HARNESS_TRANSCRIPT_COVERAGE_LOW"]
    }
  }], 2_000);

  assert.deepEqual(cue.remoteMeta, {
    speakerId: "main",
    reviewRequired: true,
    placement: "bottom",
    qualityStatus: "review-required",
    qualityCodes: ["HARNESS_TRANSCRIPT_COVERAGE_LOW"]
  });
});

test("오디오 추출 전에 컷 길이와 WAV 메모리 상한을 검사한다", () => {
  const footprint = captionAgentAudioFootprint(
    MAX_CAPTION_AGENT_CLIP_DURATION_MS
  );
  assert.equal(footprint.durationMs, 30 * 60 * 1_000);
  assert(footprint.floatPcmBytes > footprint.wavBytes);
  assert(footprint.wavBytes < 64 * 1024 * 1024);
  assert.throws(
    () => captionAgentAudioFootprint(
      MAX_CAPTION_AGENT_CLIP_DURATION_MS + 1
    ),
    /30분/u
  );
  assert.equal(MAX_CAPTION_AGENT_CLIPS_PER_RUN, 16);
  assert.equal(MAX_CAPTION_AGENT_CUES_PER_RUN, 10_000);
});

test("동기 응답은 리다이렉트와 credential을 금지한 요청으로 전달한다", async () => {
  const controller = new AbortController();
  const calls = [];
  const request = agentRequest();
  const result = await requestCaptionAgent({
    endpoint: "https://captions.example/v1/captions",
    token: "session-token",
    request,
    signal: controller.signal,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse(completedAgentResponse(request));
    }
  });

  assert.equal(result.status, "completed");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(calls[0].options.credentials, "omit");
  assert.equal(calls[0].options.headers.Authorization, "Bearer session-token");
  assert.equal(calls[0].options.signal.aborted, false);
});

test("제공자 API 키는 JSON 본문이 아니라 loopback 요청 헤더로만 보낸다", async () => {
  const request = agentRequest();
  const calls = [];
  await requestCaptionAgent({
    endpoint: "http://127.0.0.1:4319/v1/captions",
    token: "session-token",
    providerConfig: {
      sttEndpoint: "https://stt.example/v1/audio/transcriptions",
      sttModel: "timestamp-model",
      sttApiKey: "stt-memory-only",
      upstageApiKey: "upstage-memory-only"
    },
    request,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse(completedAgentResponse(request));
    }
  });
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].options.headers["X-Kirinuki-STT-API-Key"],
    "stt-memory-only"
  );
  assert.equal(
    calls[0].options.headers["X-Kirinuki-Upstage-API-Key"],
    "upstage-memory-only"
  );
  assert.equal(
    calls[0].options.body.includes("stt-memory-only"),
    false
  );
  assert.equal(
    calls[0].options.body.includes("upstage-memory-only"),
    false
  );
});

test("제공자 설정은 세션 토큰이 없으면 fetch 전에 거부한다", async () => {
  const request = agentRequest();
  let fetchCount = 0;
  const options = {
    endpoint: "http://127.0.0.1:4319/v1/captions",
    providerConfig: {
      upstageApiKey: "upstage-memory-only"
    },
    fetchImpl: async () => {
      fetchCount += 1;
      return jsonResponse(completedAgentResponse(request));
    }
  };
  await assert.rejects(
    requestCaptionAgent({
      ...options,
      request
    }),
    /세션 토큰/u
  );
  await assert.rejects(
    probeCaptionAgent(options),
    /세션 토큰/u
  );
  assert.equal(fetchCount, 0);
});

test("원격 에이전트 오류 본문은 프로젝트에 저장될 Error message로 복사하지 않는다", async () => {
  const echoedSecret = "upstage-secret-that-must-not-persist";
  await assert.rejects(
    probeCaptionAgent({
      endpoint: "https://captions.example/v1/captions",
      fetchImpl: async () => jsonResponse({
        error: {
          code: "REMOTE_FAILURE",
          message: `echo ${echoedSecret}`
        }
      }, { status: 502 })
    }),
    (error) => (
      error?.status === 502
      && error?.code === "REMOTE_FAILURE"
      && !error.message.includes(echoedSecret)
    )
  );
});

test("비동기 상태 URL은 최초 요청과 같은 origin만 허용한다", async () => {
  await assert.rejects(
    requestCaptionAgent({
      endpoint: "https://captions.example/v1/captions",
      request: agentRequest(),
      fetchImpl: async () => jsonResponse({
        status: "queued",
        statusUrl: "https://attacker.example/jobs/1"
      }, { status: 202 })
    }),
    /다른 출처/u
  );

  await assert.rejects(
    requestCaptionAgent({
      endpoint: "https://captions.example/v1/captions",
      request: agentRequest(),
      fetchImpl: async () => jsonResponse({
        status: "queued",
        statusUrl: "https://user:secret@captions.example/jobs/1"
      }, { status: 202 })
    }),
    /인증 정보/u
  );
});

test("비동기 폴링은 same-origin 상대 URL을 GET으로 조회해 완료 응답을 반환한다", async () => {
  const calls = [];
  const request = agentRequest();
  const result = await requestCaptionAgent({
    endpoint: "https://captions.example/v1/captions",
    token: "poll-token",
    request,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (calls.length === 1) {
        return jsonResponse({
          status: "queued",
          statusUrl: "/v1/jobs/one",
          retryAfterMs: 300
        }, { status: 202 });
      }
      return jsonResponse(completedAgentResponse(request));
    }
  });

  assert.equal(result.status, "completed");
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, "https://captions.example/v1/jobs/one");
  assert.equal(calls[1].options.method, "GET");
  assert.equal(calls[1].options.redirect, "error");
  assert.equal(calls[1].options.credentials, "omit");
  assert.equal(calls[1].options.headers.Authorization, "Bearer poll-token");
});

test("비동기 폴링은 same-origin 상대 URL을 따르고 AbortSignal로 즉시 멈춘다", async () => {
  const controller = new AbortController();
  const calls = [];
  const pending = requestCaptionAgent({
    endpoint: "https://captions.example/v1/captions",
    request: agentRequest(),
    signal: controller.signal,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({
        status: "queued",
        statusUrl: "/v1/jobs/one",
        retryAfterMs: 10_000
      }, { status: 202 });
    },
    onProgress: (_progress, message) => {
      if (message.includes("Solar")) {
        controller.abort();
      }
    }
  });

  await assert.rejects(
    pending,
    (error) => error?.name === "AbortError"
  );
  assert.equal(calls.length, 1);
});

test("이미 취소된 신호는 네트워크 요청을 시작하지 않는다", async () => {
  const controller = new AbortController();
  controller.abort();
  let fetchCount = 0;
  await assert.rejects(
    requestCaptionAgent({
      endpoint: "https://captions.example/v1/captions",
      request: agentRequest(),
      signal: controller.signal,
      fetchImpl: async () => {
        fetchCount += 1;
        return jsonResponse({ status: "completed", cues: [] });
      }
    }),
    (error) => error?.name === "AbortError"
  );
  assert.equal(fetchCount, 0);
});

test("완료 응답은 요청 ID·컷 ID와 모든 필수 필드 타입을 검증한다", async () => {
  const request = agentRequest();
  const cases = [
    {
      name: "requestId 누락",
      response: completedAgentResponse(request, { requestId: undefined }),
      pattern: /requestId/u
    },
    {
      name: "requestId 불일치",
      response: completedAgentResponse(request, { requestId: "stale-request" }),
      pattern: /요청 ID/u
    },
    {
      name: "clipId 불일치",
      response: completedAgentResponse(request, { clipId: "other-clip" }),
      pattern: /컷 ID/u
    },
    {
      name: "필수 배열 타입 위반",
      response: completedAgentResponse(request, { warnings: null }),
      pattern: /warnings/u
    },
    {
      name: "warning 개수 상한 위반",
      response: completedAgentResponse(request, {
        warnings: Array.from(
          { length: MAX_REMOTE_WARNINGS + 1 },
          (_, cueIndex) => ({ code: "TOO_MANY", cueIndex })
        )
      }),
      pattern: /warnings/u
    },
    {
      name: "응답 추가 필드 거부",
      response: completedAgentResponse(request, { debugTranscript: "비공개" }),
      pattern: /지원하지 않는 필드/u
    },
    {
      name: "제공자 계약 위반",
      response: completedAgentResponse(request, { provider: "unknown" }),
      pattern: /Upstage/u
    },
    {
      name: "품질 envelope 전체 누락",
      response: (() => {
        const response = completedAgentResponse(request);
        delete response.qualityProfile;
        delete response.harnessFingerprint;
        delete response.editorialContextFingerprint;
        delete response.qualityReport;
        return response;
      })(),
      pattern: /품질 하네스 지문/u
    },
    {
      name: "다른 요청의 편집 문맥 지문",
      response: completedAgentResponse(request, {
        editorialContextFingerprint: "ctx-v1-1111111111111111"
      }),
      pattern: /현재 요청/u
    },
    {
      name: "cue 필수 필드 타입 위반",
      response: completedAgentResponse(request, {
        cues: [{
          startMs: 0,
          endMs: 1_000,
          text: "안녕",
          speakerId: "main",
          reviewRequired: "false",
          placement: "bottom"
        }]
      }),
      pattern: /cue/u
    }
  ];

  for (const fixture of cases) {
    await assert.rejects(
      requestCaptionAgent({
        endpoint: "https://captions.example/v1/captions",
        request,
        fetchImpl: async () => jsonResponse(fixture.response)
      }),
      fixture.pattern,
      fixture.name
    );
  }
});

test("비동기 폴링은 횟수 상한에서 중단된다", async () => {
  const request = agentRequest();
  let fetchCount = 0;
  await assert.rejects(
    requestCaptionAgent({
      endpoint: "https://captions.example/v1/captions",
      request,
      maxPollAttempts: 1,
      fetchImpl: async () => {
        fetchCount += 1;
        return jsonResponse({
          status: "running",
          statusUrl: "/v1/jobs/one",
          retryAfterMs: 300
        }, { status: 202 });
      }
    }),
    /횟수 상한/u
  );
  assert.equal(fetchCount, 2);
});

test("전체 요청 제한 시간은 진행 중인 네트워크 요청도 중단한다", async () => {
  const request = agentRequest();
  let receivedSignal = null;
  await assert.rejects(
    requestCaptionAgent({
      endpoint: "https://captions.example/v1/captions",
      request,
      timeoutMs: 20,
      fetchImpl: async (_url, options) => {
        receivedSignal = options.signal;
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => {
            reject(options.signal.reason);
          }, { once: true });
        });
      }
    }),
    (error) => error?.name === "TimeoutError"
  );
  assert.equal(receivedSignal?.aborted, true);
});

test("연결 확인에도 짧은 deadline이 적용된다", async () => {
  let receivedSignal = null;
  await assert.rejects(
    probeCaptionAgent({
      endpoint: "https://captions.example/v1/captions",
      timeoutMs: 20,
      fetchImpl: async (_url, options) => {
        receivedSignal = options.signal;
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => {
            reject(options.signal.reason);
          }, { once: true });
        });
      }
    }),
    (error) => error?.name === "TimeoutError"
  );
  assert.equal(receivedSignal?.aborted, true);
});

test("자막 에이전트의 과대 응답은 본문을 버퍼링하기 전에 거부한다", async () => {
  const request = agentRequest();
  await assert.rejects(
    requestCaptionAgent({
      endpoint: "https://captions.example/v1/captions",
      request,
      fetchImpl: async () => new Response("{}", {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": String(9 * 1024 * 1024)
        }
      })
    }),
    /응답 본문이 너무 큽니다/u
  );
});
