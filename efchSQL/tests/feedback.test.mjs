import test from "node:test";
import assert from "node:assert/strict";

import {
  PreferenceModel,
  applyFeedback,
  symbolEntries,
} from "../src/feedback.js";

test("like/dislike updates only symbols carried by the item", () => {
  const model = new PreferenceModel({
    weights: { existing: 0.7 },
    learningRate: 0.5,
  });

  model.like({ symbols: { systems: 1, science: 0.4 } });
  assert.deepEqual(model.toJSON(), {
    existing: 0.7,
    systems: 0.5,
    science: 0.2,
  });

  model.dislike(["systems", "ads"], { strength: 2 });
  assert.deepEqual(model.toJSON(), {
    existing: 0.7,
    systems: -0.5,
    science: 0.2,
    ads: -1,
  });
  assert.equal(model.interactions, 2);
});

test("weights are clamped, serializable, restorable and decayed explicitly", () => {
  const model = new PreferenceModel({
    weights: { AI: 3 },
    learningRate: 2,
    minWeight: -2,
    maxWeight: 4,
  });
  model.like(["ai", "ai"]);
  assert.equal(model.getWeight("AI"), 4);

  const restored = PreferenceModel.fromJSON(model.toJSON());
  assert.deepEqual(restored.toJSON(), { ai: 4 });
  restored.decay(0.5);
  assert.deepEqual(restored.snapshot(), { ai: 2 });
  restored.setWeight("ai", 0);
  assert.equal(restored.size, 0);
});

test("applyFeedback is pure and understands numeric signals", () => {
  const before = { database: 1 };
  const after = applyFeedback(before, { database: 0.5, spam: 1 }, -1, {
    learningRate: 0.25,
  });
  assert.deepEqual(before, { database: 1 });
  assert.deepEqual(after, { database: 0.875, spam: -0.25 });
});

test("signed feature strengths move the score in the intended feedback direction", () => {
  const liked = new PreferenceModel({ learningRate: 0.5 });
  liked.like({ symbols: { cold: -2 } });
  assert.deepEqual(liked.toJSON(), { cold: -1 });
  assert.equal(liked.getWeight("cold") * -2, 2);

  const disliked = new PreferenceModel({ learningRate: 0.5 });
  disliked.dislike({ symbols: { cold: -2 } });
  assert.deepEqual(disliked.toJSON(), { cold: 1 });
  assert.equal(disliked.getWeight("cold") * -2, -2);
});

test("case-normalized weights sum and exact cancellation removes the entry", () => {
  assert.deepEqual(
    new PreferenceModel({ weights: { AI: 1, ai: 2 } }).toJSON(),
    { ai: 3 },
  );
  assert.deepEqual(
    new PreferenceModel({ weights: { AI: 1, ai: -1 } }).toJSON(),
    {},
  );
});

test("prototype-named symbols remain ordinary weights after every update path", () => {
  const model = new PreferenceModel({ learningRate: 0.5 });
  model.like(["warmup"]);

  assert.equal(model.getWeight("constructor"), 0);
  assert.equal(model.getWeight("__proto__"), 0);

  model.setWeight("__proto__", 1.25);
  model.setWeight("constructor", -0.75);
  model.like(["__proto__", "constructor"]);

  assert.equal(model.getWeight("__proto__"), 1.75);
  assert.equal(model.getWeight("constructor"), -0.25);

  const snapshot = model.toJSON();
  assert.equal(Object.hasOwn(snapshot, "__proto__"), true);
  assert.equal(Object.hasOwn(snapshot, "constructor"), true);
  assert.equal(snapshot.__proto__, 1.75);
  assert.equal(snapshot.constructor, -0.25);

  const restored = PreferenceModel.fromJSON(JSON.parse(JSON.stringify(snapshot)));
  assert.equal(restored.getWeight("__proto__"), 1.75);
  assert.equal(restored.getWeight("constructor"), -0.25);
});

test("symbolEntries accepts sparse arrays, maps and object-valued symbols", () => {
  assert.deepEqual(symbolEntries(["AI", "ai", "db"]), [
    ["ai", 2],
    ["db", 1],
  ]);
  assert.deepEqual(symbolEntries(new Map([["systems", 0.7]])), [["systems", 0.7]]);
  assert.deepEqual(symbolEntries({ symbols: { systems: 1, muted: 0 } }), [
    ["systems", 1],
  ]);
});

test("non-finite strengths, weights, update parameters and collision overflow fail loudly", () => {
  assert.throws(() => symbolEntries({ systems: Number.POSITIVE_INFINITY }), /finite/);
  assert.throws(() => symbolEntries({ systems: Number.NaN }), /finite/);
  assert.throws(
    () => symbolEntries([{ symbol: "systems", value: undefined }]),
    /finite/,
  );
  assert.throws(
    () =>
      symbolEntries([
        { symbol: "systems", value: Number.MAX_VALUE },
        { symbol: "systems", value: Number.MAX_VALUE },
      ]),
    /not finite/,
  );
  assert.throws(
    () => new PreferenceModel({ weights: { systems: Number.NaN } }),
    /finite/,
  );
  assert.throws(
    () => new PreferenceModel({ weights: { AI: Number.MAX_VALUE, ai: Number.MAX_VALUE } }),
    /not finite/,
  );
  assert.throws(
    () => applyFeedback({}, ["systems"], "like", { learningRate: Infinity }),
    /finite/,
  );
  assert.throws(
    () => applyFeedback({}, ["systems"], "like", { strength: -1 }),
    /non-negative/,
  );
});
