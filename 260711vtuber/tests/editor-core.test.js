import assert from "node:assert/strict";
import test from "node:test";

import {
  EDITOR_SCHEMA,
  applyMediaAlignmentOffset,
  captureStateSourceConflict,
  captureProjectId,
  createEditorProjectFromCapture,
  createSubtitleCue,
  cueAtTimeline,
  cueTimelineRange,
  findSubtitleOverlaps,
  mapTimelineToSource,
  mergeCaptureIntoEditorProject,
  normalizeEditorProject,
  projectDurationMs,
  reorderClip,
  replaceAiSubtitleDraft,
  serializeSrt,
  sourceSessionIdentity,
  transcriptChunksToCueDrafts,
  updateClipTrim,
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

test("생방송과 다시보기는 채널·방송 시작 시각이 같으면 같은 회차로 연결한다", () => {
  const live = sourceSessionIdentity(captureState.source);
  const vod = sourceSessionIdentity({
    ...captureState.source,
    contentType: "vod",
    contentId: "11804294",
    canonicalUrl: "https://chzzk.naver.com/video/11804294"
  });
  assert.equal(vod, live);
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

  assert.equal(project.subtitles.length, 2);
  assert.equal(project.subtitles.find((cue) => cue.id === "draft-1")?.text, "검수본");
  assert.equal(project.subtitles.find((cue) => cue.id === "draft-2")?.text, "새 초안");
  assert.equal(project.subtitles.some((cue) => cue.id === "overlap"), false);
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
