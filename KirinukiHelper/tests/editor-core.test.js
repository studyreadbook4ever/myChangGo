import assert from "node:assert/strict";
import test from "node:test";

import {
  EDITOR_SCHEMA,
  DEFAULT_SUBTITLE_COLOR,
  MAX_AI_CAPTION_CHECKPOINTS,
  MAX_AI_WARNINGS,
  MAX_RECENT_SUBTITLE_COLORS,
  MAX_SUBTITLE_LANES,
  MIN_SUBTITLE_LANES,
  SUPPORTED_IMAGE_ASSET_MIME_TYPES,
  addSubtitleLane,
  appendAiSubtitleDrafts,
  applyCaptionStylePreset,
  applyMediaAlignmentOffset,
  audioRegionAtTimeline,
  audioRegionTimelineRange,
  canReorderClipGroup,
  captureStateSourceConflict,
  captureProjectId,
  createAudioRegion,
  createEditorProjectFromCapture,
  createImageAsset,
  createSubtitleCue,
  cuesAtTimeline,
  cueAtTimeline,
  cueTimelineRange,
  deleteAudioRegion,
  deleteImageAsset,
  findImageAssetOverlaps,
  findAudioRegionOverlaps,
  findSubtitleOverlaps,
  imageAssetsAtTimeline,
  imageAssetTimelineRange,
  mapTimelineToSource,
  matchImageAssetToSubtitleCue,
  matchSubtitleCueToImageAsset,
  mergeCaptureIntoEditorProject,
  mergeAiWarnings,
  normalizeEditorProject,
  normalizeAiCaptionCheckpoints,
  normalizeImageAssetSource,
  normalizeRecentSubtitleColors,
  projectDurationMs,
  reorderClip,
  reorderClipGroup,
  replaceAiSubtitleDraft,
  resetAiSubtitlePositions,
  rememberSubtitleColor,
  resolveTimelineSnap,
  rippleDeleteTimelineRange,
  serializeSrt,
  sameSourceSession,
  sourceSessionIdentity,
  transcriptChunksToCueDrafts,
  timelineSnapCandidates,
  timelineSnapThresholdMs,
  updateAudioRegion,
  updateClipTrim,
  updateImageAsset,
  updateSubtitleCue
} from "../extension/lib/editor-core.js";

const captureState = {
  projectName: "7월 방송",
  source: {
    platform: "CHZZK",
    contentType: "live",
    channelId: "channel-a",
    broadcastStartedAt: "2026-07-27 18:00:00",
    canonicalUrl: "https://chzzk.naver.com/live/channel-a",
    streamerName: "테스트",
    broadcastTitle: "저녁 방송"
  },
  segments: [
    {
      id: "first",
      startSeconds: 10.125,
      endSeconds: 15.75,
      description: "첫 구간"
    },
    {
      id: "second",
      startSeconds: 30,
      endSeconds: 36.5,
      description: "둘째 구간"
    }
  ]
};

test("방송 회차 ID는 같은 채널의 서로 다른 방송을 구분한다", () => {
  const first = sourceSessionIdentity(captureState.source);
  const second = sourceSessionIdentity({
    ...captureState.source,
    broadcastStartedAt: "2026-07-28 18:00:00"
  });
  assert.equal(first, "broadcast:channel-a:2026-07-27 18:00:00");
  assert.notEqual(first, second);
});

test("AI 자막 체크포인트는 현재 컷·범위·지원 모델만 제한 개수로 복원한다", () => {
  const clips = [{
    id: "first",
    sourceStartMs: 10_000,
    sourceEndMs: 15_000
  }];
  const valid = {
    clipId: "first",
    sourceStartMs: 10_000,
    sourceEndMs: 15_000,
    model: "audseg-local",
    requestId: "request-1",
    completedAt: "2026-07-29T00:00:00.000Z"
  };
  const normalized = normalizeAiCaptionCheckpoints([
    { ...valid, clipId: "missing" },
    { ...valid, model: "unknown-model" },
    valid,
    { ...valid, requestId: "request-latest" },
    {
      ...valid,
      model: "whisper-tiny",
      requestId: "request-local"
    }
  ], clips);
  assert.equal(normalized.length, 2);
  assert.equal(normalized[0].requestId, "request-latest");
  assert.equal(
    normalized[0].pipelineFingerprint,
    "legacy-caption-pipeline-v0"
  );
  assert.equal(normalized[1].requestId, "request-local");
  const currentPipeline = normalizeAiCaptionCheckpoints([{
    ...valid,
    model: "whisper-tiny",
    pipelineFingerprint: "caption-pipeline-v1-1234567890abcdef"
  }], clips);
  assert.equal(
    currentPipeline[0].pipelineFingerprint,
    "caption-pipeline-v1-1234567890abcdef"
  );
  assert.equal(MAX_AI_CAPTION_CHECKPOINTS, 500);
});

test("생방송과 다시보기는 채널·방송 시작 시각이 같으면 같은 회차로 연결한다", () => {
  const live = sourceSessionIdentity(captureState.source);
  const vodSource = {
    ...captureState.source,
    contentType: "vod",
    contentId: "11804294",
    canonicalUrl: "https://chzzk.naver.com/video/11804294"
  };
  const vod = sourceSessionIdentity(vodSource);
  assert.equal(vod, live);
  assert.equal(sameSourceSession(captureState.source, vodSource), true);
});

test("동일 치지직 VOD의 metadata 보강은 새 원본으로 오인하지 않는다", () => {
  const withoutMetadata = {
    platform: "CHZZK",
    contentType: "vod",
    contentId: "13583412",
    channelId: "088973112d8acc831ec20274f7ffbb99",
    broadcastStartedAt: "",
    canonicalUrl: "https://chzzk.naver.com/video/13583412"
  };
  const enriched = {
    ...withoutMetadata,
    broadcastStartedAt: "2026-07-28 21:00:00"
  };
  assert.notEqual(
    sourceSessionIdentity(withoutMetadata),
    sourceSessionIdentity(enriched),
    "기존 저장 ID 형식은 live↔VOD 회차 연결을 위해 유지됩니다."
  );
  assert.equal(sameSourceSession(withoutMetadata, enriched), true);
  assert.equal(captureStateSourceConflict({
    source: withoutMetadata,
    segments: [{ id: "saved-range" }]
  }, enriched), false);

  const otherVod = {
    ...enriched,
    contentId: "14405629",
    canonicalUrl: "https://chzzk.naver.com/video/14405629"
  };
  assert.equal(sameSourceSession(enriched, otherVod), false);
  assert.equal(captureStateSourceConflict({
    source: enriched,
    segments: [{ id: "saved-range" }]
  }, otherVod), true);
});

test("치지직 live의 stale contentId는 다른 타입 원본과 service binding을 만들지 않는다", () => {
  const liveWithStaleContentId = {
    platform: "CHZZK",
    contentType: "live",
    channelId: "channel-live",
    contentId: "shared-id",
    broadcastStartedAt: "2026-07-29 03:00:00"
  };
  const unrelatedVod = {
    platform: "CHZZK",
    contentType: "vod",
    channelId: "channel-other",
    contentId: "shared-id",
    broadcastStartedAt: "2026-07-28 03:00:00"
  };
  assert.equal(sameSourceSession(liveWithStaleContentId, unrelatedVod), false);
  assert.equal(sameSourceSession(
    { platform: "CHZZK", contentType: "vod", contentId: "shared-id" },
    { platform: "CHZZK", contentType: "clip", contentId: "shared-id" }
  ), false);

  const matchingVod = {
    ...unrelatedVod,
    channelId: liveWithStaleContentId.channelId,
    contentId: "actual-vod-id",
    broadcastStartedAt: liveWithStaleContentId.broadcastStartedAt
  };
  assert.equal(
    sameSourceSession(liveWithStaleContentId, matchingVod),
    true,
    "live↔VOD 연결은 contentId가 아니라 채널·방송 시작 시각으로 유지해야 합니다."
  );
});

test("YouTube URL 형식은 같은 영상 ID로 연결하고 치지직 ID와는 충돌하지 않는다", () => {
  const youtubeWatch = {
    platform: "YOUTUBE",
    contentType: "vod",
    contentId: "abcdefghijk",
    canonicalUrl: "https://www.youtube.com/watch?v=abcdefghijk"
  };
  const youtubeShort = {
    ...youtubeWatch,
    canonicalUrl: "https://www.youtube.com/shorts/abcdefghijk",
    channelId: "UC-test-channel",
    broadcastStartedAt: "2026-07-29T00:00:00Z"
  };
  const chzzk = {
    platform: "CHZZK",
    contentType: "vod",
    contentId: "abcdefghijk",
    canonicalUrl: "https://chzzk.naver.com/video/abcdefghijk"
  };
  assert.equal(
    sourceSessionIdentity(youtubeWatch),
    "youtube:vod:abcdefghijk"
  );
  assert.equal(
    sourceSessionIdentity(youtubeWatch),
    sourceSessionIdentity(youtubeShort)
  );
  assert.equal(sourceSessionIdentity(chzzk), "vod:abcdefghijk");
  assert.notEqual(
    sourceSessionIdentity(youtubeWatch),
    sourceSessionIdentity(chzzk)
  );

  const project = createEditorProjectFromCapture({
    ...captureState,
    source: youtubeWatch
  });
  assert.equal(project.broadcastSession.alignmentConfirmed, true);
  assert.equal(
    project.broadcastSession.vodUrl,
    youtubeWatch.canonicalUrl
  );
});

test("저장 전 시작 스탬프도 다른 방송의 끝 스탬프와 섞이지 않는다", () => {
  const withDraftStart = {
    ...captureState,
    segments: [],
    draft: {
      ...captureState.draft,
      startText: "00:00:10.125",
      startCapture: { sourceSessionId: "broadcast:channel-a:2026-07-27 18:00:00" }
    }
  };
  assert.equal(captureStateSourceConflict(withDraftStart, {
    channelId: "channel-b",
    contentType: "live",
    broadcastStartedAt: "2026-07-27 19:00:00"
  }), true);
  assert.equal(captureStateSourceConflict(withDraftStart, {
    channelId: "channel-a",
    contentType: "vod",
    broadcastStartedAt: "2026-07-27 18:00:00"
  }), false);
});

test("캡처 상태를 사용자 권위 컷이 있는 편집 프로젝트로 만든다", () => {
  const project = createEditorProjectFromCapture(captureState, {
    id: "project-test",
    createdAt: "2026-07-27T09:00:00.000Z"
  });
  assert.equal(project.schema, EDITOR_SCHEMA);
  assert.equal(project.id, "project-test");
  assert.equal(project.clips.length, 2);
  assert.equal(project.clips[0].authority, "USER");
  assert.equal(project.clips[0].sourceStartMs, 10_125);
  assert.equal(project.clips[0].sourceEndMs, 15_750);
  assert.equal(project.clips[1].timelineStartMs, 5_625);
  assert.equal(projectDurationMs(project), 12_125);
  assert.equal(captureProjectId(captureState), captureProjectId(captureState));
});

test("새 프로젝트는 에셋·자막 2개 레인과 고정 음성 레인 데이터를 준비한다", () => {
  const project = createEditorProjectFromCapture(captureState);
  assert.equal(project.subtitleLaneCount, MIN_SUBTITLE_LANES);
  assert.equal(project.subtitleLaneCount, 2);
  assert.deepEqual(project.suppressedSelections, []);
  assert.deepEqual(project.imageAssets, []);
  assert.deepEqual(project.audioRegions, []);
  assert.equal(project.selectedImageAssetId, null);
  assert.equal(project.selectedAudioRegionId, null);
  assert.equal(project.subtitleDefaults.fontScale, 0.0675);
  assert.equal(project.subtitleDefaults.stylePresetId, "kr-vtuber-clean-v1");
  assert.equal(project.subtitleDefaults.maxLines, 1);
  assert.equal(project.ai.model, "whisper-tiny");
  assert.deepEqual(project.ai.warnings, []);
  assert.deepEqual(project.ai.speakerColors, {});
});

