import test from "node:test";
import assert from "node:assert/strict";

import {
  EfchSQLEngine,
  createEngine,
  exhaustiveTopK,
  scoreRow,
} from "../src/engine.js";
import { PreferenceModel } from "../src/feedback.js";

function mulberry32(seed) {
  return function random() {
    let value = (seed += 0x6d2b79f5);
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function ids(result) {
  return result.results.map(({ row }) => row.id);
}

function scores(result) {
  return result.results.map(({ score }) => score);
}

test("scores sparse preferences and returns a deterministic top-K", () => {
  const rows = [
    { id: "b", baseScore: 1, symbols: ["db"] },
    { id: "a", baseScore: 1, symbols: ["db"] },
    { id: "c", baseScore: 4, symbols: ["ads"] },
  ];
  const engine = createEngine(rows, { blockSize: 1 });
  const result = engine.query(
    "SELECT * FROM feed PREFER db: 2, ads: -5 LIMIT 2 MODE EXACT",
  );

  assert.deepEqual(ids(result), ["a", "b"]);
  assert.deepEqual(scores(result), [3, 3]);
  assert.equal(result.rows[0].efchScore, 3);
  assert.equal(result.metrics.exact, true);
});

test("a live weight snapshot overrides rather than doubles SQL weights", () => {
  const rows = [
    { id: "base", baseScore: 3, symbols: [] },
    { id: "topic", baseScore: 0, symbols: ["db"] },
  ];
  const result = createEngine(rows).query(
    "SELECT * FROM feed PREFER db: 2 LIMIT 2 MODE EXACT",
    { weights: { db: 2 } },
  );
  assert.deepEqual(ids(result), ["base", "topic"]);
  assert.deepEqual(scores(result), [3, 2]);
});

test("tiny non-zero weights and normalized collisions are preserved exactly", () => {
  const rows = [
    { id: "tiny-wins", baseScore: 0, symbols: { tiny: 1e20 } },
    { id: "baseline", baseScore: 999, symbols: {} },
  ];
  const result = createEngine(rows, { blockSize: 1 }).query({
    type: "select",
    from: "feed",
    select: ["*"],
    prefer: { tiny: 1e-17 },
    limit: 1,
    mode: "exact",
  });
  assert.deepEqual(ids(result), ["tiny-wins"]);
  assert.ok(result.results[0].score > 999);
  assert.equal(
    scoreRow({ baseScore: 0, symbols: { ai: 1 } }, { AI: 1, ai: 2 }),
    3,
  );
});

test("WHERE filtering supports nested paths, boolean logic and CONTAINS", () => {
  const rows = [
    { id: 1, author: { active: true }, language: "ko", symbols: ["db"], baseScore: 1 },
    { id: 2, author: { active: false }, language: "ko", symbols: ["db"], baseScore: 3 },
    { id: 3, author: { active: true }, language: "en", symbols: ["art"], baseScore: 4 },
  ];
  const result = createEngine(rows).query(`
    SELECT id, language FROM feed
    WHERE author.active = true AND symbols CONTAINS db
    PREFER db: 1 LIMIT 10 MODE EXACT
  `);

  assert.deepEqual(ids(result), [1]);
  assert.deepEqual(result.rows[0], { id: 1, language: "ko", efchScore: 2 });
});

test("WHERE and projection only traverse own properties", () => {
  const inherited = { secret: true };
  const row = Object.assign(Object.create(inherited), {
    id: 1,
    baseScore: 1,
    visible: true,
    bag: Object.assign(Object.create({ ghost: true }), { real: true }),
  });
  const engine = createEngine([row]);
  assert.deepEqual(
    ids(engine.query("SELECT * FROM feed WHERE secret = true LIMIT 5 MODE EXACT")),
    [],
  );
  assert.deepEqual(
    ids(engine.query("SELECT * FROM feed WHERE bag CONTAINS ghost LIMIT 5 MODE EXACT")),
    [],
  );
  const projected = engine.query(
    "SELECT secret, visible FROM feed WHERE visible = true LIMIT 5 MODE EXACT",
  );
  assert.deepEqual(projected.rows[0], {
    secret: undefined,
    visible: true,
    efchScore: 1,
  });
});

test("refiners receive a detached frozen query snapshot", () => {
  const query = {
    type: "select",
    from: "feed",
    select: ["*"],
    where: {
      type: "predicate",
      field: "active",
      operator: "=",
      value: true,
    },
    prefer: {},
    limit: 2,
    mode: "exact",
  };
  const rows = [
    { id: 1, active: true, baseScore: 3 },
    { id: 2, active: true, baseScore: 2 },
    { id: 3, active: false, baseScore: 100 },
  ];
  let mutationAttempts = 0;
  const result = createEngine(rows, { blockSize: 1 }).query(query, {
    refiner: {
      maxContribution: 0,
      score(_row, context) {
        assert.equal(Object.isFrozen(context), true);
        assert.equal(Object.isFrozen(context.query), true);
        assert.equal(Object.isFrozen(context.query.where), true);
        assert.equal(Object.isFrozen(context.weights), true);
        try {
          context.query.where.value = false;
        } catch {
          mutationAttempts += 1;
        }
        return 0;
      },
    },
  });
  assert.deepEqual(ids(result), [1, 2]);
  assert.equal(mutationAttempts, 2);
  assert.equal(query.where.value, true);
  assert.notEqual(result.query.where, query.where);
});

test("programmatic WHERE functions are wrapped and frozen in the query snapshot", () => {
  function predicate(row) {
    return row.active === this.settings.enabled && this.settings === this.alias;
  }
  const settings = { enabled: true };
  Object.defineProperty(predicate, "settings", {
    value: settings,
    enumerable: false,
  });
  predicate.alias = settings;
  const result = createEngine([
    { id: 1, active: true, baseScore: 2 },
    { id: 2, active: false, baseScore: 1 },
  ]).query(
    {
      type: "select",
      from: "feed",
      select: ["*"],
      where: predicate,
      prefer: {},
      limit: 2,
      mode: "exact",
    },
    {
      refiner: {
        maxContribution: 0,
        score(_row, context) {
          assert.notEqual(context.query.where, predicate);
          assert.equal(Object.isFrozen(context.query.where), true);
          assert.equal(Object.isFrozen(context.query.where.settings), true);
          assert.equal(context.query.where.settings, context.query.where.alias);
          assert.throws(() => {
            context.query.where.settings.enabled = false;
          }, TypeError);
          return 0;
        },
      },
    },
  );
  assert.deepEqual(ids(result), [1]);
  assert.equal(predicate.settings.enabled, true);
});

test("exact block upper bounds can score only one percent of a sharp workload", () => {
  const rows = [];
  for (let block = 0; block < 100; block += 1) {
    for (let offset = 0; offset < 10; offset += 1) {
      rows.push({
        id: block * 10 + offset,
        baseScore: 0,
        symbols: { wanted: block === 37 ? 100 - offset : 0, noise: offset / 10 },
      });
    }
  }

  const engine = createEngine(rows, { blockSize: 10 });
  const fast = engine.query("SELECT * FROM feed PREFER wanted: 1 LIMIT 10 MODE EXACT");
  const baseline = engine.exhaustive(
    "SELECT * FROM feed PREFER wanted: 1 LIMIT 10 MODE EXACT",
  );

  assert.deepEqual(ids(fast), ids(baseline));
  assert.deepEqual(scores(fast), scores(baseline));
  assert.equal(fast.metrics.scoredRows, 10);
  assert.equal(fast.metrics.scoreEvaluationRatio, 0.01);
  assert.equal(fast.metrics.blocksVisited, 1);
  assert.equal(fast.metrics.blocksSkipped, 99);
  assert.equal(fast.metrics.exact, true);
});

test("exact top-K equals exhaustive across many seeded mixed-sign workloads", () => {
  const symbols = ["systems", "science", "music", "sports", "ads", "local"];

  for (let seed = 1; seed <= 40; seed += 1) {
    const random = mulberry32(seed);
    const rows = Array.from({ length: 173 }, (_, id) => {
      const sparse = {};
      for (const symbol of symbols) {
        if (random() < 0.32) {
          // Include negative feature values to exercise both block minima/maxima.
          sparse[symbol] = Math.round((random() * 3 - 0.5) * 100) / 100;
        }
      }
      return {
        id,
        language: random() < 0.7 ? "ko" : "en",
        baseScore: Math.round((random() * 4 - 2) * 100) / 100,
        symbols: sparse,
      };
    });
    const weights = {};
    for (const symbol of symbols) {
      weights[symbol] = Math.round((random() * 6 - 3) * 100) / 100;
    }
    const limit = 1 + Math.floor(random() * 25);
    const query = {
      type: "select",
      select: ["*"],
      from: "feed",
      where: {
        type: "predicate",
        field: "language",
        operator: seed % 2 ? "=" : "!=",
        value: "en",
      },
      prefer: weights,
      limit,
      mode: "exact",
    };

    const engine = new EfchSQLEngine(rows, {
      blockSize: 3 + (seed % 19),
    });
    const fast = engine.query(query);
    const slow = engine.exhaustive(query);
    assert.deepEqual(ids(fast), ids(slow), `ids differ at seed ${seed}`);
    assert.deepEqual(scores(fast), scores(slow), `scores differ at seed ${seed}`);
    assert.equal(fast.metrics.exact, true);
  }
});

test("safe refiners preserve exactness while skipping expensive calls", () => {
  const rows = Array.from({ length: 500 }, (_, id) => ({
    id,
    baseScore: id < 10 ? 50 - id : 0,
    symbols: { chosen: id < 10 ? 1 : 0 },
    hiddenQuality: (id % 7) / 10,
  }));
  const refiner = {
    maxContribution: 0.6,
    score(row) {
      return row.hiddenQuality;
    },
  };
  const query = "SELECT * FROM feed PREFER chosen: 10 LIMIT 10 MODE EXACT";
  const engine = createEngine(rows, { blockSize: 10 });
  const fast = engine.query(query, { refiner });
  const slow = exhaustiveTopK(rows, query, {
    engineOptions: { blockSize: 10 },
    refiner,
  });

  assert.deepEqual(ids(fast), ids(slow));
  assert.deepEqual(scores(fast), scores(slow));
  assert.equal(fast.metrics.refinedRows, 10);
  assert.equal(slow.metrics.refinedRows, 500);
  assert.equal(fast.metrics.exact, true);
});

test("row-specific refiner upper bounds are checked", () => {
  const rows = [
    { id: 1, baseScore: 2, symbols: [], hidden: 0.2 },
    { id: 2, baseScore: 1, symbols: [], hidden: 2 },
  ];
  const engine = createEngine(rows, { blockSize: 1 });

  assert.throws(
    () =>
      engine.query("SELECT * FROM feed LIMIT 2 MODE EXACT", {
        refiner: {
          upperBound: () => 1,
          score: (row) => row.hidden,
        },
      }),
    /contract violated/,
  );

  // The exhaustive oracle never consults pruning hints, so it remains a valid
  // baseline even when a caller supplied a broken bound.
  const baseline = engine.exhaustive("SELECT * FROM feed LIMIT 2 MODE EXACT", {
    refiner: {
      upperBound: () => {
        throw new Error("must not run in exhaustive mode");
      },
      score: (row) => row.hidden,
    },
  });
  assert.deepEqual(ids(baseline), [2, 1]);
});

test("row-specific refiner bounds receive the frozen cheap-score context", () => {
  const contexts = [];
  const rows = [
    { id: 1, baseScore: 2, symbols: { db: 1 }, hidden: 0.2 },
    { id: 2, baseScore: 1, symbols: { db: 1 }, hidden: 0.1 },
  ];
  const result = createEngine(rows, { blockSize: 1 }).query(
    "SELECT * FROM feed PREFER db: 3 LIMIT 1 MODE EXACT",
    {
      refiner: {
        upperBound(row, context) {
          contexts.push([row.id, context.cheapScore, Object.isFrozen(context)]);
          return row.hidden;
        },
        score: (row) => row.hidden,
      },
    },
  );
  assert.deepEqual(ids(result), [1]);
  assert.deepEqual(contexts, [
    [1, 5, true],
    [2, 4, true],
  ]);
});

test("budget mode is explicit about approximation", () => {
  const rows = Array.from({ length: 100 }, (_, id) => ({
    id,
    baseScore: 0,
    symbols: { same: 1 },
  }));
  const engine = createEngine(rows, { blockSize: 10 });
  const result = engine.query(
    "SELECT * FROM feed PREFER same: 1 LIMIT 5 MODE APPROX BUDGET 12",
  );

  assert.equal(result.metrics.scoredRows, 12);
  assert.equal(result.metrics.budgetHit, true);
  assert.equal(result.metrics.exact, false);
  assert.equal(result.results.length, 5);
});

test("K boundaries and live feedback snapshots stay equal to exhaustive", () => {
  const rows = [
    { id: "db", baseScore: 1, symbols: ["database", "systems"] },
    { id: "art", baseScore: 2, symbols: ["design"] },
    { id: "noise", baseScore: 3, symbols: ["hype"] },
  ];
  const engine = createEngine(rows, { blockSize: 1 });
  const profile = new PreferenceModel({ weights: { systems: 1.5 } });

  for (const limit of [0, 1, rows.length + 4]) {
    const query = {
      type: "select",
      from: "feed",
      select: ["*"],
      prefer: profile.snapshot(),
      limit,
      mode: "exact",
    };
    assert.deepEqual(ids(engine.query(query)), ids(engine.exhaustive(query)));
  }

  profile.like(rows[0]);
  profile.dislike(rows[2]);
  const updatedQuery = {
    type: "select",
    from: "feed",
    select: ["*"],
    prefer: profile.snapshot(),
    limit: 2,
    mode: "exact",
  };
  const fast = engine.query(updatedQuery);
  const slow = engine.exhaustive(updatedQuery);
  assert.deepEqual(ids(fast), ids(slow));
  assert.deepEqual(scores(fast), scores(slow));
  assert.equal(ids(fast)[0], "db");
});

test("scoreRow works without constructing an engine", () => {
  assert.equal(
    scoreRow(
      { baseScore: 1, symbols: { AI: 0.5, ads: 1 } },
      { ai: 4, ads: -2 },
    ),
    1,
  );
  assert.equal(Object.is(scoreRow({ baseScore: -0, symbols: {} }, {}), 0), true);
  assert.throws(
    () => scoreRow({ baseScore: 0, symbols: ["ai"] }, { ai: Number.NaN }),
    /must be finite/,
  );
  assert.throws(
    () => createEngine([{ id: "broken", baseScore: Number.POSITIVE_INFINITY }]),
    /must be finite/,
  );
});

test("IDs have a total deterministic order including infinities and NaN", () => {
  const rows = [
    { id: Number.NaN, baseScore: 1 },
    { id: Number.POSITIVE_INFINITY, baseScore: 1 },
    { id: 2, baseScore: 1 },
    { id: Number.NEGATIVE_INFINITY, baseScore: 1 },
    { id: Number.NaN, baseScore: 1 },
  ];
  const engine = createEngine(rows, { blockSize: 1 });
  const fast = engine.query("SELECT * FROM feed LIMIT 5 MODE EXACT");
  const slow = engine.exhaustive("SELECT * FROM feed LIMIT 5 MODE EXACT");
  assert.deepEqual(ids(fast), [
    Number.NEGATIVE_INFINITY,
    2,
    Number.POSITIVE_INFINITY,
    Number.NaN,
    Number.NaN,
  ]);
  assert.deepEqual(ids(fast), ids(slow));
  assert.equal(fast.results[3].row, rows[0]);
  assert.equal(fast.results[4].row, rows[4]);
});

test("invalid query inputs, feature values and arithmetic overflow fail loudly", () => {
  const engine = createEngine([{ id: 1, baseScore: 0, symbols: { ai: 1 } }]);
  for (const query of [null, undefined, 42, true, []]) {
    assert.throws(() => engine.query(query), /SELECT string or parsed SELECT object/);
  }
  assert.throws(
    () => scoreRow({ baseScore: Number.NaN, symbols: {} }, {}),
    /base score.*finite/i,
  );
  assert.throws(
    () => createEngine([{ id: 1, symbols: { ai: Number.POSITIVE_INFINITY } }]),
    /finite/,
  );
  assert.throws(
    () => scoreRow({ baseScore: 0, symbols: { ai: Number.MAX_VALUE } }, { ai: 2 }),
    /not finite/,
  );
  assert.throws(
    () => scoreRow(
      { baseScore: 0, symbols: { ai: 1 } },
      { AI: Number.MAX_VALUE, ai: Number.MAX_VALUE },
    ),
    /not finite/,
  );
  assert.throws(
    () =>
      createEngine([{ id: 1, baseScore: Number.MAX_VALUE }]).query(
        "SELECT * FROM feed LIMIT 1 MODE EXACT",
        {
        refiner: {
          maxContribution: Number.MAX_VALUE,
          score: () => Number.MAX_VALUE,
        },
        },
      ),
    /Total score.*not finite/,
  );
});
