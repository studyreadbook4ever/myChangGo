import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  CODEX_JOB_SCHEMA_VERSION,
  SCHEMA_VERSION,
  buildCodexJobManifest,
  compileCreatorPolicyMarkdown,
  createInitialState,
  createSegment,
  formatTimestamp,
  generateCodexStartHere,
  generateEditPrompt,
  normalizeState,
  parseTimestamp,
  resolveCreatorPolicies,
  sanitizeFileName,
  validateSegmentInput
} from "../extension/lib/core.js";

test("타임스탬프 입력을 초로 변환한다", () => {
  assert.equal(parseTimestamp("01:02:03"), 3723);
  assert.equal(parseTimestamp("62:03"), 3723);
  assert.equal(parseTimestamp("90.5"), 90.5);
  assert.equal(parseTimestamp("00:01:30.5"), 90.5);
});

test("잘못된 타임스탬프를 거절한다", () => {
  assert.equal(parseTimestamp(""), null);
  assert.equal(parseTimestamp("1:72"), null);
  assert.equal(parseTimestamp("00:60:00"), null);
  assert.equal(parseTimestamp("abc"), null);
  assert.equal(parseTimestamp(-1), null);
});

test("초를 uniform HH:MM:SS로 표시한다", () => {
  assert.equal(formatTimestamp(0), "00:00:00");
  assert.equal(formatTimestamp(3723), "01:02:03");
  assert.equal(formatTimestamp(90.5, { precision: 1 }), "00:01:30.5");
});

test("끝이 시작보다 뒤고 설명이 있어야 구간을 저장한다", () => {
  assert.deepEqual(validateSegmentInput({ startText: "00:01:00", endText: "00:01:30", description: "반응까지 살려줘" }), {
    ok: true,
    startSeconds: 60,
    endSeconds: 90,
    description: "반응까지 살려줘"
  });
  assert.equal(validateSegmentInput({ startText: "20", endText: "10", description: "설명" }).ok, false);
  assert.equal(validateSegmentInput({ startText: "10", endText: "20", description: "" }).ok, false);
});

test("저장 상태를 기본 스키마와 병합해 복구한다", () => {
  const restored = normalizeState({ projectName: "복구", source: { channelId: "channel" }, segments: null });
  assert.equal(restored.projectName, "복구");
  assert.equal(restored.source.platform, "CHZZK");
  assert.equal(restored.source.channelId, "channel");
  assert.deepEqual(restored.segments, []);
  assert.equal(createInitialState().schemaVersion, 1);
});

test("파일명에 사용할 수 없는 문자를 제거한다", () => {
  assert.equal(sanitizeFileName(" 방송/제목: 1화? "), "방송-제목- 1화");
  assert.equal(sanitizeFileName("***"), "chzzk-kirinuki-edit-brief");
});

test("내장 MD와 사용자 입력을 포함한 uniform Codex 프롬프트를 생성한다", async () => {
  const [guide, policy] = await Promise.all([
    readFile(new URL("../extension/knowledge/base-editing-guidelines.md", import.meta.url), "utf8"),
    readFile(new URL("../extension/knowledge/default-creator-policy.md", import.meta.url), "utf8")
  ]);
  const segments = [
    createSegment({
      id: "segment-1",
      startText: "00:10:00",
      endText: "00:11:15",
      description: "질문이 시작되는 지점부터 답변과 웃음이 끝날 때까지 사용",
      startCapture: { method: "html-video-currentTime", observedAt: "2026-07-11T01:00:00.000Z", rawSeconds: 600 },
      endCapture: { method: "html-video-currentTime", observedAt: "2026-07-11T01:01:15.000Z", rawSeconds: 675 }
    }),
    createSegment({
      id: "segment-2",
      startText: "00:30:00",
      endText: "00:31:00",
      description: "스트리머가 실수를 인정하는 두 번째 사건"
    })
  ];

  const prompt = generateEditPrompt({
    projectName: "테스트 방송",
    source: {
      platform: "CHZZK",
      url: "https://chzzk.naver.com/example",
      canonicalUrl: "https://chzzk.naver.com/example",
      channelId: "example",
      contentId: "live-1",
      contentType: "live",
      streamerName: "테스트 스트리머",
      broadcastTitle: "테스트 방송 제목",
      broadcastStartedAt: "2026-07-11 17:01:29",
      clipActive: true,
      timeMachineActive: true,
      category: "토크",
      observedAt: "2026-07-11T00:00:00.000Z"
    },
    globalInstruction: "빠른 호흡의 쇼츠로 만들 것",
    segments,
    editingGuideMarkdown: guide,
    creatorPolicyMarkdown: policy,
    generatedAt: "2026-07-11T02:00:00.000Z"
  });

  assert.match(prompt, new RegExp(SCHEMA_VERSION));
  assert.match(prompt, /테스트 스트리머/);
  assert.match(prompt, /방송 시작 시각\(CHZZK\): 2026-07-11 17:01:29/);
  assert.match(prompt, /치지직 클립 설정: 허용/);
  assert.match(prompt, /00:10:00/);
  assert.match(prompt, /질문이 시작되는 지점부터 답변과 웃음이 끝날 때까지 사용/);
  assert.match(prompt, /기본 키리누키 편집 지침/);
  assert.match(prompt, /등록된 아티스트별 정책 출처 후보/);
  assert.match(prompt, /policy-check\.md/);
  assert.match(prompt, /SOURCE_UNREADABLE/);
  assert.match(prompt, /edited-preview\.mp4/);
  assert.match(prompt, /subtitles\.ko\.srt/);

  const jsonBlock = prompt.match(/```json\n([\s\S]+?)\n```/);
  assert.ok(jsonBlock);
  const metadata = JSON.parse(jsonBlock[1]);
  assert.equal(metadata.schema, SCHEMA_VERSION);
  assert.equal(metadata.segments.length, 2);
  assert.equal(metadata.segments[0].anchorStartSeconds, 600);
  assert.equal(metadata.segments[1].userDescription, "스트리머가 실수를 인정하는 두 번째 사건");
  assert.equal(metadata.policyGates.revenueHumanReview, "PENDING");
  assert.equal(metadata.policyGates.musicHumanReview, "PENDING");
  assert.equal(metadata.policyGates.automaticPublication, "BLOCKED");
});