test("현재 로컬 Whisper 실행 메타데이터는 저장 왕복에서 legacy로 오인하지 않는다", () => {
  const current = createEditorProjectFromCapture(captureState);
  const normalized = normalizeEditorProject({
    ...current,
    ai: {
      ...current.ai,
      provider: "local-whispercpp",
      model: "whisper-tiny",
      resolvedModel: "tiny-q5_1",
      status: "done",
      progress: 1
    }
  });
  assert.equal(normalized.ai.provider, "local-whispercpp");
  assert.equal(normalized.ai.model, "whisper-tiny");
  assert.equal(normalized.ai.resolvedModel, "tiny-q5_1");
  assert.equal(normalized.ai.status, "done");
  assert.equal(normalized.ai.progress, 1);
});

test("저작권 고지를 포함한 Paperlogy 프리셋을 명시적으로 적용하고 정규화한다", () => {
  const project = applyCaptionStylePreset(
    createEditorProjectFromCapture(captureState),
    "kr-vtuber-paperlogy-v1"
  );
  assert.equal(project.subtitleDefaults.stylePresetId, "kr-vtuber-paperlogy-v1");
  assert.equal(project.subtitleDefaults.fontFamily, "Paperlogy");
  assert.equal(project.subtitleDefaults.fontScale, 0.061);
  assert.equal(project.subtitleDefaults.maxLines, 1);

  const normalized = normalizeEditorProject(
    JSON.parse(JSON.stringify(project))
  );
  assert.equal(normalized.subtitleDefaults.stylePresetId, "kr-vtuber-paperlogy-v1");
  assert.equal(normalized.subtitleDefaults.fontFamily, "Paperlogy");

  const repairedMismatch = normalizeEditorProject({
    ...normalized,
    subtitleDefaults: {
      ...normalized.subtitleDefaults,
      fontFamily: "Pretendard"
    }
  });
  assert.equal(
    repairedMismatch.subtitleDefaults.stylePresetId,
    "kr-vtuber-paperlogy-v1"
  );
  assert.equal(repairedMismatch.subtitleDefaults.fontId, "paperlogy");
  assert.equal(repairedMismatch.subtitleDefaults.fontFamily, "Paperlogy");
});

test("AI 처리 경고는 프로젝트 전체 상한에서 잘라 저장·병합한다", () => {
  const incoming = Array.from(
    { length: MAX_AI_WARNINGS + 1 },
    (_, cueIndex) => ({ code: "REMOTE_WARNING", cueIndex })
  );
  const merged = mergeAiWarnings([], incoming, "clip-first");
  assert.equal(merged.length, MAX_AI_WARNINGS);
  assert.equal(merged.at(-1).code, "TRIMMED_WARNING_COUNT");
  assert(merged.slice(0, -1).every(
    (warning) => warning.clipId === "clip-first"
  ));

  const project = createEditorProjectFromCapture(captureState);
  const normalized = normalizeEditorProject({
    ...project,
    ai: {
      ...project.ai,
      warnings: incoming
    }
  });
  assert.equal(normalized.ai.warnings.length, MAX_AI_WARNINGS);
  assert.equal(
    normalized.ai.warnings.at(-1).code,
    "TRIMMED_WARNING_COUNT"
  );
});

test("v1 프로젝트를 컷·자막 수정 상태를 잃지 않고 v3로 이관한다", () => {
  const current = createEditorProjectFromCapture(captureState, {
    id: "legacy-project",
    createdAt: "2026-07-27T09:00:00.000Z"
  });
  const legacyCue = createSubtitleCue(current, {
    id: "legacy-cue",
    clipId: "clip-first",
    startOffsetMs: 700,
    endOffsetMs: 2_100,
    text: "기존 검수 자막",
    x: 0.31,
    y: 0.73,
    origin: "ai"
  });
  const {
    lane: _lane,
    color: _color,
    ...cueWithoutV2Fields
  } = {
    ...legacyCue,
    x: 0.31,
    y: 0.73
  };
  const {
    subtitleLaneCount: _subtitleLaneCount,
    suppressedSelections: _suppressedSelections,
    audioRegions: _audioRegions,
    imageAssets: _imageAssets,
    selectedImageAssetId: _selectedImageAssetId,
    selectedAudioRegionId: _selectedAudioRegionId,
    ...legacy
  } = {
    ...current,
    schema: "chzzk-kirinuki-editor/v1",
    name: "이어 편집할 프로젝트",
    clips: current.clips.map((clip, index) => (
      index === 0
        ? { ...clip, sourceStartMs: 10_500, sourceEndMs: 15_000 }
        : clip
    )),
    subtitles: [{ ...cueWithoutV2Fields, humanEdited: true }],
    selectedCueId: "legacy-cue",
    subtitleDefaults: {
      ...current.subtitleDefaults,
      stylePresetId: undefined,
      fontId: undefined,
      fontScale: 0.052,
      color: "#F2C14E",
      backgroundColor: "rgba(0, 0, 0, 0.72)"
    }
  };

  const migrated = normalizeEditorProject(legacy);
  assert.equal(migrated.schema, EDITOR_SCHEMA);
  assert.equal(migrated.id, "legacy-project");
  assert.equal(migrated.name, "이어 편집할 프로젝트");
  assert.equal(migrated.clips[0].sourceStartMs, 10_500);
  assert.equal(migrated.clips[0].sourceEndMs, 15_000);
  assert.equal(migrated.subtitleLaneCount, 2);
  assert.deepEqual(migrated.imageAssets, []);
  assert.deepEqual(migrated.audioRegions, []);
  assert.equal(migrated.selectedCueId, "legacy-cue");
  assert.deepEqual(
    {
      id: migrated.subtitles[0].id,
      text: migrated.subtitles[0].text,
      startOffsetMs: migrated.subtitles[0].startOffsetMs,
      endOffsetMs: migrated.subtitles[0].endOffsetMs,
      x: migrated.subtitles[0].x,
      y: migrated.subtitles[0].y,
      lane: migrated.subtitles[0].lane,
      color: migrated.subtitles[0].color,
      humanEdited: migrated.subtitles[0].humanEdited
    },
    {
      id: "legacy-cue",
      text: "기존 검수 자막",
      startOffsetMs: 700,
      endOffsetMs: 2_100,
      x: 0.31,
      y: 0.73,
      lane: 0,
      color: "#f2c14e",
      humanEdited: true
    }
  );
  assert.equal(migrated.subtitleDefaults.color, "#f2c14e");
  assert.equal(migrated.subtitleDefaults.fontScale, 0.052);
  assert.equal(migrated.subtitleDefaults.fontFamily, "Pretendard");
  assert.equal(migrated.subtitleDefaults.fontWeight, 800);
  assert.equal(migrated.subtitleDefaults.backgroundColor, "transparent");
  assert.equal(
    migrated.subtitleDefaults.stylePresetId,
    "pretendard-legacy-v1"
  );
});

test("v2 프로젝트를 기존 자막·음성 선택 상태를 보존해 v3로 이관한다", () => {
  let current = createEditorProjectFromCapture(captureState, {
    id: "v2-project",
    createdAt: "2026-07-27T10:00:00.000Z"
  });
  const cue = createSubtitleCue(current, {
    id: "v2-cue",
    clipId: "clip-first",
    startOffsetMs: 300,
    endOffsetMs: 1_300,
    text: "v2 자막",
    lane: 1,
    color: "#44AAEE"
  });
  const audio = createAudioRegion(current, {
    id: "v2-audio",
    clipId: "clip-second",
    startOffsetMs: 400,
    endOffsetMs: 2_400,
    gain: 0.4,
    fadeInMs: 250
  });
  current = {
    ...current,
    schema: "chzzk-kirinuki-editor/v2",
    subtitles: [cue],
    audioRegions: [audio],
    selectedCueId: cue.id,
    selectedAudioRegionId: audio.id
  };
  delete current.imageAssets;
  delete current.selectedImageAssetId;

  const migrated = normalizeEditorProject(current);
  assert.equal(migrated.schema, EDITOR_SCHEMA);
  assert.equal(migrated.id, "v2-project");
  assert.equal(migrated.subtitles[0].id, "v2-cue");
  assert.equal(migrated.subtitles[0].lane, 1);
  assert.equal(migrated.subtitles[0].color, "#44aaee");
  assert.equal(migrated.audioRegions[0].id, "v2-audio");
  assert.equal(migrated.audioRegions[0].gain, 0.4);
  assert.equal(migrated.selectedCueId, "v2-cue");
  assert.equal(migrated.selectedAudioRegionId, "v2-audio");
  assert.deepEqual(migrated.imageAssets, []);
  assert.equal(migrated.selectedImageAssetId, null);
});

test("이전 프로젝트의 미디어 자산에 PTS 원점과 CFR 메타데이터 기본값을 보완한다", () => {
  const raw = createEditorProjectFromCapture(captureState);
  raw.mediaAsset = {
    name: "archive.mp4",
    durationMs: 65_432,
    hasVideo: true,
    hasAudio: true
  };
  const project = normalizeEditorProject(raw);
  assert.deepEqual(project.mediaAsset, {
    name: "archive.mp4",
    durationMs: 65_432,
    mediaOriginMs: 0,
    mediaEndTimestampMs: 65_432,
    frameRate: null,
    hasVideo: true,
    hasAudio: true,
    videoDecodable: null,
    audioDecodable: null
  });
});

test("결과 타임라인 시각을 원본 구간 시각으로 변환한다", () => {
  const project = createEditorProjectFromCapture(captureState);
  assert.deepEqual(mapTimelineToSource(project, 2_000), {
    clipId: "clip-first",
    timelineMs: 2_000,
    clipOffsetMs: 2_000,
    sourceMs: 12_125
  });
  assert.deepEqual(mapTimelineToSource(project, 6_000), {
    clipId: "clip-second",
    timelineMs: 6_000,
    clipOffsetMs: 375,
    sourceMs: 30_375
  });
});

test("라이브 선택 시각과 로컬 VOD 사이의 정렬 오프셋을 모든 컷에 적용한다", () => {
  let project = createEditorProjectFromCapture(captureState);
  project = applyMediaAlignmentOffset(project, -2_000);
  assert.equal(project.broadcastSession.alignmentOffsetMs, -2_000);
  assert.equal(project.broadcastSession.alignmentConfirmed, true);
  assert.equal(project.clips[0].selectionStartMs, 10_125);
  assert.equal(project.clips[0].sourceStartMs, 8_125);
  assert.equal(mapTimelineToSource(project, 0).sourceMs, 8_125);
  assert.throws(
    () => applyMediaAlignmentOffset(project, -20_000),
    /원본 시작보다 앞으로/
  );
});

test("자막 텍스트·표시 구간·위치는 사용자 수정 상태로 보존된다", () => {
  let project = createEditorProjectFromCapture(captureState);
  const cue = createSubtitleCue(project, {
    id: "cue-1",
    clipId: "clip-first",
    startOffsetMs: 500,
    endOffsetMs: 2_500,
    text: "AI 초안",
    origin: "ai"
  });
  project = { ...project, subtitles: [cue] };
  project = updateSubtitleCue(project, "cue-1", {
    text: "사람이 고친 자막",
    startOffsetMs: 700,
    endOffsetMs: 2_900,
    x: 0.25,
    y: 0.2
  });

  assert.equal(project.subtitles[0].text, "사람이 고친 자막");
  assert.equal(project.subtitles[0].humanEdited, true);
  assert.equal(project.subtitles[0].x, 0.25);
  assert.equal(project.subtitles[0].y, 0.2);
  assert.deepEqual(cueTimelineRange(project, project.subtitles[0]), {
    startMs: 700,
    endMs: 2_900
  });
  assert.equal(cueAtTimeline(project, 1_000)?.id, "cue-1");
});

