const EPSILON = 1e-10;

function assertFiniteNumber(value, label) {
  if (!Number.isFinite(value)) {
    throw new TypeError(`${label} must be a finite number`);
  }
}

function assertSameLength(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
    throw new TypeError("series must be arrays with the same length");
  }
  if (left.length < 2) {
    throw new RangeError("series need at least two observations");
  }
}

export function mean(values) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new RangeError("values must be a non-empty array");
  }
  values.forEach((value, index) => assertFiniteNumber(value, `values[${index}]`));
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function pearsonCorrelation(left, right) {
  assertSameLength(left, right);
  const leftMean = mean(left);
  const rightMean = mean(right);
  let numerator = 0;
  let leftSquared = 0;
  let rightSquared = 0;

  for (let index = 0; index < left.length; index += 1) {
    assertFiniteNumber(left[index], `left[${index}]`);
    assertFiniteNumber(right[index], `right[${index}]`);
    const leftDelta = left[index] - leftMean;
    const rightDelta = right[index] - rightMean;
    numerator += leftDelta * rightDelta;
    leftSquared += leftDelta ** 2;
    rightSquared += rightDelta ** 2;
  }

  const denominator = Math.sqrt(leftSquared * rightSquared);
  return denominator <= EPSILON ? null : numerator / denominator;
}

export function linearRegression(xs, ys) {
  assertSameLength(xs, ys);
  const xMean = mean(xs);
  const yMean = mean(ys);
  let covariance = 0;
  let xSquared = 0;

  for (let index = 0; index < xs.length; index += 1) {
    assertFiniteNumber(xs[index], `xs[${index}]`);
    assertFiniteNumber(ys[index], `ys[${index}]`);
    covariance += (xs[index] - xMean) * (ys[index] - yMean);
    xSquared += (xs[index] - xMean) ** 2;
  }

  if (xSquared <= EPSILON) {
    return {
      slope: null,
      intercept: yMean,
      correlation: null,
      rSquared: null,
      predictions: ys.map(() => yMean),
      residuals: ys.map((value) => value - yMean),
      reason: "설명 변수에 비교할 만한 차이가 없습니다.",
    };
  }

  const slope = covariance / xSquared;
  const intercept = yMean - slope * xMean;
  const predictions = xs.map((value) => intercept + slope * value);
  const residuals = ys.map((value, index) => value - predictions[index]);
  const correlation = pearsonCorrelation(xs, ys);

  return {
    slope,
    intercept,
    correlation,
    rSquared: correlation === null ? null : correlation ** 2,
    predictions,
    residuals,
    reason: null,
  };
}

export function residualizeOnControl(values, control) {
  const regression = linearRegression(control, values);
  return regression.residuals;
}

export function partialAssociation(xs, ys, control) {
  assertSameLength(xs, ys);
  assertSameLength(xs, control);
  const xResiduals = residualizeOnControl(xs, control);
  const yResiduals = residualizeOnControl(ys, control);
  const regression = linearRegression(xResiduals, yResiduals);

  return {
    slope: regression.slope,
    correlation: pearsonCorrelation(xResiduals, yResiduals),
    xResiduals,
    yResiduals,
    reason: regression.reason,
  };
}

const READINESS = Object.freeze([-4, -3, -2, -1, 0, 1, 2, 3, 4]);
const USE_VARIATION = Object.freeze([2, -1, -2, 1, 0, 1, -2, -1, 2]);
const SCORE_VARIATION = Object.freeze([1, 0, 1, 0, -4, 0, 1, 0, 1]);

export function generateConfoundingData({ confounding = 1, trueEffect = 0 } = {}) {
  assertFiniteNumber(confounding, "confounding");
  assertFiniteNumber(trueEffect, "trueEffect");
  if (confounding < 0 || confounding > 1) {
    throw new RangeError("confounding must be between 0 and 1");
  }
  if (trueEffect < 0 || trueEffect > 2) {
    throw new RangeError("trueEffect must be between 0 and 2");
  }

  return READINESS.map((readiness, index) => {
    const aiHours = 5 + 0.4 * confounding * readiness + USE_VARIATION[index];
    const score = 65 + trueEffect * aiHours + 3 * readiness + SCORE_VARIATION[index];
    return {
      id: `student-${index + 1}`,
      readiness,
      readinessLabel: readiness < -1 ? "낮음" : readiness > 1 ? "높음" : "보통",
      aiHours,
      score,
    };
  });
}