test("구간이 없으면 프롬프트를 만들지 않는다", () => {
  assert.throws(() => generateEditPrompt({ segments: [] }), /구간을 하나 이상/);
});

test("Codex 작업 폴더용 manifest를 uniform 규격으로 만든다", () => {
  const segment = createSegment({
    id: "session-anchor-1",
    startText: "100",
    endText: "160",
    description: "질문부터 결론과 반응까지"
  });
  const manifest = buildCodexJobManifest({
    projectName: "작업 폴더 테스트",
    source: { streamerName: "테스트 방송인", contentId: "vod-1" },
    globalInstruction: "문맥을 보존할 것",
    segments: [segment],
    generatedAt: "2026-07-11T03:00:00.000Z"
  });

  assert.equal(manifest.schema, CODEX_JOB_SCHEMA_VERSION);
  assert.equal(manifest.status, "AWAITING_SOURCE_VIDEO");
  assert.equal(manifest.inputs.fullVideo.expectedCount, 1);
  assert.equal(manifest.inputs.fullVideo.status, "USER_TO_ADD");
  assert.equal(manifest.userIntent.anchors[0].anchorStartSeconds, 100);
  assert.equal(manifest.inputs.creatorPolicyIndex, "creator-policy-index.json");
  assert.equal(manifest.inputs.creatorPolicyCache.authority, "FALLBACK_ONLY");
  assert.equal(manifest.policyGates.revenueHumanReview, "PENDING");
  assert.equal(manifest.execution.automaticPublication, "FORBIDDEN");
  assert.deepEqual(manifest.execution.requiredOutputs, [
    "policy-check.md",
    "edited-preview.mp4",
    "edit-plan.json",
    "subtitles.ko.srt",
    "review-notes.md"
  ]);
});

test("START_HERE는 코딩 없는 Codex 전달 절차와 사람 검수 게이트를 제공한다", () => {
  const startHere = generateCodexStartHere({
    projectName: "테스트",
    source: { streamerName: "방송인" },
    generatedAt: "2026-07-11T03:00:00.000Z"
  });

  assert.match(startHere, /풀영상 파일 \*\*하나만\*\*/);
  assert.match(startHere, /이 폴더의 AGENTS\.md/);
  assert.match(startHere, /HUMAN_REVENUE_REVIEW: PENDING/);
  assert.match(startHere, /HUMAN_MUSIC_REVIEW: PENDING/);
  assert.match(startHere, /원본 영상은 변경하지 마/);
});

test("아티스트 정책 링크와 필수 안전 게이트가 기본 정책에 등록되어 있다", async () => {
  const policy = await readFile(new URL("../extension/knowledge/default-creator-policy.md", import.meta.url), "utf8");
  const links = [
    "https://cafe.naver.com/tteokbokk1/709417",
    "https://cafe.naver.com/vkpopstar/1174",
    "https://cafe.naver.com/projectiofficial/2",
    "https://cafe.naver.com/otwoffical/6121",
    "https://cafe.naver.com/listellaofficial/3"
  ];

  for (const link of links) {
    assert.match(policy, new RegExp(link.replaceAll(".", "\\.")));
  }
  assert.match(policy, /HUMAN_REVENUE_REVIEW: PENDING/);
  assert.match(policy, /HUMAN_MUSIC_REVIEW: PENDING/);
  assert.match(policy, /제3자의 정책을 \*\*무조건 교차확인\*\*/);
  assert.match(policy, /LINK_ONLY \/ SOURCE_UNREADABLE \/ UNVERIFIED/);
});