test("저장된 자동 AI 자막만 기본 위치로 이관하고 사람 소유 위치는 보존한다", () => {
  const base = createEditorProjectFromCapture(captureState);
  const raw = {
    ...base,
    subtitles: [
      {
        ...createSubtitleCue(base, {
          id: "automatic-ai",
          clipId: "clip-first",
          startOffsetMs: 0,
          endOffsetMs: 1_000,
          text: "자동 초안",
          origin: "ai",
          remoteMeta: {
            speakerId: "main",
            reviewRequired: false,
            placement: "bottom"
          }
        }),
        x: 0.12,
        y: 0.18,
        remoteMeta: {
          speakerId: "main",
          reviewRequired: false,
          placement: "top"
        }
      },
      {
        ...createSubtitleCue(base, {
          id: "reviewed-ai",
          clipId: "clip-first",
          startOffsetMs: 1_000,
          endOffsetMs: 2_000,
          text: "사람 검수 AI",
          origin: "ai",
          remoteMeta: {
            speakerId: "guest",
            reviewRequired: false,
            placement: "bottom"
          }
        }),
        humanEdited: true,
        x: 0.31,
        y: 0.27,
        remoteMeta: {
          speakerId: "guest",
          reviewRequired: false,
          placement: "top"
        }
      },
      {
        ...createSubtitleCue(base, {
          id: "manual-caption",
          clipId: "clip-first",
          startOffsetMs: 2_000,
          endOffsetMs: 3_000,
          text: "직접 만든 강조",
          origin: "human"
        }),
        x: 0.76,
        y: 0.44
      }
    ]
  };

  const once = normalizeEditorProject(structuredClone(raw));
  const automatic = once.subtitles.find((cue) => cue.id === "automatic-ai");
  const reviewed = once.subtitles.find((cue) => cue.id === "reviewed-ai");
  const manual = once.subtitles.find((cue) => cue.id === "manual-caption");
  assert.deepEqual(
    [automatic.x, automatic.y, automatic.remoteMeta.placement],
    [0.5, 0.84, "bottom"]
  );
  assert.deepEqual(
    [reviewed.x, reviewed.y, reviewed.remoteMeta.placement],
    [0.31, 0.27, "top"]
  );
  assert.deepEqual([manual.x, manual.y], [0.76, 0.44]);

  const twice = normalizeEditorProject(structuredClone(once));
  assert.deepEqual(twice, once);
});

test("명시적 전체 정렬은 AI 자막 위치만 초기화하고 수동 자막은 건드리지 않는다", () => {
  const base = createEditorProjectFromCapture(captureState);
  const project = {
    ...base,
    subtitles: [
      {
        ...createSubtitleCue(base, {
          id: "reviewed-ai",
          clipId: "clip-first",
          startOffsetMs: 0,
          endOffsetMs: 1_000,
          text: "사람이 글을 고친 AI",
          origin: "ai",
          remoteMeta: {
            speakerId: "guest",
            reviewRequired: false,
            placement: "bottom"
          }
        }),
        humanEdited: true,
        x: 0.4,
        y: 0.18,
        remoteMeta: {
          speakerId: "guest",
          reviewRequired: false,
          placement: "top"
        }
      },
      {
        ...createSubtitleCue(base, {
          id: "manual-caption",
          clipId: "clip-first",
          startOffsetMs: 1_000,
          endOffsetMs: 2_000,
          text: "수동 강조",
          origin: "human"
        }),
        x: 0.7,
        y: 0.2
      }
    ]
  };

  const reset = resetAiSubtitlePositions(project, {
    includeHumanEdited: true,
    updatedAt: "2026-07-29T12:00:00.000Z"
  });
  const reviewed = reset.subtitles.find((cue) => cue.id === "reviewed-ai");
  const manual = reset.subtitles.find((cue) => cue.id === "manual-caption");
  assert.deepEqual(
    [reviewed.x, reviewed.y, reviewed.remoteMeta.placement],
    [0.5, 0.84, "bottom"]
  );
  assert.equal(reviewed.humanEdited, true);
  assert.deepEqual([manual.x, manual.y], [0.7, 0.2]);
  assert.strictEqual(
    resetAiSubtitlePositions(reset, {
      includeHumanEdited: true
    }),
    reset
  );
});

test("자막마다 색상을 따로 정규화하고 수정한다", () => {
  let project = createEditorProjectFromCapture(captureState);
  const cue = createSubtitleCue(project, {
    id: "colored-cue",
    clipId: "clip-first",
    startOffsetMs: 0,
    endOffsetMs: 1_000,
    text: "강조 자막",
    color: "#F0A"
  });
  project = { ...project, subtitles: [cue] };

  assert.equal(project.subtitles[0].color, "#ff00aa");
  assert.equal(project.subtitleDefaults.color, "#ffffff");

  project = updateSubtitleCue(project, "colored-cue", { color: "#12AB34" });
  assert.equal(project.subtitles[0].color, "#12ab34");
  assert.equal(project.subtitles[0].humanEdited, true);
  assert.equal(project.subtitleDefaults.color, "#ffffff");
});

test("자막 색상 레지스터는 흰색을 제외한 최근 고유 색상 5개만 MRU로 보존한다", () => {
  let project = createEditorProjectFromCapture(captureState);
  assert.equal(DEFAULT_SUBTITLE_COLOR, "#ffffff");
  assert.equal(MAX_RECENT_SUBTITLE_COLORS, 5);
  assert.deepEqual(project.recentSubtitleColors, []);

  for (const color of [
    "#ff0000",
    "#00ff00",
    "#0000ff",
    "#ffff00",
    "#ff00ff",
    "#00ffff"
  ]) {
    project = rememberSubtitleColor(project, color);
  }
  assert.deepEqual(project.recentSubtitleColors, [
    "#00ffff",
    "#ff00ff",
    "#ffff00",
    "#0000ff",
    "#00ff00"
  ]);

  project = rememberSubtitleColor(project, "#00F");
  assert.deepEqual(project.recentSubtitleColors, [
    "#0000ff",
    "#00ffff",
    "#ff00ff",
    "#ffff00",
    "#00ff00"
  ]);
  assert.strictEqual(rememberSubtitleColor(project, "#ffffff"), project);
  assert.strictEqual(rememberSubtitleColor(project, "not-a-color"), project);

  assert.deepEqual(normalizeRecentSubtitleColors([
    "#FFF",
    "#0F0",
    "#00ff00",
    "bad",
    "#123456",
    "#abcdef",
    "#fedcba",
    "#135790",
    "#246801"
  ]), [
    "#00ff00",
    "#123456",
    "#abcdef",
    "#fedcba",
    "#135790"
  ]);

  const restored = normalizeEditorProject({
    ...project,
    recentSubtitleColors: [
      "#ABC",
      "#ffffff",
      "#aabbcc",
      "javascript:alert(1)"
    ]
  });
  assert.deepEqual(restored.recentSubtitleColors, ["#aabbcc"]);
});

test("타임라인 자석은 줌에 맞춘 8px 범위에서 반대 종류 경계를 우선해 결정한다", () => {
  let project = createEditorProjectFromCapture(captureState);
  const cue = createSubtitleCue(project, {
    id: "snap-cue",
    clipId: "clip-first",
    startOffsetMs: 500,
    endOffsetMs: 1_500,
    text: "스냅 대상"
  });
  const asset = createImageAsset(project, {
    id: "snap-asset",
    clipId: "clip-first",
    startOffsetMs: 1_800,
    endOffsetMs: 2_800,
    mimeType: "image/png",
    dataUrl: "data:image/png;base64,AAAA"
  });
  project = {
    ...project,
    subtitles: [cue],
    imageAssets: [asset],
    playheadMs: 1_750
  };

  assert.equal(timelineSnapThresholdMs(20), 400);
  assert.equal(timelineSnapThresholdMs(70), 114);
  assert.equal(timelineSnapThresholdMs(240), 33);

  const candidates = timelineSnapCandidates(project, {
    clipId: "clip-first",
    excludeCueId: cue.id,
    preferredKind: "asset"
  });
  assert.equal(
    candidates.some((candidate) => candidate.kind === "subtitle"),
    false
  );
  assert.equal(
    candidates.some((candidate) => (
      candidate.kind === "asset"
      && candidate.edge === "start"
      && candidate.timeMs === 1_800
    )),
    true
  );

  const snapped = resolveTimelineSnap(1_775, candidates, {
    thresholdMs: timelineSnapThresholdMs(70)
  });
  assert.deepEqual(
    {
      timeMs: snapped.timeMs,
      deltaMs: snapped.deltaMs,
      distanceMs: snapped.distanceMs,
      kind: snapped.kind,
      edge: snapped.edge
    },
    {
      timeMs: 1_800,
      deltaMs: 25,
      distanceMs: 25,
      kind: "asset",
      edge: "start"
    }
  );
  assert.equal(resolveTimelineSnap(3_500, candidates, { thresholdMs: 20 }), null);
});

test("같은 컷의 선택 자막과 에셋은 양끝 시각을 손실 없이 서로 맞춘다", () => {
  const base = createEditorProjectFromCapture(captureState);
  const cue = createSubtitleCue(base, {
    id: "match-cue",
    clipId: "clip-first",
    startOffsetMs: 400,
    endOffsetMs: 1_400,
    text: "정확 맞춤"
  });
  const asset = createImageAsset(base, {
    id: "match-asset",
    clipId: "clip-first",
    startOffsetMs: 1_725,
    endOffsetMs: 3_125,
    mimeType: "image/png",
    dataUrl: "data:image/png;base64,AAAA"
  });
  const project = {
    ...base,
    subtitles: [cue],
    imageAssets: [asset],
    selectedCueId: cue.id,
    selectedImageAssetId: asset.id
  };

  const cueMatched = matchSubtitleCueToImageAsset(
    project,
    cue.id,
    asset.id
  );
  assert.deepEqual(
    cueMatched.subtitles.map(({ startOffsetMs, endOffsetMs }) => ({
      startOffsetMs,
      endOffsetMs
    })),
    [{ startOffsetMs: 1_725, endOffsetMs: 3_125 }]
  );
  assert.equal(cueMatched.subtitles[0].humanEdited, true);
  assert.equal(cueMatched.selectedImageAssetId, asset.id);

  const assetMatched = matchImageAssetToSubtitleCue(
    project,
    asset.id,
    cue.id
  );
  assert.deepEqual(
    assetMatched.imageAssets.map(({ startOffsetMs, endOffsetMs }) => ({
      startOffsetMs,
      endOffsetMs
    })),
    [{ startOffsetMs: 400, endOffsetMs: 1_400 }]
  );
  assert.equal(assetMatched.selectedCueId, cue.id);

  const otherClipAsset = createImageAsset(project, {
    id: "other-clip-asset",
    clipId: "clip-second",
    startOffsetMs: 0,
    endOffsetMs: 500,
    mimeType: "image/png",
    dataUrl: "data:image/png;base64,BBBB"
  });
  const crossClip = {
    ...project,
    imageAssets: [...project.imageAssets, otherClipAsset]
  };
  assert.strictEqual(
    matchSubtitleCueToImageAsset(crossClip, cue.id, otherClipAsset.id),
    crossClip
  );
});

