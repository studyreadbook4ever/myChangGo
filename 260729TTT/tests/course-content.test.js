import test from "node:test";
import assert from "node:assert/strict";

import {
  CAPSTONE_FIELDS,
  CAPSTONE_RUBRIC,
  CASES,
  COURSE_PARTS,
  GLOSSARY,
} from "../src/course-content.js";
import { SOURCES } from "../src/sources.js";

const lessons = COURSE_PARTS.flatMap((part) => part.lessons);
const sourceIds = new Set(SOURCES.map((source) => source.id));

function assertUniqueIds(items, label) {
  const ids = items.map((item) => item.id);
  assert.equal(new Set(ids).size, ids.length, `${label} IDs must be unique`);
  ids.forEach((id) => assert.match(id, /^[a-z0-9-]+$/, `${label} ID ${id} is not URL-safe`));
}

test("the public textbook has the promised simple 8-part, 40-lesson scale", () => {
  assert.equal(COURSE_PARTS.length, 8);
  assert.equal(lessons.length, 40);
  assertUniqueIds(COURSE_PARTS, "part");
  assertUniqueIds(lessons, "lesson");
  COURSE_PARTS.forEach((part) => {
    assert.ok(part.lessons.length >= 3 && part.lessons.length <= 7);
    assert.ok(part.title.length >= 2);
    assert.ok(part.summary.length >= 20);
    assert.ok(Array.isArray(part.learningObjectives));
    assert.ok(part.learningObjectives.length >= 3);
  });
});

test("every lesson carries explanation, a worked example, a misconception, and retrieval practice", () => {
  lessons.forEach((lesson) => {
    assert.ok(Number.isSafeInteger(lesson.minutes) && lesson.minutes >= 5);
    assert.ok(lesson.question.length >= 8);
    assert.ok(lesson.thesis.length >= 20);
    assert.ok(Array.isArray(lesson.sections) && lesson.sections.length >= 2);
    lesson.sections.forEach((section) => {
      assert.ok(section.heading.length >= 2);
      assert.ok(Array.isArray(section.paragraphs) && section.paragraphs.length >= 1);
      section.paragraphs.forEach((paragraph) => assert.ok(paragraph.length >= 35));
    });
    if (lesson.equation) {
      assert.ok(lesson.equation.expression.length >= 3);
      assert.ok(lesson.equation.readAs.length >= 10);
    }
    assert.ok(lesson.workedExample.title.length >= 3);
    assert.ok(lesson.workedExample.steps.length >= 3);
    lesson.workedExample.steps.forEach((step) => assert.ok(step.length >= 15));
    assert.ok(lesson.misconception.claim.length >= 8);
    assert.ok(lesson.misconception.correction.length >= 25);
    assert.equal(lesson.checkpoint.options.length, 3);
    assert.ok(Number.isSafeInteger(lesson.checkpoint.answer));
    assert.ok(
      lesson.checkpoint.answer >= 0 &&
        lesson.checkpoint.answer < lesson.checkpoint.options.length,
    );
    assert.ok(lesson.checkpoint.explanation.length >= 20);
    assert.ok(lesson.takeaway.length >= 15);
    assert.ok(Array.isArray(lesson.sourceIds) && lesson.sourceIds.length >= 1);
    lesson.sourceIds.forEach((id) =>
      assert.ok(sourceIds.has(id), `${lesson.id} references missing source ${id}`),
    );
  });
});

test("course prose is genuinely book-scale rather than forty empty cards", () => {
  const prose = lessons
    .flatMap((lesson) => [
      lesson.question,
      lesson.thesis,
      ...lesson.sections.flatMap((section) => [section.heading, ...section.paragraphs]),
      lesson.workedExample.title,
      ...lesson.workedExample.steps,
      lesson.misconception.claim,
      lesson.misconception.correction,
      lesson.checkpoint.prompt,
      ...lesson.checkpoint.options,
      lesson.checkpoint.explanation,
      lesson.takeaway,
    ])
    .join("");
  assert.ok(prose.length >= 45_000, `course prose is only ${prose.length} characters`);
});

test("case atlas, glossary, and capstone match the public promises", () => {
  assert.equal(CASES.length, 12);
  assert.equal(GLOSSARY.length, 80);
  assert.equal(CAPSTONE_FIELDS.length, 10);
  assert.ok(CAPSTONE_RUBRIC.length >= 8);
  assertUniqueIds(CASES, "case");
  assertUniqueIds(GLOSSARY, "glossary");
  assertUniqueIds(CAPSTONE_FIELDS, "capstone");
  const categories = new Set(["daily", "firm", "public", "ai"]);
  CASES.forEach((item) => {
    assert.ok(categories.has(item.category));
    assert.ok(typeof item.title === "string" && item.title.trim().length >= 2);
    assert.ok(
      typeof item.categoryLabel === "string" && item.categoryLabel.trim().length >= 2,
    );
    assert.ok(item.situation.length >= 30);
    assert.ok(item.decision.length >= 5);
    assert.ok(item.bottleneck.length >= 3);
    assert.ok(item.caution.length >= 10);
  });
  GLOSSARY.forEach((entry) => {
    assert.ok(entry.term.length >= 1);
    assert.ok(entry.definition.length >= 15);
    assert.ok(entry.caution.length >= 8);
  });
  CAPSTONE_FIELDS.forEach((field) => {
    assert.ok(typeof field.prompt === "string" && field.prompt.trim().length >= 5);
    assert.ok(typeof field.hint === "string" && field.hint.trim().length >= 5);
  });
  CAPSTONE_RUBRIC.forEach((item) => {
    assert.ok(typeof item.label === "string" && item.label.trim().length >= 1);
    assert.ok(typeof item.criterion === "string" && item.criterion.trim().length >= 10);
  });
});

test("source registry is traceable, typed, and uses secure direct links", () => {
  assert.equal(SOURCES.length, 44);
  assertUniqueIds(SOURCES, "source");
  const kinds = new Set([
    "1차 역사자료",
    "공식 해설",
    "동료심사",
    "워킹페이퍼",
    "프리프린트",
    "교육자료",
  ]);
  SOURCES.forEach((source) => {
    assert.ok(kinds.has(source.kind), `unexpected source kind ${source.kind}`);
    assert.match(source.url, /^https:\/\//);
    assert.ok(source.title.length >= 5);
    assert.ok(source.authors.length >= 2);
    assert.ok(Number.isSafeInteger(source.year));
    assert.ok(source.note.length >= 25);
  });
});