export function analyzeConfounding(rows) {
  if (!Array.isArray(rows) || rows.length < 2) {
    throw new RangeError("rows need at least two observations");
  }
  const xs = rows.map((row) => row.aiHours);
  const ys = rows.map((row) => row.score);
  const control = rows.map((row) => row.readiness);
  const raw = linearRegression(xs, ys);
  const adjusted = partialAssociation(xs, ys, control);

  return {
    raw,
    adjusted,
    omittedVariableBias:
      raw.slope === null || adjusted.slope === null ? null : raw.slope - adjusted.slope,
  };
}

function normalizeActivities(activities) {
  if (!Array.isArray(activities) || activities.length === 0) {
    throw new RangeError("activities must be a non-empty array");
  }
  const ids = new Set();

  return activities.map((activity, activityIndex) => {
    if (!activity || typeof activity.id !== "string" || activity.id.length === 0) {
      throw new TypeError(`activities[${activityIndex}].id must be a non-empty string`);
    }
    if (ids.has(activity.id)) {
      throw new RangeError(`duplicate activity id: ${activity.id}`);
    }
    ids.add(activity.id);
    const weight = activity.weight ?? 1;
    assertFiniteNumber(weight, `activities[${activityIndex}].weight`);
    if (weight < 0) {
      throw new RangeError("activity weights cannot be negative");
    }
    if (!Array.isArray(activity.marginalValues) || activity.marginalValues.length === 0) {
      throw new RangeError(`activity ${activity.id} needs marginalValues`);
    }
    let previous = Number.POSITIVE_INFINITY;
    const marginalValues = activity.marginalValues.map((value, valueIndex) => {
      assertFiniteNumber(value, `${activity.id}.marginalValues[${valueIndex}]`);
      if (value < 0 || value > previous + EPSILON) {
        throw new RangeError(`${activity.id} marginal values must be non-negative and non-increasing`);
      }
      previous = value;
      return value * weight;
    });

    return {
      ...activity,
      weight,
      marginalValues,
    };
  });
}

function solveAllocation(activities, budget) {
  const opportunities = [];
  activities.forEach((activity, activityIndex) => {
    activity.marginalValues.forEach((value, unitIndex) => {
      opportunities.push({
        activityId: activity.id,
        activityIndex,
        unit: unitIndex + 1,
        value,
      });
    });
  });
  opportunities.sort(
    (left, right) =>
      right.value - left.value ||
      left.activityIndex - right.activityIndex ||
      left.unit - right.unit,
  );

  const selected = opportunities.slice(0, budget).filter((opportunity) => opportunity.value > 0);
  const allocations = Object.fromEntries(activities.map((activity) => [activity.id, 0]));
  selected.forEach((opportunity) => {
    allocations[opportunity.activityId] += 1;
  });

  return {
    allocations,
    totalValue: selected.reduce((sum, opportunity) => sum + opportunity.value, 0),
    used: selected.length,
    unspent: Math.max(0, budget - selected.length),
    steps: selected,
  };
}

export function optimizeIntegerAllocation({ budget, activities }) {
  if (!Number.isSafeInteger(budget) || budget < 0) {
    throw new RangeError("budget must be a non-negative safe integer");
  }
  const normalized = normalizeActivities(activities);
  const current = solveAllocation(normalized, budget);
  const previous = budget === 0 ? { totalValue: 0 } : solveAllocation(normalized, budget - 1);
  const next = solveAllocation(normalized, budget + 1);

  return {
    ...current,
    extraUnitValue: next.totalValue - current.totalValue,
    previousUnitValue: budget === 0 ? null : current.totalValue - previous.totalValue,
    shadowInterval: {
      lower: next.totalValue - current.totalValue,
      upper: budget === 0 ? null : current.totalValue - previous.totalValue,
    },
  };
}