test("웹 붙여넣기 이미지 참조는 안전한 래스터 형식만 영속화한다", () => {
  const png = "data:image/png;base64,AAAA";
  assert.deepEqual(SUPPORTED_IMAGE_ASSET_MIME_TYPES, [
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/gif"
  ]);
  assert.deepEqual(normalizeImageAssetSource(png, "image/png"), {
    kind: "data-url",
    value: png
  });
  assert.deepEqual(normalizeImageAssetSource({
    kind: "blob-key",
    value: "project/demo/asset/logo"
  }), {
    kind: "blob-key",
    value: "project/demo/asset/logo"
  });
  assert.equal(
    normalizeImageAssetSource("data:image/svg+xml;base64,AAAA", "image/svg+xml"),
    null
  );
  assert.equal(normalizeImageAssetSource(png, "image/jpeg"), null);
});

test("투명 이미지 에셋을 만들고 위치·크기·불투명도를 수정·삭제한다", () => {
  let project = createEditorProjectFromCapture(captureState);
  const asset = createImageAsset(project, {
    id: "logo",
    clipId: "clip-first",
    startOffsetMs: 500,
    endOffsetMs: 2_500,
    name: "투명 로고",
    mimeType: "image/webp",
    blobKey: "project/demo/asset/logo",
    sourceUrl: "https://example.com/logo.webp",
    x: 0.25,
    y: 0.75,
    naturalWidth: 800,
    naturalHeight: 400
  });
  project = {
    ...project,
    imageAssets: [asset],
    selectedImageAssetId: asset.id
  };

  assert.deepEqual(asset.source, {
    kind: "blob-key",
    value: "project/demo/asset/logo"
  });
  assert.equal(asset.scale, 1);
  assert.equal(asset.opacity, 1);
  assert.deepEqual(imageAssetTimelineRange(project, asset), {
    startMs: 500,
    endMs: 2_500
  });

  project = updateImageAsset(project, asset.id, {
    x: -1,
    y: 2,
    scale: 9,
    opacity: 0.35
  });
  assert.equal(project.imageAssets[0].x, 0);
  assert.equal(project.imageAssets[0].y, 1);
  assert.equal(project.imageAssets[0].scale, 5);
  assert.equal(project.imageAssets[0].opacity, 0.35);
  assert.equal(project.selectedImageAssetId, "logo");

  project = deleteImageAsset(project, asset.id);
  assert.deepEqual(project.imageAssets, []);
  assert.equal(project.selectedImageAssetId, null);
});

test("동시 에셋은 배열 순서대로 뒤→앞 순서를 유지하고 겹침을 진단한다", () => {
  let project = createEditorProjectFromCapture(captureState);
  const first = createImageAsset(project, {
    id: "background-sticker",
    clipId: "clip-first",
    startOffsetMs: 0,
    endOffsetMs: 2_000,
    mimeType: "image/png",
    dataUrl: "data:image/png;base64,AAAA"
  });
  const second = createImageAsset(project, {
    id: "foreground-sticker",
    clipId: "clip-first",
    startOffsetMs: 500,
    endOffsetMs: 1_500,
    mimeType: "image/gif",
    dataUrl: "data:image/gif;base64,BBBB"
  });
  project = { ...project, imageAssets: [first, second] };

  assert.deepEqual(
    imageAssetsAtTimeline(project, 1_000).map((asset) => asset.id),
    ["background-sticker", "foreground-sticker"]
  );
  assert.deepEqual(findImageAssetOverlaps(project), [{
    firstAssetId: "background-sticker",
    secondAssetId: "foreground-sticker",
    startMs: 500,
    endMs: 1_500
  }]);
  assert.deepEqual(imageAssetsAtTimeline(project, 2_000), []);
});

test("자막 레인을 클릭으로 늘리고 프로젝트가 허용한 범위 안에서 cue 레인을 정규화한다", () => {
  let project = createEditorProjectFromCapture(captureState);
  project = addSubtitleLane(project);
  assert.equal(project.subtitleLaneCount, 3);

  const cue = createSubtitleCue(project, {
    id: "third-lane",
    clipId: "clip-first",
    startOffsetMs: 0,
    endOffsetMs: 1_000,
    text: "세 번째 레인",
    lane: 2
  });
  project = { ...project, subtitles: [cue] };
  project = updateSubtitleCue(project, "third-lane", { lane: 99 });
  assert.equal(project.subtitles[0].lane, 2);

  for (let index = project.subtitleLaneCount; index < MAX_SUBTITLE_LANES + 2; index += 1) {
    project = addSubtitleLane(project);
  }
  assert.equal(project.subtitleLaneCount, MAX_SUBTITLE_LANES);
  assert.equal(addSubtitleLane(project), project);
});

test("저장된 cue가 가리키는 레인을 정규화 중 잃지 않고 레인 수를 복구한다", () => {
  const raw = createEditorProjectFromCapture(captureState);
  raw.subtitleLaneCount = 2;
  raw.subtitles = [
    createSubtitleCue({ ...raw, subtitleLaneCount: 5 }, {
      id: "restored-lane",
      clipId: "clip-first",
      startOffsetMs: 0,
      endOffsetMs: 1_000,
      text: "복구",
      lane: 4
    })
  ];
  const normalized = normalizeEditorProject(raw);
  assert.equal(normalized.subtitleLaneCount, 5);
  assert.equal(normalized.subtitles[0].lane, 4);
});

test("같은 시각의 자막은 다른 레인에서는 허용하고 같은 레인에서만 충돌시킨다", () => {
  let project = createEditorProjectFromCapture(captureState);
  project = {
    ...project,
    subtitles: [
      createSubtitleCue(project, {
        id: "lower-cue",
        clipId: "clip-first",
        startOffsetMs: 500,
        endOffsetMs: 2_000,
        text: "아래 자막",
        lane: 0
      }),
      createSubtitleCue(project, {
        id: "upper-cue",
        clipId: "clip-first",
        startOffsetMs: 500,
        endOffsetMs: 2_000,
        text: "위 자막",
        lane: 1
      })
    ]
  };

  assert.deepEqual(findSubtitleOverlaps(project), []);
  assert.deepEqual(
    cuesAtTimeline(project, 1_000).map((cue) => cue.id),
    ["lower-cue", "upper-cue"]
  );

  project = updateSubtitleCue(project, "upper-cue", { lane: 0 });
  assert.deepEqual(findSubtitleOverlaps(project), [{
    firstCueId: "lower-cue",
    secondCueId: "upper-cue",
    startMs: 500,
    endMs: 2_000
  }]);
});

test("AI 재실행은 사람이 수정한 AI 자막을 덮어쓰지 않는다", () => {
  let project = createEditorProjectFromCapture(captureState);
  project = replaceAiSubtitleDraft(project, "clip-first", [
    { id: "draft-1", startOffsetMs: 0, endOffsetMs: 1_000, text: "초안" }
  ]);
  project = updateSubtitleCue(project, "draft-1", { text: "검수본" });
  project = replaceAiSubtitleDraft(project, "clip-first", [
    { id: "overlap", startOffsetMs: 500, endOffsetMs: 1_200, text: "겹치는 새 초안" },
    { id: "draft-2", startOffsetMs: 1_000, endOffsetMs: 2_000, text: "새 초안" }
  ]);

  assert.equal(project.subtitles.length, 3);
  assert.equal(project.subtitles.find((cue) => cue.id === "draft-1")?.text, "검수본");
  assert.equal(project.subtitles.find((cue) => cue.id === "draft-2")?.text, "새 초안");
  assert.equal(project.subtitles.find((cue) => cue.id === "overlap")?.lane, 1);
  assert.deepEqual(findSubtitleOverlaps(project), []);
});

test("로컬 AI 초벌은 기존 사람·AI 자막을 그대로 두고 충돌 없는 별도 레인에 한 번만 추가한다", () => {
  let project = createEditorProjectFromCapture(captureState);
  const human = createSubtitleCue(project, {
    id: "human-cue",
    clipId: "clip-first",
    startOffsetMs: 500,
    endOffsetMs: 2_500,
    text: "사용자가 만든 자막",
    lane: 0,
    origin: "human"
  });
  const priorAi = {
    ...createSubtitleCue(project, {
      id: "prior-ai-cue",
      clipId: "clip-first",
      startOffsetMs: 700,
      endOffsetMs: 2_200,
      text: "사용자가 남겨 둔 기존 AI 자막",
      lane: 1,
      origin: "ai"
    }),
    humanEdited: false
  };
  project = {
    ...project,
    subtitles: [human, priorAi],
    selectedCueId: human.id
  };

  const appended = appendAiSubtitleDrafts(project, [{
    id: "codex-first-pass-1",
    clipId: "clip-first",
    startOffsetMs: 800,
    endOffsetMs: 2_000,
    text: "Codex 초벌",
    origin: "ai",
    remoteMeta: {
      speakerId: "codex-local-first-pass",
      reviewRequired: true,
      placement: "bottom"
    }
  }]);
  const repeated = appendAiSubtitleDrafts(appended, [{
    id: "codex-first-pass-1",
    clipId: "clip-first",
    startOffsetMs: 800,
    endOffsetMs: 2_000,
    text: "중복되면 안 됨",
    origin: "ai"
  }]);

  assert.deepEqual(
    repeated.subtitles.filter((cue) => cue.id === human.id),
    [human]
  );
  assert.deepEqual(
    repeated.subtitles.filter((cue) => cue.id === priorAi.id),
    [priorAi]
  );
  assert.equal(repeated.subtitles.filter((cue) => cue.id === "codex-first-pass-1").length, 1);
  assert.equal(repeated.subtitles.find((cue) => cue.id === "codex-first-pass-1").lane, 2);
  assert.equal(repeated.subtitleLaneCount, 3);
  assert.equal(repeated.selectedCueId, human.id);
});

test("단어 타임스탬프를 읽기 쉬운 자막 cue 초안으로 묶는다", () => {
  const drafts = transcriptChunksToCueDrafts([
    { text: "안녕하세요", timestamp: [0.1, 0.7] },
    { text: "오늘은", timestamp: [0.75, 1.2] },
    { text: "게임합니다.", timestamp: [1.25, 2.1] },
    { text: "좋아요", timestamp: [3.5, 4.1] }
  ], 5_000);
  assert.equal(drafts.length, 2);
  assert.equal(drafts[0].text, "안녕하세요 오늘은 게임합니다.");
  assert.equal(drafts[0].startOffsetMs, 100);
  assert.ok(drafts[0].endOffsetMs <= drafts[1].startOffsetMs);
  assert.equal(drafts[1].text, "좋아요");
});

test("단일 transcript chunk가 길어도 모든 AI cue를 4초 이하로 나눈다", () => {
  const drafts = transcriptChunksToCueDrafts([
    {
      text: "하나 둘 셋 넷 다섯 여섯",
      timestamp: [0, 9]
    }
  ], 9_000);
  assert.equal(drafts.length, 3);
  assert.equal(drafts.map((draft) => draft.text).join(" "), "하나 둘 셋 넷 다섯 여섯");
  assert.ok(drafts.every((draft) => (
    draft.endOffsetMs - draft.startOffsetMs <= 4_000
  )));
  for (let index = 1; index < drafts.length; index += 1) {
    assert.ok(drafts[index - 1].endOffsetMs <= drafts[index].startOffsetMs);
  }

  const shortTextDrafts = transcriptChunksToCueDrafts([
    {
      text: "아야",
      timestamp: [0, 9]
    }
  ], 9_000);
  assert.equal(shortTextDrafts.map((draft) => draft.text).join(""), "아야");
  assert.ok(shortTextDrafts.every((draft) => (
    draft.endOffsetMs - draft.startOffsetMs <= 4_000
  )));
});

