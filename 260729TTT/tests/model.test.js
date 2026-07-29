import test from "node:test";
import assert from "node:assert/strict";

import {
  analyzeBreakEven,
  analyzeConfounding,
  calculatePriceScenario,
  generateConfoundingData,
  linearRegression,
  optimizeIntegerAllocation,
  partialAssociation,
  pearsonCorrelation,
  scoreAllocation,
} from "../src/model.js";

const activities = [
  { id: "understanding", marginalValues: [18, 14, 11, 8, 6, 4] },
  { id: "verification", marginalValues: [16, 15, 12, 9, 5, 3] },
  { id: "experience", marginalValues: [13, 10, 8, 6, 4, 2] },
];

test("linear regression recovers an exact line", () => {
  const result = linearRegression([1, 2, 3, 4], [3, 5, 7, 9]);
  assert.equal(result.slope, 2);
  assert.equal(result.intercept, 1);
  assert.equal(result.correlation, 1);
  assert.equal(result.rSquared, 1);
});

test("constant explanatory data reports that comparison is impossible", () => {
  const result = linearRegression([2, 2, 2], [1, 3, 5]);
  assert.equal(result.slope, null);
  assert.match(result.reason, /차이/);
  assert.equal(pearsonCorrelation([2, 2, 2], [1, 3, 5]), null);
});

test("the default confounding exhibit is correlated without a true effect", () => {
  const rows = generateConfoundingData({ confounding: 1, trueEffect: 0 });
  const result = analyzeConfounding(rows);
  assert.ok(Math.abs(result.raw.slope - 2.4324324324324325) < 1e-10);
  assert.ok(result.raw.correlation > 0.55 && result.raw.correlation < 0.57);
  assert.ok(Math.abs(result.adjusted.slope) < 1e-10);
  assert.ok(Math.abs(result.adjusted.correlation) < 1e-10);
});

test("controlling readiness recovers the configured effect", () => {
  for (const confounding of [0, 0.35, 1]) {
    const rows = generateConfoundingData({ confounding, trueEffect: 1 });
    const result = analyzeConfounding(rows);
    assert.ok(Math.abs(result.adjusted.slope - 1) < 1e-10);
    assert.ok(Math.abs(result.adjusted.correlation - Math.SQRT1_2) < 1e-10);
  }
});

test("partial association reports no remaining comparison under collinearity", () => {
  const result = partialAssociation([1, 2, 3], [3, 6, 9], [1, 2, 3]);
  assert.equal(result.slope, null);
  assert.match(result.reason, /차이/);
});

test("allocation model reproduces the exhibit's verified optimum", () => {
  const atSeven = optimizeIntegerAllocation({ budget: 7, activities });
  const atEight = optimizeIntegerAllocation({ budget: 8, activities });
  const atNine = optimizeIntegerAllocation({ budget: 9, activities });

  assert.equal(atSeven.totalValue, 99);
  assert.deepEqual(atEight.allocations, {
    understanding: 3,
    verification: 3,
    experience: 2,
  });
  assert.equal(atEight.totalValue, 109);
  assert.equal(atEight.previousUnitValue, 10);
  assert.equal(atEight.extraUnitValue, 9);
  assert.deepEqual(atEight.shadowInterval, { lower: 9, upper: 10 });
  assert.equal(atNine.totalValue, 118);
});

test("allocation handles zero and excess budgets", () => {
  const empty = optimizeIntegerAllocation({ budget: 0, activities });
  assert.equal(empty.totalValue, 0);
  assert.equal(empty.used, 0);
  assert.equal(empty.previousUnitValue, null);

  const excess = optimizeIntegerAllocation({ budget: 100, activities });
  assert.equal(excess.used, 18);
  assert.equal(excess.unspent, 82);
  assert.equal(excess.extraUnitValue, 0);
});

test("weights change the chosen optimum and manual scoring agrees", () => {
  const weighted = activities.map((activity) => ({
    ...activity,
    weight: activity.id === "experience" ? 2 : 1,
  }));
  const result = optimizeIntegerAllocation({ budget: 3, activities: weighted });
  assert.deepEqual(result.allocations, {
    understanding: 1,
    verification: 0,
    experience: 2,
  });
  const manual = scoreAllocation(weighted, result.allocations);
  assert.equal(manual.totalValue, result.totalValue);
  assert.equal(manual.used, 3);
});

test("invalid increasing marginal values are rejected", () => {
  assert.throws(
    () =>
      optimizeIntegerAllocation({
        budget: 2,
        activities: [{ id: "bad", marginalValues: [1, 2] }],
      }),
    /non-increasing/,
  );
});

test("zero-token break-even is exact at the boundary", () => {
  const before = analyzeBreakEven({
    runs: 9,
    agentCostPerRun: 14,
    zeroBuildCost: 120,
    zeroRuntimeCostPerRun: 2,
  });
  const at = analyzeBreakEven({
    runs: 10,
    agentCostPerRun: 14,
    zeroBuildCost: 120,
    zeroRuntimeCostPerRun: 2,
  });
  const after = analyzeBreakEven({
    runs: 30,
    agentCostPerRun: 14,
    zeroBuildCost: 120,
    zeroRuntimeCostPerRun: 2,
  });
  assert.equal(before.breakEvenRuns, 10);
  assert.equal(before.winner, "agent");
  assert.equal(at.winner, "tie");
  assert.equal(after.agentTotal, 420);
  assert.equal(after.zeroTokenTotal, 180);
  assert.equal(after.savings, 240);
  assert.equal(after.winner, "zero-token");
});

test("zero-token reports an impossible break-even", () => {
  const result = analyzeBreakEven({
    runs: 100,
    agentCostPerRun: 2,
    zeroBuildCost: 20,
    zeroRuntimeCostPerRun: 3,
  });
  assert.equal(result.breakEvenRuns, null);
  assert.equal(result.winner, "agent");
});

test("price and cost remain explicit assumptions", () => {
  const result = calculatePriceScenario({
    monthlyPrice: 30000,
    weeklyListValue: 100000,
    utilizationPercent: 50,
    assumedCostRatioPercent: 25,
  });
  assert.ok(Math.abs(result.usedListValue - 216666.66666666666) < 1e-8);
  assert.ok(Math.abs(result.assumedServingCost - 54166.666666666664) < 1e-8);
  assert.ok(result.retailMultiple > 7);
});
