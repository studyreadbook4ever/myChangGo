import test from "node:test";
import assert from "node:assert/strict";

import {
  analyzeDecisionUnderUncertainty,
  analyzeBreakEven,
  analyzeConfounding,
  calculateAccessEconomics,
  calculatePriceScenario,
  estimateConstraintMarginalValue,
  generateConfoundingData,
  giniCoefficient,
  linearRegression,
  optimizeIntegerAllocation,
  partialAssociation,
  pearsonCorrelation,
  scoreAllocation,
  solveTwoVariableLinearProgram,
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

test("two-variable LP enumerates the feasible region and finds the binding corner", () => {
  const result = solveTwoVariableLinearProgram({
    objective: [8, 6],
    constraints: [
      { id: "writing", coefficients: [2, 1], limit: 12 },
      { id: "review", coefficients: [1, 2], limit: 10 },
    ],
  });

  assert.ok(Math.abs(result.optimum.point[0] - 14 / 3) < 1e-10);
  assert.ok(Math.abs(result.optimum.point[1] - 8 / 3) < 1e-10);
  assert.ok(Math.abs(result.optimum.value - 160 / 3) < 1e-10);
  assert.deepEqual(result.optimum.bindingConstraintIds, ["writing", "review"]);
  assert.equal(result.feasibleVertices.length, 4);
  assert.equal(result.hasMultipleOptima, false);
});

test("two-variable LP rejects a positive objective direction without a resource bound", () => {
  assert.throws(
    () =>
      solveTwoVariableLinearProgram({
        objective: [1, 1],
        constraints: [{ coefficients: [1, 0], limit: 3 }],
      }),
    /unbounded/,
  );
});

test("constraint marginal value is a finite difference and reports basis changes honestly", () => {
  const input = {
    objective: [8, 6],
    constraints: [
      { id: "writing", label: "작성", coefficients: [2, 1], limit: 12 },
      { id: "review", label: "검토", coefficients: [1, 2], limit: 10 },
    ],
  };
  const small = estimateConstraintMarginalValue({
    ...input,
    constraintIndex: 0,
    delta: 0.5,
  });
  assert.ok(Math.abs(small.marginalValue - 10 / 3) < 1e-10);
  assert.equal(small.endpointBinding, true);
  assert.equal(small.slopeStable, true);

  const large = estimateConstraintMarginalValue({
    ...input,
    constraintIndex: 0,
    delta: 20,
  });
  assert.ok(large.marginalValue < small.marginalValue);
  assert.equal(large.slopeStable, false);
});

test("decision analysis separates expected value, robust choice, and minimax regret", () => {
  const result = analyzeDecisionUnderUncertainty({
    alternatives: [
      { id: "peak", payoffs: [100, 20] },
      { id: "balanced", payoffs: [78, 64] },
      { id: "reserve", payoffs: [66, 70] },
    ],
    probabilities: [0.7, 0.3],
  });

  assert.deepEqual(result.expectedBestIds, ["peak"]);
  assert.deepEqual(result.robustBestIds, ["reserve"]);
  assert.deepEqual(result.minimaxRegretIds, ["balanced"]);
});

test("access economics keeps affordability and imputed benefit as separate ledgers", () => {
  const result = calculateAccessEconomics({
    monthlyDisposableIncome: 1_800_000,
    monthlyPrice: 30_000,
    usageDays: 20,
    hoursSavedPerDay: 1,
    assumedHourlyValue: 12_000,
  });

  assert.ok(Math.abs(result.burdenShare - 1 / 60) < 1e-12);
  assert.equal(result.monthlyHoursSaved, 20);
  assert.equal(result.imputedTimeValue, 240_000);
  assert.equal(result.netImputedValue, 210_000);
  assert.equal(result.breakEvenUsageDays, 3);
});

test("gini coefficient handles equality, concentration, and scale invariance", () => {
  assert.equal(giniCoefficient([10, 10, 10, 10]), 0);
  assert.ok(Math.abs(giniCoefficient([0, 0, 0, 40]) - 0.75) < 1e-12);
  assert.ok(
    Math.abs(giniCoefficient([1, 2, 3, 4]) - giniCoefficient([10, 20, 30, 40])) <
      1e-12,
  );
});

test("LP returns feasible vertices in polygon order rather than a crossing lexicographic order", () => {
  const result = solveTwoVariableLinearProgram({
    objective: [1, 1],
    constraints: [
      { id: "x-cap", coefficients: [1, 0], limit: 1 },
      { id: "y-cap", coefficients: [0, 1], limit: 1 },
    ],
  });
  const signedTwiceArea = result.feasibleVertices.reduce((area, vertex, index, vertices) => {
    const next = vertices[(index + 1) % vertices.length];
    return area + vertex.point[0] * next.point[1] - next.point[0] * vertex.point[1];
  }, 0);
  assert.ok(Math.abs(signedTwiceArea) > 1.999999 && Math.abs(signedTwiceArea) < 2.000001);
});

test("LP distinguishes a bounded objective on an unbounded optimal face", () => {
  const result = solveTwoVariableLinearProgram({
    objective: [1, 0],
    constraints: [{ id: "x-cap", coefficients: [1, 0], limit: 1 }],
  });
  assert.equal(result.optimum.value, 1);
  assert.equal(result.feasibleRegionUnbounded, true);
  assert.equal(result.hasUnboundedOptimalFace, true);
  assert.equal(result.hasMultipleOptima, true);
});

test("LP catches an unbounded direction even when its positive objective coefficient is tiny", () => {
  assert.throws(
    () =>
      solveTwoVariableLinearProgram({
        objective: [5e-11, 0],
        constraints: [{ id: "y-cap", coefficients: [0, 1], limit: 1 }],
      }),
    /unbounded/,
  );
});

test("LP scale does not turn a strictly better tiny objective into a tie", () => {
  const result = solveTwoVariableLinearProgram({
    objective: [1e-12, 0],
    constraints: [
      { id: "x-cap", coefficients: [1, 0], limit: 1 },
      { id: "y-cap", coefficients: [0, 1], limit: 1 },
    ],
  });
  assert.deepEqual(result.optimalVertices.map((vertex) => vertex.point), [
    [1, 0],
    [1, 1],
  ]);
});

test("LP geometry is invariant when every resource row is scaled by 1e-6", () => {
  const constraints = [
    { id: "writing", coefficients: [2, 1], limit: 12 },
    { id: "review", coefficients: [1, 2], limit: 10 },
  ];
  const original = solveTwoVariableLinearProgram({
    objective: [8, 6],
    constraints,
  });
  const scaled = solveTwoVariableLinearProgram({
    objective: [8, 6],
    constraints: constraints.map((constraint) => ({
      ...constraint,
      coefficients: constraint.coefficients.map((coefficient) => coefficient * 1e-6),
      limit: constraint.limit * 1e-6,
    })),
  });

  assert.deepEqual(scaled.optimum.point, original.optimum.point);
  assert.equal(scaled.optimum.value, original.optimum.value);
  assert.deepEqual(
    scaled.optimum.bindingConstraintIds,
    original.optimum.bindingConstraintIds,
  );
  assert.deepEqual(
    scaled.feasibleVertices.map((vertex) => vertex.point),
    original.feasibleVertices.map((vertex) => vertex.point),
  );
});

test("LP candidate deduplication preserves a genuinely tiny feasible region", () => {
  const result = solveTwoVariableLinearProgram({
    objective: [1, 1],
    constraints: [
      { id: "tiny-x", coefficients: [1, 0], limit: 1e-12 },
      { id: "tiny-y", coefficients: [0, 1], limit: 2e-12 },
    ],
  });

  assert.equal(result.feasibleVertices.length, 4);
  assert.deepEqual(result.optimum.point, [1e-12, 2e-12]);
  assert.deepEqual(result.optimum.bindingConstraintIds, ["tiny-x", "tiny-y"]);
});

test("LP candidate deduplication keeps distinct coordinates in an anisotropic region", () => {
  const result = solveTwoVariableLinearProgram({
    objective: [1e10, 1],
    constraints: [
      { id: "x-cap", coefficients: [1, 0], limit: 1 },
      { id: "y-cap", coefficients: [0, 1], limit: 1e20 },
    ],
  });

  assert.equal(result.feasibleVertices.length, 4);
  assert.deepEqual(result.optimum.point, [1, 1e20]);
  assert.deepEqual(result.optimum.bindingConstraintIds, ["x-cap", "y-cap"]);
});

test("LP reports a bounded alternative-optimum edge and rejects duplicate constraint IDs", () => {
  const alternative = solveTwoVariableLinearProgram({
    objective: [2, 1],
    constraints: [
      { id: "writing", coefficients: [2, 1], limit: 12 },
      { id: "review", coefficients: [1, 2], limit: 10 },
    ],
  });
  assert.equal(alternative.optimalVertices.length, 2);
  assert.equal(alternative.hasMultipleOptima, true);
  assert.throws(
    () =>
      solveTwoVariableLinearProgram({
        objective: [1, 1],
        constraints: [
          { id: "same", coefficients: [1, 0], limit: 1 },
          { id: "same", coefficients: [0, 1], limit: 1 },
        ],
      }),
    /unique/,
  );
});

test("finite-difference lab detects a slope break even when the constraint binds at both endpoints", () => {
  const result = estimateConstraintMarginalValue({
    objective: [2, 1],
    constraints: [
      { id: "resource", coefficients: [1, 1], limit: 0.5 },
      { id: "x-cap", coefficients: [1, 0], limit: 1 },
    ],
    constraintIndex: 0,
    delta: 1.5,
  });
  assert.equal(result.endpointBinding, true);
  assert.equal(result.slopeStable, false);
  assert.ok(Math.abs(result.firstHalfMarginalValue - 5 / 3) < 1e-10);
  assert.ok(Math.abs(result.secondHalfMarginalValue - 1) < 1e-10);
  assert.ok(Math.abs(result.marginalValue - 4 / 3) < 1e-10);
});

test("uncertainty analysis rejects duplicate alternatives and documents zero-probability stress states", () => {
  assert.throws(
    () =>
      analyzeDecisionUnderUncertainty({
        alternatives: [
          { id: "same", payoffs: [2, 0] },
          { id: "same", payoffs: [1, 1] },
        ],
        probabilities: [0.5, 0.5],
      }),
    /unique/,
  );
  const result = analyzeDecisionUnderUncertainty({
    alternatives: [
      { id: "fragile", payoffs: [10, -100] },
      { id: "steady", payoffs: [8, 8] },
    ],
    probabilities: [1, 0],
  });
  assert.deepEqual(result.expectedBestIds, ["fragile"]);
  assert.deepEqual(result.robustBestIds, ["steady"]);
  assert.match(result.criterionNotes.maximin, /확률과 무관/);
});

test("uncertainty criteria keep tiny and rescaled strict differences out of ties", () => {
  for (const scale of [1e-12, 1e12]) {
    const result = analyzeDecisionUnderUncertainty({
      alternatives: [
        { id: "dominant", payoffs: [4 * scale, 2 * scale] },
        { id: "inferior", payoffs: [3 * scale, 1 * scale] },
      ],
      probabilities: [0.5, 0.5],
    });

    assert.deepEqual(result.expectedBestIds, ["dominant"]);
    assert.deepEqual(result.robustBestIds, ["dominant"]);
    assert.deepEqual(result.minimaxRegretIds, ["dominant"]);
  }
});

test("uncertainty criteria retain genuine ties after decimal arithmetic", () => {
  const result = analyzeDecisionUnderUncertainty({
    alternatives: [
      { id: "front-loaded", payoffs: [0.1, 0.1, 0.4] },
      { id: "back-loaded", payoffs: [0.4, 0.1, 0.1] },
    ],
    probabilities: [1 / 3, 1 / 3, 1 / 3],
  });

  assert.notEqual(result.rows[0].expectedValue, result.rows[1].expectedValue);
  assert.deepEqual(result.expectedBestIds, ["front-loaded", "back-loaded"]);
  assert.deepEqual(result.robustBestIds, ["front-loaded", "back-loaded"]);
  assert.deepEqual(result.minimaxRegretIds, ["front-loaded", "back-loaded"]);
});

test("access economics distinguishes free access and a break-even beyond one month", () => {
  const free = calculateAccessEconomics({
    monthlyDisposableIncome: 1_000_000,
    monthlyPrice: 0,
    usageDays: 20,
    hoursSavedPerDay: 1,
    assumedHourlyValue: 10_000,
  });
  assert.equal(free.breakEvenUsageDays, 0);
  assert.equal(free.breakEvenWithinMonth, true);

  const tooSlow = calculateAccessEconomics({
    monthlyDisposableIncome: 1_000_000,
    monthlyPrice: 100,
    usageDays: 20,
    hoursSavedPerDay: 1,
    assumedHourlyValue: 1,
  });
  assert.equal(tooSlow.breakEvenUsageDays, 100);
  assert.equal(tooSlow.breakEvenWithinMonth, false);
});

test("access break-even snaps decimal roundoff but preserves a nearby strict boundary", () => {
  const exactBoundary = calculateAccessEconomics({
    monthlyDisposableIncome: 100,
    monthlyPrice: 2.1,
    usageDays: 20,
    hoursSavedPerDay: 0.3,
    assumedHourlyValue: 1,
  });
  const justAboveBoundary = calculateAccessEconomics({
    monthlyDisposableIncome: 100,
    monthlyPrice: 2.100000000001,
    usageDays: 20,
    hoursSavedPerDay: 0.3,
    assumedHourlyValue: 1,
  });
  const tinyEquivalent = calculateAccessEconomics({
    monthlyDisposableIncome: 1,
    monthlyPrice: 2.1e-12,
    usageDays: 20,
    hoursSavedPerDay: 0.3e-12,
    assumedHourlyValue: 1,
  });

  assert.equal(exactBoundary.breakEvenUsageDays, 7);
  assert.equal(justAboveBoundary.breakEvenUsageDays, 8);
  assert.equal(tinyEquivalent.breakEvenUsageDays, 7);
});

test("gini remains scale-invariant for tiny and near-maximum finite magnitudes", () => {
  assert.ok(Math.abs(giniCoefficient([0, 0, 0, 4e-11]) - 0.75) < 1e-12);
  assert.equal(giniCoefficient([Number.MAX_VALUE, Number.MAX_VALUE]), 0);
  assert.ok(
    Math.abs(
      giniCoefficient([1, 4, 9]) -
        giniCoefficient([1e-200, 4e-200, 9e-200]),
    ) < 1e-12,
  );
});