test("원격 AI cue의 위치 요청은 무시하고 화자·검수·색상만 정규화 왕복에서 보존한다", () => {
  let project = createEditorProjectFromCapture(captureState);
  project = replaceAiSubtitleDraft(project, "clip-first", [
    {
      id: "main-speaker",
      startOffsetMs: 0,
      endOffsetMs: 1_000,
      text: "메인",
      color: "#ffffff",
      y: 0.84,
      remoteMeta: {
        speakerId: "main",
        reviewRequired: false,
        placement: "bottom"
      }
    },
    {
      id: "guest-speaker",
      startOffsetMs: 1_000,
      endOffsetMs: 2_000,
      text: "게스트",
      color: "#00ff88",
      y: 0.18,
      remoteMeta: {
        speakerId: "guest",
        reviewRequired: true,
        placement: "top"
      }
    }
  ]);

  assert.equal(project.subtitles.every((cue) => cue.lane === 0), true);
  assert.equal(project.subtitles[1].color, "#00ff88");
  assert.equal(project.subtitles[1].x, 0.5);
  assert.equal(project.subtitles[1].y, 0.84);
  assert.deepEqual(project.subtitles[1].remoteMeta, {
    speakerId: "guest",
    reviewRequired: true,
    placement: "bottom"
  });

  project = normalizeEditorProject(JSON.parse(JSON.stringify(project)));
  assert.deepEqual(project.subtitles[1].remoteMeta, {
    speakerId: "guest",
    reviewRequired: true,
    placement: "bottom"
  });
});

test("동시에 말하는 원격 화자는 서로 다른 자막 레인에 모두 보존한다", () => {
  let project = createEditorProjectFromCapture(captureState);
  project = replaceAiSubtitleDraft(project, "clip-first", [
    {
      id: "simultaneous-guest",
      startOffsetMs: 500,
      endOffsetMs: 2_000,
      text: "게스트 발화",
      remoteMeta: {
        speakerId: "guest",
        reviewRequired: true,
        placement: "bottom"
      }
    },
    {
      id: "simultaneous-main",
      startOffsetMs: 500,
      endOffsetMs: 2_000,
      text: "메인 발화",
      remoteMeta: {
        speakerId: "main",
        reviewRequired: false,
        placement: "bottom"
      }
    },
    {
      id: "main-followup",
      startOffsetMs: 2_000,
      endOffsetMs: 2_800,
      text: "메인 후속 발화",
      remoteMeta: {
        speakerId: "main",
        reviewRequired: false,
        placement: "bottom"
      }
    }
  ]);

  assert.deepEqual(
    project.subtitles.map((cue) => [cue.id, cue.lane]),
    [
      ["simultaneous-main", 0],
      ["simultaneous-guest", 1],
      ["main-followup", 0]
    ]
  );
  assert.deepEqual(findSubtitleOverlaps(project), []);
  assert.equal(
    project.subtitles.find((cue) => cue.id === "simultaneous-main").y,
    0.84
  );
  assert.equal(
    project.subtitles.find((cue) => cue.id === "simultaneous-guest").y,
    0.84
  );
  assert.equal(
    project.subtitles.find((cue) => cue.id === "main-followup").y,
    0.84
  );
});

test("겹쳐 들어온 AI 타임스탬프도 서로 겹치지 않는 cue로 정규화한다", () => {
  const drafts = transcriptChunksToCueDrafts([
    { text: "둘째 문장", timestamp: [1, 3] },
    { text: "첫 문장.", timestamp: [0, 2] },
    { text: "짧은 말", timestamp: [2.95, 3.02] },
    { text: "끝 경계", timestamp: [4.2, 4.5] }
  ], 4_000);
  assert.ok(drafts.length >= 2);
  for (let index = 1; index < drafts.length; index += 1) {
    assert.ok(drafts[index - 1].endOffsetMs <= drafts[index].startOffsetMs);
  }
  assert.ok(drafts.every((draft) => draft.endOffsetMs <= 4_000));

  let project = createEditorProjectFromCapture(captureState);
  project = replaceAiSubtitleDraft(project, "clip-first", [
    { id: "first-ai", startOffsetMs: 0, endOffsetMs: 2_000, text: "첫 문장" },
    { id: "second-ai", startOffsetMs: 1_000, endOffsetMs: 3_000, text: "둘째 문장" },
    { id: "contained-ai", startOffsetMs: 2_950, endOffsetMs: 3_020, text: "짧은 말" }
  ]);
  assert.deepEqual(findSubtitleOverlaps(project), []);
  assert.match(project.subtitles.map((cue) => cue.text).join(" "), /첫 문장/);
  assert.match(project.subtitles.map((cue) => cue.text).join(" "), /둘째 문장/);
  assert.match(project.subtitles.map((cue) => cue.text).join(" "), /짧은 말/);
});

test("컷 길이와 순서가 바뀌면 타임라인을 다시 흐르게 한다", () => {
  let project = createEditorProjectFromCapture(captureState);
  project = updateClipTrim(project, "clip-first", {
    sourceStartMs: 11_000,
    sourceEndMs: 14_000
  });
  assert.equal(project.clips[1].timelineStartMs, 3_000);

  project = reorderClip(project, "clip-second", 0);
  assert.equal(project.clips[0].id, "clip-second");
  assert.equal(project.clips[1].timelineStartMs, 6_500);
});

test("체크한 여러 컷은 상대 순서를 유지하며 한 단계씩 위아래로 이동한다", () => {
  const project = createEditorProjectFromCapture({
    ...captureState,
    segments: ["a", "b", "c", "d", "e"].map((id, index) => ({
      id,
      startSeconds: index * 2,
      endSeconds: index * 2 + 1,
      description: id.toUpperCase()
    }))
  });
  const selected = new Set(["clip-b", "clip-d"]);

  assert.equal(canReorderClipGroup(project.clips, selected, -1), true);
  assert.equal(canReorderClipGroup(project.clips, selected, 1), true);
  const movedUp = reorderClipGroup(project, selected, -1);
  assert.deepEqual(
    movedUp.clips.map((clip) => clip.id),
    ["clip-b", "clip-a", "clip-d", "clip-c", "clip-e"]
  );
  assert.deepEqual(
    movedUp.clips.filter((clip) => selected.has(clip.id)).map((clip) => clip.id),
    ["clip-b", "clip-d"]
  );
  assert.deepEqual(
    movedUp.clips.map((clip) => clip.timelineStartMs),
    [0, 1_000, 2_000, 3_000, 4_000]
  );

  const movedDown = reorderClipGroup(project, selected, 1);
  assert.deepEqual(
    movedDown.clips.map((clip) => clip.id),
    ["clip-a", "clip-c", "clip-b", "clip-e", "clip-d"]
  );
  assert.deepEqual(
    movedDown.clips.filter((clip) => selected.has(clip.id)).map((clip) => clip.id),
    ["clip-b", "clip-d"]
  );
});

test("묶음 이동은 경계에서 비활성화되고 출력 비활성 컷도 순서를 옮길 수 있다", () => {
  const base = createEditorProjectFromCapture({
    ...captureState,
    segments: ["a", "b", "c"].map((id, index) => ({
      id,
      startSeconds: index * 2,
      endSeconds: index * 2 + 1,
      description: id.toUpperCase()
    }))
  });
  const project = {
    ...base,
    clips: base.clips.map((clip) => (
      clip.id === "clip-b" ? { ...clip, enabled: false } : clip
    ))
  };

  assert.equal(canReorderClipGroup(project.clips, ["clip-a"], -1), false);
  assert.equal(canReorderClipGroup(project.clips, ["clip-c"], 1), false);
  assert.equal(canReorderClipGroup(project.clips, ["clip-b"], -1), true);
  assert.deepEqual(
    reorderClipGroup(project, ["clip-b"], -1).clips.map((clip) => clip.id),
    ["clip-b", "clip-a", "clip-c"]
  );

  const movedAcrossDisabled = reorderClipGroup(project, ["clip-c"], -1);
  assert.deepEqual(
    movedAcrossDisabled.clips.map((clip) => [clip.id, clip.enabled]),
    [
      ["clip-a", true],
      ["clip-c", true],
      ["clip-b", false]
    ]
  );
  assert.deepEqual(
    movedAcrossDisabled.clips.map((clip) => clip.timelineStartMs),
    [0, 1_000, 2_000]
  );
});

test("컷 trim은 남은 자막의 원본 발화 시각을 보존하고 잘려나간 자막은 제거한다", () => {
  let project = createEditorProjectFromCapture(captureState);
  project = {
    ...project,
    subtitles: [
      createSubtitleCue(project, {
        id: "kept",
        clipId: "clip-first",
        startOffsetMs: 500,
        endOffsetMs: 1_500,
        text: "유지"
      }),
      createSubtitleCue(project, {
        id: "removed",
        clipId: "clip-first",
        startOffsetMs: 4_500,
        endOffsetMs: 5_300,
        text: "삭제"
      })
    ],
    selectedCueId: "removed"
  };

  project = updateClipTrim(project, "clip-first", {
    sourceStartMs: 10_500,
    sourceEndMs: 13_000
  });
  const kept = project.subtitles.find((cue) => cue.id === "kept");
  assert.equal(10_500 + kept.startOffsetMs, 10_625);
  assert.equal(10_500 + kept.endOffsetMs, 11_625);
  assert.equal(project.subtitles.some((cue) => cue.id === "removed"), false);
  assert.equal(project.selectedCueId, null);
});

test("음성 구간을 생성·선택·수정·삭제하고 타임라인 시각으로 찾는다", () => {
  let project = createEditorProjectFromCapture(captureState);
  const region = createAudioRegion(project, {
    id: "voice-focus",
    clipId: "clip-first",
    startOffsetMs: 500,
    endOffsetMs: 2_500,
    gain: 2,
    fadeInMs: 300,
    fadeOutMs: 400
  });
  project = {
    ...project,
    audioRegions: [region],
    selectedAudioRegionId: "voice-focus"
  };

  assert.equal(region.gain, 1);
  assert.deepEqual(audioRegionTimelineRange(project, region), {
    startMs: 500,
    endMs: 2_500
  });
  assert.equal(audioRegionAtTimeline(project, 1_000)?.id, "voice-focus");
  assert.equal(audioRegionAtTimeline(project, 2_500), null);

  project = updateAudioRegion(project, "voice-focus", {
    gain: 0.35,
    muted: true,
    fadeInMs: 600,
    fadeOutMs: 700
  });
  assert.deepEqual(
    {
      gain: project.audioRegions[0].gain,
      muted: project.audioRegions[0].muted,
      fadeInMs: project.audioRegions[0].fadeInMs,
      fadeOutMs: project.audioRegions[0].fadeOutMs,
      selectedAudioRegionId: project.selectedAudioRegionId
    },
    {
      gain: 0.35,
      muted: true,
      fadeInMs: 600,
      fadeOutMs: 700,
      selectedAudioRegionId: "voice-focus"
    }
  );

  const deleted = deleteAudioRegion(project, "voice-focus");
  assert.deepEqual(deleted.audioRegions, []);
  assert.equal(deleted.selectedAudioRegionId, null);
});

