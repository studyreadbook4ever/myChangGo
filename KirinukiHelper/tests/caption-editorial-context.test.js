import assert from "node:assert/strict";
import test from "node:test";

import {
  CAPTION_EDITORIAL_CONTEXT_SCHEMA,
  MAX_CAPTION_GLOSSARY_ENTRIES,
  MAX_CAPTION_SPEAKERS,
  buildProjectCaptionEditorialContext,
  canonicalCaptionSpeakerId,
  captionEditorialContextFingerprint,
  normalizeCaptionEditorialContext
} from "../src/caption-agent/editorial-context.js";

function projectFixture() {
  return {
    id: "project-context",
    name: "맨시티 키리누키",
    source: {
      streamerName: "에스더 카린"
    },
    clips: [{ id: "clip-1" }],
    subtitles: [{
      clipId: "clip-1",
      startOffsetMs: 0,
      text: "맨시티 진짜 좋다",
      origin: "ai",
      humanEdited: true,
      remoteMeta: { speakerId: "main" }
    }, {
      clipId: "clip-1",
      startOffsetMs: 1_000,
      text: "맨시티 완전 좋다",
      origin: "ai",
      humanEdited: true,
      remoteMeta: { speakerId: "karin" }
    }, {
      clipId: "clip-1",
      startOffsetMs: 2_000,
      text: "아직 검수하지 않은 문구",
      origin: "ai",
      humanEdited: false,
      remoteMeta: { speakerId: "카린" }
    }]
  };
}

test("프로젝트 편집 문맥은 사람 검수 표기만 bounded 용어·문체 기억으로 만든다", () => {
  const context = buildProjectCaptionEditorialContext(projectFixture());

  assert.equal(context.schema, CAPTION_EDITORIAL_CONTEXT_SCHEMA);
  assert(context.glossary.length <= MAX_CAPTION_GLOSSARY_ENTRIES);
  assert(context.speakers.length <= MAX_CAPTION_SPEAKERS);
  assert(context.glossary.some(({ term }) => term === "맨시티"));
  assert.deepEqual(context.style.examples, [
    "맨시티 진짜 좋다",
    "맨시티 완전 좋다"
  ]);
  assert.equal(
    context.style.examples.includes("아직 검수하지 않은 문구"),
    false
  );
  assert.match(
    captionEditorialContextFingerprint(context),
    /^ctx-v1-[0-9a-f]{16}$/u
  );
});

test("main·로마자·한글 스트리머 별칭은 한 canonical speaker로 결정된다", () => {
  const context = buildProjectCaptionEditorialContext(projectFixture());

  assert.equal(canonicalCaptionSpeakerId("main", context), "main");
  assert.equal(canonicalCaptionSpeakerId("karin", context), "main");
  assert.equal(canonicalCaptionSpeakerId("카린", context), "main");
  assert.equal(canonicalCaptionSpeakerId("speaker-2", context), "speaker-2");
});

test("외부 편집 문맥은 unknown field와 폭주 배열을 strict mode에서 거절한다", () => {
  const valid = buildProjectCaptionEditorialContext(projectFixture());
  assert.deepEqual(
    normalizeCaptionEditorialContext(valid, { strict: true }),
    valid
  );
  assert.throws(
    () => normalizeCaptionEditorialContext({
      ...valid,
      hiddenPrompt: "허용되지 않음"
    }, { strict: true }),
    /unsupported fields/u
  );
  assert.throws(
    () => normalizeCaptionEditorialContext({
      ...valid,
      glossary: Array.from(
        { length: MAX_CAPTION_GLOSSARY_ENTRIES + 1 },
        (_, index) => ({ term: `용어-${index}`, variants: [] })
      )
    }, { strict: true }),
    /too large/u
  );
});