export function scoreAllocation(activities, allocations) {
  const normalized = normalizeActivities(activities);
  if (!allocations || typeof allocations !== "object") {
    throw new TypeError("allocations must be an object");
  }

  let totalValue = 0;
  let used = 0;
  const details = {};
  normalized.forEach((activity) => {
    const amount = allocations[activity.id] ?? 0;
    if (!Number.isSafeInteger(amount) || amount < 0 || amount > activity.marginalValues.length) {
      throw new RangeError(`invalid allocation for ${activity.id}`);
    }
    const value = activity.marginalValues
      .slice(0, amount)
      .reduce((sum, marginalValue) => sum + marginalValue, 0);
    used += amount;
    totalValue += value;
    details[activity.id] = { amount, value };
  });

  return { totalValue, used, details };
}

function totalCost(fixed, perRun, runs) {
  return fixed + perRun * runs;
}

function findBreakEven({ agentFixedCost, agentCostPerRun, zeroBuildCost, zeroRuntimeCostPerRun }) {
  const perRunSavings = agentCostPerRun - zeroRuntimeCostPerRun;
  const extraFixedCost = zeroBuildCost - agentFixedCost;
  if (extraFixedCost <= 0) {
    return 0;
  }
  if (perRunSavings <= 0) {
    return null;
  }

  let candidate = Math.max(0, Math.ceil(extraFixedCost / perRunSavings - EPSILON));
  const zeroAt = (runs) => totalCost(zeroBuildCost, zeroRuntimeCostPerRun, runs);
  const agentAt = (runs) => totalCost(agentFixedCost, agentCostPerRun, runs);
  while (candidate > 0 && zeroAt(candidate - 1) <= agentAt(candidate - 1) + EPSILON) {
    candidate -= 1;
  }
  while (zeroAt(candidate) > agentAt(candidate) + EPSILON) {
    candidate += 1;
  }
  return candidate;
}

export function analyzeBreakEven({
  runs,
  agentFixedCost = 0,
  agentCostPerRun,
  zeroBuildCost,
  zeroRuntimeCostPerRun = 0,
}) {
  if (!Number.isSafeInteger(runs) || runs < 0) {
    throw new RangeError("runs must be a non-negative safe integer");
  }
  const costs = {
    agentFixedCost,
    agentCostPerRun,
    zeroBuildCost,
    zeroRuntimeCostPerRun,
  };
  Object.entries(costs).forEach(([label, value]) => {
    assertFiniteNumber(value, label);
    if (value < 0) {
      throw new RangeError(`${label} cannot be negative`);
    }
  });

  const agentTotal = totalCost(agentFixedCost, agentCostPerRun, runs);
  const zeroTokenTotal = totalCost(zeroBuildCost, zeroRuntimeCostPerRun, runs);
  const difference = agentTotal - zeroTokenTotal;

  return {
    breakEvenRuns: findBreakEven(costs),
    perRunSavings: agentCostPerRun - zeroRuntimeCostPerRun,
    agentTotal,
    zeroTokenTotal,
    savings: difference,
    winner: Math.abs(difference) <= EPSILON ? "tie" : difference > 0 ? "zero-token" : "agent",
  };
}

export function calculatePriceScenario({
  monthlyPrice,
  weeklyListValue,
  utilizationPercent,
  assumedCostRatioPercent,
}) {
  const values = { monthlyPrice, weeklyListValue, utilizationPercent, assumedCostRatioPercent };
  Object.entries(values).forEach(([label, value]) => assertFiniteNumber(value, label));
  if (monthlyPrice < 0 || weeklyListValue < 0) {
    throw new RangeError("prices cannot be negative");
  }
  if (
    utilizationPercent < 0 ||
    utilizationPercent > 100 ||
    assumedCostRatioPercent < 0 ||
    assumedCostRatioPercent > 100
  ) {
    throw new RangeError("percentages must be between 0 and 100");
  }
  const weeksPerMonth = 52 / 12;
  const usedListValue = weeklyListValue * weeksPerMonth * (utilizationPercent / 100);
  const assumedServingCost = usedListValue * (assumedCostRatioPercent / 100);

  return {
    weeksPerMonth,
    usedListValue,
    assumedServingCost,
    retailMultiple: monthlyPrice === 0 ? null : usedListValue / monthlyPrice,
    assumedGap: assumedServingCost - monthlyPrice,
  };
}