test("한 음성 레인의 겹치는 설정 구간을 식별한다", () => {
  let project = createEditorProjectFromCapture(captureState);
  project = {
    ...project,
    audioRegions: [
      createAudioRegion(project, {
        id: "audio-a",
        clipId: "clip-first",
        startOffsetMs: 0,
        endOffsetMs: 1_500
      }),
      createAudioRegion(project, {
        id: "audio-b",
        clipId: "clip-first",
        startOffsetMs: 1_000,
        endOffsetMs: 2_000
      })
    ]
  };
  assert.deepEqual(findAudioRegionOverlaps(project), [{
    firstRegionId: "audio-a",
    secondRegionId: "audio-b",
    startMs: 1_000,
    endMs: 1_500
  }]);

  project = updateAudioRegion(project, "audio-b", { startOffsetMs: 1_500 });
  assert.deepEqual(findAudioRegionOverlaps(project), []);
});

test("컷 trim은 음성 설정의 원본 시각을 보존해 자르고 범위 밖 설정을 제거한다", () => {
  let project = createEditorProjectFromCapture(captureState);
  project = {
    ...project,
    audioRegions: [
      createAudioRegion(project, {
        id: "kept-audio",
        clipId: "clip-first",
        startOffsetMs: 500,
        endOffsetMs: 4_000,
        gain: 0.4
      }),
      createAudioRegion(project, {
        id: "removed-audio",
        clipId: "clip-first",
        startOffsetMs: 4_500,
        endOffsetMs: 5_300,
        muted: true
      })
    ],
    selectedAudioRegionId: "removed-audio"
  };

  project = updateClipTrim(project, "clip-first", {
    sourceStartMs: 11_000,
    sourceEndMs: 13_000
  });
  assert.deepEqual(project.audioRegions.map((region) => ({
    id: region.id,
    startOffsetMs: region.startOffsetMs,
    endOffsetMs: region.endOffsetMs,
    gain: region.gain
  })), [{
    id: "kept-audio",
    startOffsetMs: 0,
    endOffsetMs: 2_000,
    gain: 0.4
  }]);
  assert.equal(project.selectedAudioRegionId, null);
});

test("컷 trim은 이미지 에셋의 원본 시각을 보존해 자르고 범위 밖 에셋을 제거한다", () => {
  let project = createEditorProjectFromCapture(captureState);
  project = {
    ...project,
    imageAssets: [
      createImageAsset(project, {
        id: "kept-asset",
        clipId: "clip-first",
        startOffsetMs: 500,
        endOffsetMs: 4_000,
        mimeType: "image/png",
        blobKey: "asset/kept"
      }),
      createImageAsset(project, {
        id: "removed-asset",
        clipId: "clip-first",
        startOffsetMs: 4_500,
        endOffsetMs: 5_300,
        mimeType: "image/webp",
        blobKey: "asset/removed"
      })
    ],
    selectedImageAssetId: "removed-asset"
  };

  project = updateClipTrim(project, "clip-first", {
    sourceStartMs: 11_000,
    sourceEndMs: 13_000
  });
  assert.deepEqual(project.imageAssets.map((asset) => ({
    id: asset.id,
    startOffsetMs: asset.startOffsetMs,
    endOffsetMs: asset.endOffsetMs,
    source: asset.source
  })), [{
    id: "kept-asset",
    startOffsetMs: 0,
    endOffsetMs: 2_000,
    source: { kind: "blob-key", value: "asset/kept" }
  }]);
  assert.equal(project.selectedImageAssetId, null);
});

test("컷 trim은 영상과 같은 원본 시각을 유지하며 현재·후속 컷 자막을 함께 당긴다", () => {
  let project = createEditorProjectFromCapture(captureState);
  project = {
    ...project,
    subtitles: [
      createSubtitleCue(project, {
        id: "first-source-cue",
        clipId: "clip-first",
        startOffsetMs: 1_500,
        endOffsetMs: 2_500,
        text: "첫 컷 자막"
      }),
      createSubtitleCue(project, {
        id: "second-source-cue",
        clipId: "clip-second",
        startOffsetMs: 500,
        endOffsetMs: 1_500,
        text: "다음 컷 자막"
      })
    ]
  };
  const firstCueBefore = project.subtitles[0];
  const secondCueBefore = project.subtitles[1];
  const firstSourceRangeBefore = {
    startMs: project.clips[0].sourceStartMs + firstCueBefore.startOffsetMs,
    endMs: project.clips[0].sourceStartMs + firstCueBefore.endOffsetMs
  };
  assert.deepEqual(cueTimelineRange(project, secondCueBefore), {
    startMs: 6_125,
    endMs: 7_125
  });

  project = updateClipTrim(project, "clip-first", {
    sourceStartMs: 10_625,
    sourceEndMs: 14_750
  });
  const firstCueAfter = project.subtitles.find((cue) => cue.id === "first-source-cue");
  const secondCueAfter = project.subtitles.find((cue) => cue.id === "second-source-cue");
  const firstClipAfter = project.clips.find((clip) => clip.id === "clip-first");
  assert.deepEqual({
    startMs: firstClipAfter.sourceStartMs + firstCueAfter.startOffsetMs,
    endMs: firstClipAfter.sourceStartMs + firstCueAfter.endOffsetMs
  }, firstSourceRangeBefore);
  assert.deepEqual(cueTimelineRange(project, firstCueAfter), {
    startMs: 1_000,
    endMs: 2_000
  });
  assert.deepEqual(cueTimelineRange(project, secondCueAfter), {
    startMs: 4_625,
    endMs: 5_625
  });
});

test("가운데 구간 삭제는 컷을 분할하고 자막·에셋·음성을 원본 시각 기준으로 함께 잇는다", () => {
  let project = createEditorProjectFromCapture(captureState);
  const spanningCue = {
    ...createSubtitleCue(project, {
      id: "spanning-cue",
      clipId: "clip-first",
      startOffsetMs: 1_500,
      endOffsetMs: 3_500,
      text: "이어지는 자막",
      lane: 1,
      color: "#44aaee",
      origin: "ai"
    }),
    humanEdited: true
  };
  const afterCue = createSubtitleCue(project, {
    id: "after-cue",
    clipId: "clip-first",
    startOffsetMs: 4_000,
    endOffsetMs: 5_000,
    text: "뒤 자막"
  });
  const deletedCue = createSubtitleCue(project, {
    id: "deleted-cue",
    clipId: "clip-first",
    startOffsetMs: 2_200,
    endOffsetMs: 2_600,
    text: "삭제될 자막"
  });
  const spanningAsset = createImageAsset(project, {
    id: "spanning-asset",
    clipId: "clip-first",
    startOffsetMs: 1_000,
    endOffsetMs: 4_000,
    name: "투명 로고",
    mimeType: "image/png",
    blobKey: "asset/spanning",
    opacity: 0.7
  });
  const spanningAudio = createAudioRegion(project, {
    id: "spanning-audio",
    clipId: "clip-first",
    startOffsetMs: 1_000,
    endOffsetMs: 4_000,
    gain: 0.4,
    fadeInMs: 600,
    fadeOutMs: 700
  });
  project = {
    ...project,
    subtitles: [spanningCue, afterCue, deletedCue],
    imageAssets: [spanningAsset],
    audioRegions: [spanningAudio],
    selectedCueId: "after-cue",
    selectedImageAssetId: "spanning-asset",
    selectedAudioRegionId: "spanning-audio",
    playheadMs: 4_500
  };

  project = rippleDeleteTimelineRange(project, {
    startMs: 2_000,
    endMs: 3_000
  });

  const firstSelectionClips = project.clips.filter((clip) => clip.selectionId === "first");
  assert.equal(firstSelectionClips.length, 2);
  const [beforeClip, afterClip] = firstSelectionClips;
  assert.equal(beforeClip.id, "clip-first");
  assert.notEqual(afterClip.id, beforeClip.id);
  assert.deepEqual(firstSelectionClips.map((clip) => ({
    selectionId: clip.selectionId,
    selectionStartMs: clip.selectionStartMs,
    selectionEndMs: clip.selectionEndMs,
    sourceStartMs: clip.sourceStartMs,
    sourceEndMs: clip.sourceEndMs,
    timelineStartMs: clip.timelineStartMs
  })), [
    {
      selectionId: "first",
      selectionStartMs: 10_125,
      selectionEndMs: 15_750,
      sourceStartMs: 10_125,
      sourceEndMs: 12_125,
      timelineStartMs: 0
    },
    {
      selectionId: "first",
      selectionStartMs: 10_125,
      selectionEndMs: 15_750,
      sourceStartMs: 13_125,
      sourceEndMs: 15_750,
      timelineStartMs: 2_000
    }
  ]);
  assert.equal(project.clips.find((clip) => clip.id === "clip-second").timelineStartMs, 4_625);
  assert.equal(projectDurationMs(project), 11_125);
  assert.equal(project.playheadMs, 3_500);
  assert.deepEqual(project.suppressedSelections, []);

  const splitCues = project.subtitles.filter((cue) => cue.text === "이어지는 자막");
  assert.equal(splitCues.length, 2);
  assert.equal(splitCues[0].id, "spanning-cue");
  assert.notEqual(splitCues[1].id, splitCues[0].id);
  assert.deepEqual(splitCues.map((cue) => ({
    clipId: cue.clipId,
    startOffsetMs: cue.startOffsetMs,
    endOffsetMs: cue.endOffsetMs,
    lane: cue.lane,
    color: cue.color,
    origin: cue.origin,
    humanEdited: cue.humanEdited
  })), [
    {
      clipId: beforeClip.id,
      startOffsetMs: 1_500,
      endOffsetMs: 2_000,
      lane: 1,
      color: "#44aaee",
      origin: "ai",
      humanEdited: true
    },
    {
      clipId: afterClip.id,
      startOffsetMs: 0,
      endOffsetMs: 500,
      lane: 1,
      color: "#44aaee",
      origin: "ai",
      humanEdited: true
    }
  ]);
  assert.deepEqual(splitCues.map((cue) => cueTimelineRange(project, cue)), [
    { startMs: 1_500, endMs: 2_000 },
    { startMs: 2_000, endMs: 2_500 }
  ]);
  const movedAfterCue = project.subtitles.find((cue) => cue.id === "after-cue");
  assert.deepEqual({
    clipId: movedAfterCue.clipId,
    startOffsetMs: movedAfterCue.startOffsetMs,
    endOffsetMs: movedAfterCue.endOffsetMs,
    timelineRange: cueTimelineRange(project, movedAfterCue)
  }, {
    clipId: afterClip.id,
    startOffsetMs: 1_000,
    endOffsetMs: 2_000,
    timelineRange: { startMs: 3_000, endMs: 4_000 }
  });
  assert.equal(project.subtitles.some((cue) => cue.id === "deleted-cue"), false);
  assert.equal(project.selectedCueId, "after-cue");

  assert.equal(project.imageAssets.length, 2);
  assert.deepEqual(project.imageAssets.map((asset) => ({
    clipId: asset.clipId,
    startOffsetMs: asset.startOffsetMs,
    endOffsetMs: asset.endOffsetMs,
    source: asset.source,
    opacity: asset.opacity
  })), [
    {
      clipId: beforeClip.id,
      startOffsetMs: 1_000,
      endOffsetMs: 2_000,
      source: { kind: "blob-key", value: "asset/spanning" },
      opacity: 0.7
    },
    {
      clipId: afterClip.id,
      startOffsetMs: 0,
      endOffsetMs: 1_000,
      source: { kind: "blob-key", value: "asset/spanning" },
      opacity: 0.7
    }
  ]);
  assert.equal(project.selectedImageAssetId, "spanning-asset");

  assert.equal(project.audioRegions.length, 2);
  assert.deepEqual(project.audioRegions.map((region) => ({
    clipId: region.clipId,
    startOffsetMs: region.startOffsetMs,
    endOffsetMs: region.endOffsetMs,
    gain: region.gain,
    fadeInMs: region.fadeInMs,
    fadeOutMs: region.fadeOutMs
  })), [
    {
      clipId: beforeClip.id,
      startOffsetMs: 1_000,
      endOffsetMs: 2_000,
      gain: 0.4,
      fadeInMs: 600,
      fadeOutMs: 0
    },
    {
      clipId: afterClip.id,
      startOffsetMs: 0,
      endOffsetMs: 1_000,
      gain: 0.4,
      fadeInMs: 0,
      fadeOutMs: 700
    }
  ]);
  assert.equal(project.selectedAudioRegionId, "spanning-audio");
  assert.deepEqual(findAudioRegionOverlaps(project), []);
});