test("정책 인덱스의 모든 방송인을 각 그룹 공식 링크에 정확히 연결한다", async () => {
  const index = JSON.parse(await readFile(new URL("../extension/knowledge/creator-policy-index.json", import.meta.url), "utf8"));
  assert.equal(index.schema, "chzzk-kirinuki-creator-policy-index/v2");
  assert.equal(index.policies.length, 5);

  for (const policy of index.policies) {
    assert.ok(policy.sourceUrl.startsWith("https://cafe.naver.com/"));
    assert.ok(policy.artists.length > 0);
    for (const artist of policy.artists) {
      const matches = resolveCreatorPolicies({ streamerName: artist }, index);
      assert.ok(matches.some((match) => match.id === policy.id && match.sourceUrl === policy.sourceUrl), `${artist} 정책 링크 매칭 실패`);
    }
  }
});

test("아리사를 카론유니버스W 공식 링크에 정확히 매칭하고 캐시 본문은 프롬프트에 넣지 않는다", async () => {
  const [indexText, basePolicy, snapshot] = await Promise.all([
    readFile(new URL("../extension/knowledge/creator-policy-index.json", import.meta.url), "utf8"),
    readFile(new URL("../extension/knowledge/default-creator-policy.md", import.meta.url), "utf8"),
    readFile(new URL("../extension/knowledge/creator-policies/charon-universe-w.md", import.meta.url), "utf8")
  ]);
  const index = JSON.parse(indexText);
  const matches = resolveCreatorPolicies({ streamerName: "아리사" }, index);

  assert.equal(matches.length, 1);
  assert.equal(matches[0].id, "charon-universe-w");
  assert.equal(matches[0].group, "카론유니버스W");
  assert.equal(matches[0].sourceUrl, "https://cafe.naver.com/vkpopstar/1174");
  assert.equal(matches[0].matchedBy.type, "artist");
  assert.equal(matches[0].cache.jobPath, "policy-cache/charon-universe-w.md");
  assert.equal(matches[0].cache.authority, "FALLBACK_ONLY");
  assert.equal(resolveCreatorPolicies({ streamerName: "아리" }, index).length, 0);

  const compiled = compileCreatorPolicyMarkdown({
    basePolicyMarkdown: basePolicy,
    resolvedPolicies: matches
  });
  assert.match(compiled, /아리사 → 카론유니버스W/);
  assert.match(compiled, /Official policy source: https:\/\/cafe\.naver\.com\/vkpopstar\/1174/);
  assert.match(compiled, /policy-cache\/charon-universe-w\.md/);
  assert.match(compiled, /Cache authority: `FALLBACK_ONLY`/);
  assert.doesNotMatch(compiled, /클립 기반 2차적 저작물/);
  assert.match(snapshot, /클립 기반 2차적 저작물/);
  assert.match(compiled, /HUMAN_REVENUE_REVIEW: PENDING/);
  assert.match(compiled, /HUMAN_MUSIC_REVIEW: PENDING/);

  const segment = createSegment({
    id: "arisa-anchor",
    startText: "100",
    endText: "120",
    description: "질문부터 반응까지"
  });
  const prompt = generateEditPrompt({
    projectName: "아리사 테스트",
    source: { streamerName: "아리사" },
    segments: [segment],
    creatorPolicyMarkdown: compiled,
    resolvedCreatorPolicies: matches,
    generatedAt: "2026-07-12T00:00:00.000Z"
  });
  const jsonBlock = prompt.match(/```json\n([\s\S]+?)\n```/);
  assert.ok(jsonBlock);
  const metadata = JSON.parse(jsonBlock[1]);
  assert.equal(metadata.creatorPolicyResolution[0].id, "charon-universe-w");
  assert.equal(metadata.creatorPolicyResolution[0].matchedBy.value, "아리사");
  assert.equal(metadata.creatorPolicyResolution[0].cache.available, true);
  assert.equal(metadata.creatorPolicyResolution[0].cache.authority, "FALLBACK_ONLY");
  assert.match(prompt, /https:\/\/cafe\.naver\.com\/vkpopstar\/1174/);
  assert.doesNotMatch(prompt, /클립 기반 2차적 저작물/);
});
