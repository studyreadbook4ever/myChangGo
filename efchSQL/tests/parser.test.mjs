import test from "node:test";
import assert from "node:assert/strict";

import { parseQuery, QuerySyntaxError } from "../src/query-parser.js";

test("parses a complete efchSQL query", () => {
  const query = parseQuery(`
    SELECT id, body FROM feed
    WHERE language = 'ko' AND (ageHours <= 48 OR pinned = true)
    PREFER database: 2.5, ads: -1, "local news": 0.4
    LIMIT 12
    MODE EXACT;
  `);

  assert.deepEqual(query.select, ["id", "body"]);
  assert.equal(query.from, "feed");
  assert.deepEqual(query.prefer, {
    database: 2.5,
    ads: -1,
    "local news": 0.4,
  });
  assert.equal(query.limit, 12);
  assert.equal(query.mode, "exact");
  assert.equal(query.budget, null);
  assert.equal(query.where.type, "and");
  assert.deepEqual(query.where.left, {
    type: "predicate",
    field: "language",
    operator: "=",
    value: "ko",
  });
  assert.equal(query.where.right.type, "or");
});

test("parses IN, NOT, CONTAINS, NULL, comments and unicode symbols", () => {
  const query = parseQuery(`
    SELECT * FROM feed -- only visible Korean posts
    WHERE language IN ('ko', 'en')
      AND NOT muted = true
      AND symbols CONTAINS '시스템'
      AND deletedAt IS NULL
    PREFER 시스템 = 3, 광고 = -2
    LIMIT 5 MODE APPROX BUDGET 80
  `);

  assert.equal(query.where.type, "and");
  assert.deepEqual(query.prefer, { 시스템: 3, 광고: -2 });
  assert.equal(query.mode, "approx");
  assert.equal(query.budget, 80);
});

test("MODE BUDGET accepts a direct integer", () => {
  const query = parseQuery("SELECT * FROM feed PREFER ai 1 LIMIT 3 MODE BUDGET 25");
  assert.equal(query.mode, "approx");
  assert.equal(query.budget, 25);
});

test("defaults are useful for a tiny feed query", () => {
  const query = parseQuery("SELECT * FROM feed");
  assert.deepEqual(query.select, ["*"]);
  assert.equal(query.limit, 20);
  assert.equal(query.mode, "exact");
  assert.deepEqual(query.prefer, {});
  assert.equal(query.where, null);
});

test("reports malformed queries with a syntax position", () => {
  for (const sql of [
    "SELECT FROM feed",
    "SELECT * feed",
    "SELECT * FROM feed PREFER ai:",
    "SELECT * FROM feed LIMIT -1",
    "SELECT * FROM feed MODE TURBO",
    "SELECT * FROM feed WHERE score ~~ 2",
    "SELECT * FROM feed PREFER ai: 2,",
    "SELECT id, FROM feed",
  ]) {
    assert.throws(
      () => parseQuery(sql),
      (error) => error instanceof QuerySyntaxError && error.position !== undefined,
      sql,
    );
  }
});