test("여러 컷을 가로지르는 삭제도 뒤 자막의 원본 발화 시각을 보존해 한꺼번에 당긴다", () => {
  let project = createEditorProjectFromCapture(captureState);
  project = {
    ...project,
    subtitles: [
      createSubtitleCue(project, {
        id: "before-cross-cut",
        clipId: "clip-first",
        startOffsetMs: 500,
        endOffsetMs: 1_200,
        text: "앞"
      }),
      createSubtitleCue(project, {
        id: "inside-cross-cut",
        clipId: "clip-first",
        startOffsetMs: 2_500,
        endOffsetMs: 3_500,
        text: "삭제"
      }),
      createSubtitleCue(project, {
        id: "after-cross-cut",
        clipId: "clip-second",
        startOffsetMs: 2_000,
        endOffsetMs: 3_000,
        text: "뒤"
      })
    ],
    selectedClipId: "clip-second",
    selectedCueId: "after-cross-cut",
    playheadMs: 8_000
  };

  project = rippleDeleteTimelineRange(project, {
    startMs: 2_000,
    endMs: 7_000
  });
  assert.deepEqual(project.clips.map((clip) => ({
    id: clip.id,
    sourceStartMs: clip.sourceStartMs,
    sourceEndMs: clip.sourceEndMs,
    timelineStartMs: clip.timelineStartMs
  })), [
    {
      id: "clip-first",
      sourceStartMs: 10_125,
      sourceEndMs: 12_125,
      timelineStartMs: 0
    },
    {
      id: "clip-second",
      sourceStartMs: 31_375,
      sourceEndMs: 36_500,
      timelineStartMs: 2_000
    }
  ]);
  assert.equal(projectDurationMs(project), 7_125);
  assert.equal(project.playheadMs, 3_000);
  assert.equal(project.selectedClipId, "clip-second");
  assert.equal(project.subtitles.some((cue) => cue.id === "inside-cross-cut"), false);
  const afterCue = project.subtitles.find((cue) => cue.id === "after-cross-cut");
  assert.deepEqual({
    clipId: afterCue.clipId,
    startOffsetMs: afterCue.startOffsetMs,
    endOffsetMs: afterCue.endOffsetMs,
    sourceStartMs: project.clips[1].sourceStartMs + afterCue.startOffsetMs,
    timelineRange: cueTimelineRange(project, afterCue)
  }, {
    clipId: "clip-second",
    startOffsetMs: 625,
    endOffsetMs: 1_625,
    sourceStartMs: 32_000,
    timelineRange: { startMs: 2_625, endMs: 3_625 }
  });
});

test("전체 컷 삭제는 소속 트랙 선택을 정리하고 재생 위치를 다음 컷으로 잇는다", () => {
  let project = createEditorProjectFromCapture(captureState);
  project = {
    ...project,
    subtitles: [
      createSubtitleCue(project, {
        id: "removed-with-clip",
        clipId: "clip-first",
        startOffsetMs: 1_000,
        endOffsetMs: 2_000,
        text: "함께 삭제"
      })
    ],
    selectedClipId: "clip-first",
    selectedCueId: "removed-with-clip",
    playheadMs: 2_500
  };
  project = rippleDeleteTimelineRange(project, {
    startMs: 0,
    endMs: 5_625
  });
  assert.deepEqual(project.clips.map((clip) => ({
    id: clip.id,
    timelineStartMs: clip.timelineStartMs
  })), [{ id: "clip-second", timelineStartMs: 0 }]);
  assert.deepEqual(project.subtitles, []);
  assert.deepEqual(project.suppressedSelections.map((suppressed) => ({
    selectionId: suppressed.selectionId,
    selectionStartMs: suppressed.selectionStartMs,
    selectionEndMs: suppressed.selectionEndMs
  })), [{
    selectionId: "first",
    selectionStartMs: 10_125,
    selectionEndMs: 15_750
  }]);
  assert.equal(project.selectedCueId, null);
  assert.equal(project.selectedClipId, "clip-second");
  assert.equal(project.playheadMs, 0);
});

test("전체 삭제한 선택의 tombstone은 정규화 왕복 뒤에도 보존된다", () => {
  const original = createEditorProjectFromCapture(captureState);
  const deleted = rippleDeleteTimelineRange(original, {
    startMs: 0,
    endMs: 5_625
  });
  const restored = normalizeEditorProject(JSON.parse(JSON.stringify(deleted)));
  assert.ok(restored);
  assert.equal(restored.clips.some((clip) => clip.selectionId === "first"), false);
  assert.deepEqual(restored.suppressedSelections.map((suppressed) => ({
    selectionId: suppressed.selectionId,
    selectionStartMs: suppressed.selectionStartMs,
    selectionEndMs: suppressed.selectionEndMs
  })), [{
    selectionId: "first",
    selectionStartMs: 10_125,
    selectionEndMs: 15_750
  }]);
  assert.deepEqual(original.suppressedSelections, []);
});

test("전체 삭제한 선택은 같은 hot-seed에서 유지되고 경계 변경 시 정확히 한 번 복구된다", () => {
  const deleted = rippleDeleteTimelineRange(
    createEditorProjectFromCapture(captureState),
    { startMs: 0, endMs: 5_625 }
  );

  const sameSeed = mergeCaptureIntoEditorProject(deleted, captureState);
  assert.equal(sameSeed.clips.some((clip) => clip.selectionId === "first"), false);
  assert.equal(sameSeed.clips.filter((clip) => clip.selectionId === "second").length, 1);
  assert.deepEqual(sameSeed.suppressedSelections.map((suppressed) => (
    suppressed.selectionId
  )), ["first"]);

  const changedSeed = mergeCaptureIntoEditorProject(deleted, {
    ...captureState,
    segments: [
      { ...captureState.segments[0], startSeconds: 11, endSeconds: 14 },
      ...captureState.segments.slice(1)
    ]
  });
  const restoredFirst = changedSeed.clips.filter((clip) => clip.selectionId === "first");
  assert.equal(restoredFirst.length, 1);
  assert.deepEqual([
    restoredFirst[0].sourceStartMs,
    restoredFirst[0].sourceEndMs
  ], [11_000, 14_000]);
  assert.deepEqual(changedSeed.suppressedSelections, []);
});

test("삭제 표식의 선택이 사이드패널에서 사라지면 tombstone도 해제된다", () => {
  const deleted = rippleDeleteTimelineRange(
    createEditorProjectFromCapture(captureState),
    { startMs: 0, endMs: 5_625 }
  );
  const removedFromCapture = mergeCaptureIntoEditorProject(deleted, {
    ...captureState,
    segments: captureState.segments.slice(1)
  });
  assert.deepEqual(removedFromCapture.suppressedSelections, []);

  const addedAgain = mergeCaptureIntoEditorProject(removedFromCapture, captureState);
  assert.equal(addedAgain.clips.filter((clip) => clip.selectionId === "first").length, 1);
  assert.deepEqual(addedAgain.suppressedSelections, []);
});

test("구간 삭제는 범위 밖 입력과 0.1초보다 짧게 남는 영상 조각을 조용히 늘리지 않는다", () => {
  const project = createEditorProjectFromCapture(captureState);
  assert.throws(
    () => rippleDeleteTimelineRange(project, { startMs: 0, endMs: 99 }),
    /0\.1초 이상/
  );
  assert.throws(
    () => rippleDeleteTimelineRange(project, { startMs: -1, endMs: 500 }),
    /타임라인 안/
  );
  assert.throws(
    () => rippleDeleteTimelineRange(project, { startMs: 50, endMs: 500 }),
    /남는 영상 조각/
  );
});

test("분할 컷은 같은 선택 hot-seed에서 유지되고 변경된 선택과는 그룹 단위로 한 번만 병합된다", () => {
  const createSplitProject = () => {
    let project = createEditorProjectFromCapture(captureState);
    project = rippleDeleteTimelineRange(project, {
      startMs: 1_500,
      endMs: 2_500
    });
    const fragments = project.clips.filter((clip) => clip.selectionId === "first");
    const afterFragment = fragments[1];
    project = {
      ...project,
      subtitles: [
        createSubtitleCue(project, {
          id: "split-after-cue",
          clipId: afterFragment.id,
          startOffsetMs: 500,
          endOffsetMs: 1_000,
          text: "분할 뒤 자막"
        })
      ],
      selectedClipId: afterFragment.id,
      selectedCueId: "split-after-cue"
    };
    return project;
  };

  const split = createSplitProject();
  const originalFragmentIds = split.clips
    .filter((clip) => clip.selectionId === "first")
    .map((clip) => clip.id);
  const unchanged = mergeCaptureIntoEditorProject(split, {
    ...captureState,
    segments: [
      ...captureState.segments,
      { id: "third", startSeconds: 50, endSeconds: 52, description: "추가" }
    ]
  });
  assert.deepEqual(
    unchanged.clips.filter((clip) => clip.selectionId === "first").map((clip) => clip.id),
    originalFragmentIds
  );
  assert.deepEqual(
    unchanged.clips.filter((clip) => clip.selectionId === "first").map((clip) => [
      clip.sourceStartMs,
      clip.sourceEndMs
    ]),
    [[10_125, 11_625], [12_625, 15_750]]
  );
  assert.equal(unchanged.clips.filter((clip) => clip.id === "clip-third").length, 1);
  assert.equal(unchanged.subtitles[0].id, "split-after-cue");

  const oneSidedInput = createSplitProject();
  const oneSidedAfterId = oneSidedInput.clips
    .filter((clip) => clip.selectionId === "first")[1].id;
  const oneSided = mergeCaptureIntoEditorProject(oneSidedInput, {
    ...captureState,
    segments: [
      { ...captureState.segments[0], startSeconds: 13, endSeconds: 16 },
      ...captureState.segments.slice(1)
    ]
  });
  const oneSidedFragments = oneSided.clips.filter((clip) => clip.selectionId === "first");
  assert.equal(oneSidedFragments.length, 1);
  assert.equal(oneSidedFragments[0].id, oneSidedAfterId);
  assert.deepEqual([
    oneSidedFragments[0].sourceStartMs,
    oneSidedFragments[0].sourceEndMs
  ], [13_000, 15_750]);
  assert.equal(oneSided.selectedClipId, oneSidedAfterId);
  assert.equal(oneSided.subtitles[0].id, "split-after-cue");
  assert.equal(
    oneSidedFragments[0].sourceStartMs + oneSided.subtitles[0].startOffsetMs,
    13_125
  );

  const gapOnly = mergeCaptureIntoEditorProject(createSplitProject(), {
    ...captureState,
    segments: [
      { ...captureState.segments[0], startSeconds: 11.8, endSeconds: 12.4 },
      ...captureState.segments.slice(1)
    ]
  });
  const gapReplacement = gapOnly.clips.filter((clip) => clip.selectionId === "first");
  assert.equal(gapReplacement.length, 1);
  assert.equal(gapReplacement[0].id, "clip-first");
  assert.deepEqual([
    gapReplacement[0].sourceStartMs,
    gapReplacement[0].sourceEndMs
  ], [11_800, 12_400]);
  assert.equal(gapOnly.subtitles.some((cue) => cue.id === "split-after-cue"), false);
  assert.equal(gapOnly.selectedCueId, null);
  assert.equal(gapOnly.selectedClipId, "clip-first");

  const bothSides = mergeCaptureIntoEditorProject(createSplitProject(), {
    ...captureState,
    segments: [
      { ...captureState.segments[0], startSeconds: 11, endSeconds: 14 },
      ...captureState.segments.slice(1)
    ]
  });
  assert.deepEqual(
    bothSides.clips.filter((clip) => clip.selectionId === "first").map((clip) => [
      clip.sourceStartMs,
      clip.sourceEndMs
    ]),
    [[11_000, 11_625], [12_625, 14_000]]
  );

  const exactMinimum = mergeCaptureIntoEditorProject(createSplitProject(), {
    ...captureState,
    segments: [
      { ...captureState.segments[0], startSeconds: 11.525, endSeconds: 12.725 },
      ...captureState.segments.slice(1)
    ]
  });
  assert.deepEqual(
    exactMinimum.clips.filter((clip) => clip.selectionId === "first").map((clip) => (
      clip.sourceEndMs - clip.sourceStartMs
    )),
    [100, 100]
  );
  assert.equal(
    new Set(exactMinimum.clips.map((clip) => clip.id)).size,
    exactMinimum.clips.length
  );
});

test("기존 편집 순서와 trim을 유지하면서 새 사용자 선택을 동기화한다", () => {
  let project = createEditorProjectFromCapture(captureState);
  const cue = createSubtitleCue(project, {
    id: "kept",
    clipId: "clip-first",
    text: "유지"
  });
  project = { ...project, subtitles: [cue] };
  project = reorderClip(project, "clip-second", 0);
  project = updateClipTrim(project, "clip-first", {
    sourceStartMs: 11_000,
    sourceEndMs: 15_000
  });
  const merged = mergeCaptureIntoEditorProject(project, {
    ...captureState,
    segments: [
      { ...captureState.segments[0], startSeconds: 9, endSeconds: 16 },
      ...captureState.segments.slice(1),
      { id: "third", startSeconds: 50, endSeconds: 52, description: "추가" }
    ]
  });
  assert.equal(merged.clips.length, 3);
  assert.equal(merged.subtitles[0].text, "유지");
  assert.deepEqual(merged.clips.map((clip) => clip.id), [
    "clip-second",
    "clip-first",
    "clip-third"
  ]);
  assert.equal(merged.clips[1].sourceStartMs, 11_000);
  assert.equal(merged.clips[1].sourceEndMs, 15_000);
  assert.equal(merged.clips[1].selectionStartMs, 9_000);
  assert.equal(merged.clips[1].selectionEndMs, 16_000);
});

test("캡처 구간 갱신은 음성 설정을 새 컷 경계로 자르고 선택 상태를 보존한다", () => {
  let project = createEditorProjectFromCapture(captureState);
  project = {
    ...project,
    audioRegions: [
      createAudioRegion(project, {
        id: "merged-audio",
        clipId: "clip-first",
        startOffsetMs: 500,
        endOffsetMs: 5_000,
        gain: 0.55
      }),
      createAudioRegion(project, {
        id: "discarded-audio",
        clipId: "clip-first",
        startOffsetMs: 0,
        endOffsetMs: 500,
        muted: true
      })
    ],
    selectedAudioRegionId: "merged-audio"
  };

  const merged = mergeCaptureIntoEditorProject(project, {
    ...captureState,
    segments: [
      { ...captureState.segments[0], startSeconds: 12, endSeconds: 14 },
      ...captureState.segments.slice(1)
    ]
  });
  assert.deepEqual(merged.audioRegions.map((region) => ({
    id: region.id,
    startOffsetMs: region.startOffsetMs,
    endOffsetMs: region.endOffsetMs,
    gain: region.gain
  })), [{
    id: "merged-audio",
    startOffsetMs: 0,
    endOffsetMs: 2_000,
    gain: 0.55
  }]);
  assert.equal(merged.selectedAudioRegionId, "merged-audio");
});

test("캡처 구간 갱신은 이미지 에셋을 새 컷 경계로 자르고 선택 상태를 보존한다", () => {
  let project = createEditorProjectFromCapture(captureState);
  project = {
    ...project,
    imageAssets: [
      createImageAsset(project, {
        id: "merged-asset",
        clipId: "clip-first",
        startOffsetMs: 500,
        endOffsetMs: 5_000,
        mimeType: "image/png",
        blobKey: "asset/merged",
        x: 0.8,
        opacity: 0.6
      }),
      createImageAsset(project, {
        id: "discarded-asset",
        clipId: "clip-first",
        startOffsetMs: 0,
        endOffsetMs: 500,
        mimeType: "image/gif",
        blobKey: "asset/discarded"
      })
    ],
    selectedImageAssetId: "merged-asset"
  };

  const merged = mergeCaptureIntoEditorProject(project, {
    ...captureState,
    segments: [
      { ...captureState.segments[0], startSeconds: 12, endSeconds: 14 },
      ...captureState.segments.slice(1)
    ]
  });
  assert.deepEqual(merged.imageAssets.map((asset) => ({
    id: asset.id,
    startOffsetMs: asset.startOffsetMs,
    endOffsetMs: asset.endOffsetMs,
    x: asset.x,
    opacity: asset.opacity
  })), [{
    id: "merged-asset",
    startOffsetMs: 0,
    endOffsetMs: 2_000,
    x: 0.8,
    opacity: 0.6
  }]);
  assert.equal(merged.selectedImageAssetId, "merged-asset");
});

test("동일한 캡처를 다시 열어도 편집기에서 확장한 컷과 그 자막을 되돌리지 않는다", () => {
  let project = createEditorProjectFromCapture(captureState);
  project = updateClipTrim(project, "clip-first", {
    sourceStartMs: 8_000,
    sourceEndMs: 17_000
  });
  project = {
    ...project,
    subtitles: [
      createSubtitleCue(project, {
        id: "expanded-cue",
        clipId: "clip-first",
        startOffsetMs: 500,
        endOffsetMs: 1_500,
        text: "원래 캡처보다 앞선 편집기 자막"
      })
    ],
    selectedCueId: "expanded-cue"
  };

  const merged = mergeCaptureIntoEditorProject(project, captureState);
  const first = merged.clips.find((clip) => clip.id === "clip-first");
  assert.equal(first.sourceStartMs, 8_000);
  assert.equal(first.sourceEndMs, 17_000);
  assert.equal(merged.subtitles[0].id, "expanded-cue");
  assert.equal(merged.subtitles[0].startOffsetMs, 500);
  assert.equal(merged.subtitles[0].endOffsetMs, 1_500);
});

test("사이드패널 선택이 기존 trim과 겹치지 않으면 새 사용자 선택으로 되돌린다", () => {
  let project = createEditorProjectFromCapture(captureState);
  project = updateClipTrim(project, "clip-first", {
    sourceStartMs: 11_000,
    sourceEndMs: 15_000
  });
  project = {
    ...project,
    subtitles: [
      createSubtitleCue(project, {
        id: "old-cue",
        clipId: "clip-first",
        startOffsetMs: 200,
        endOffsetMs: 1_000,
        text: "이전 범위 자막"
      })
    ],
    selectedCueId: "old-cue"
  };
  const merged = mergeCaptureIntoEditorProject(project, {
    ...captureState,
    segments: [
      { ...captureState.segments[0], startSeconds: 30, endSeconds: 40 },
      ...captureState.segments.slice(1)
    ]
  });
  const first = merged.clips.find((clip) => clip.id === "clip-first");
  assert.equal(first.sourceStartMs, 30_000);
  assert.equal(first.sourceEndMs, 40_000);
  assert.equal(first.selectionStartMs, 30_000);
  assert.equal(first.selectionEndMs, 40_000);
  assert.equal(merged.subtitles.some((cue) => cue.id === "old-cue"), false);
  assert.equal(merged.selectedCueId, null);
});

test("정렬 오프셋 뒤에 들어온 캡처 갱신과 새 구간도 같은 로컬 원본 축을 쓴다", () => {
  let project = createEditorProjectFromCapture(captureState);
  project = applyMediaAlignmentOffset(project, 2_000);
  const merged = mergeCaptureIntoEditorProject(project, {
    ...captureState,
    segments: [
      ...captureState.segments,
      { id: "third", startSeconds: 50, endSeconds: 52, description: "추가" }
    ]
  });
  assert.equal(merged.clips[0].sourceStartMs, 12_125);
  assert.equal(merged.clips[0].sourceEndMs, 17_750);
  assert.equal(merged.clips[0].selectionStartMs, 10_125);
  assert.equal(merged.clips[2].sourceStartMs, 52_000);
  assert.equal(merged.clips[2].selectionStartMs, 50_000);
});

test("정렬값 때문에 로컬 원본 시작보다 앞서는 새 선택은 조용히 변형하지 않는다", () => {
  let project = createEditorProjectFromCapture(captureState);
  project = applyMediaAlignmentOffset(project, -5_000);
  assert.throws(
    () => mergeCaptureIntoEditorProject(project, {
      ...captureState,
      segments: [
        ...captureState.segments,
        { id: "invalid", startSeconds: 2, endSeconds: 3, description: "원본 밖 선택" }
      ]
    }),
    /로컬 원본 시작보다 앞/
  );
});

test("수정된 자막을 SRT로 내보낸다", () => {
  let project = createEditorProjectFromCapture(captureState);
  project = {
    ...project,
    subtitles: [
      createSubtitleCue(project, {
        clipId: "clip-first",
        startOffsetMs: 250,
        endOffsetMs: 1_750,
        text: "안녕하세요"
      })
    ]
  };
  assert.match(serializeSrt(project), /00:00:00,250 --> 00:00:01,750/);
  assert.match(serializeSrt(project), /안녕하세요/);
});

test("겹치는 자막 구간을 식별해 미리보기와 burn 결과 불일치를 막는다", () => {
  let project = createEditorProjectFromCapture(captureState);
  project = {
    ...project,
    subtitles: [
      createSubtitleCue(project, {
        id: "cue-a",
        clipId: "clip-first",
        startOffsetMs: 0,
        endOffsetMs: 1_500,
        text: "첫 자막"
      }),
      createSubtitleCue(project, {
        id: "cue-b",
        clipId: "clip-first",
        startOffsetMs: 1_000,
        endOffsetMs: 2_000,
        text: "둘째 자막"
      })
    ]
  };
  assert.deepEqual(findSubtitleOverlaps(project), [{
    firstCueId: "cue-a",
    secondCueId: "cue-b",
    startMs: 1_000,
    endMs: 1_500
  }]);
  project.subtitles[1].startOffsetMs = 1_500;
  assert.deepEqual(findSubtitleOverlaps(project), []);
});

test("빈 자막도 시간 구간을 점유해 텍스트 재입력 우회를 허용하지 않는다", () => {
  let project = createEditorProjectFromCapture(captureState);
  project = {
    ...project,
    subtitles: [
      createSubtitleCue(project, {
        id: "cue-a",
        clipId: "clip-first",
        startOffsetMs: 0,
        endOffsetMs: 1_500,
        text: "첫 자막"
      }),
      createSubtitleCue(project, {
        id: "cue-empty",
        clipId: "clip-first",
        startOffsetMs: 1_000,
        endOffsetMs: 2_000,
        text: ""
      })
    ]
  };
  assert.deepEqual(findSubtitleOverlaps(project), [{
    firstCueId: "cue-a",
    secondCueId: "cue-empty",
    startMs: 1_000,
    endMs: 1_500
  }]);
});
