const EPSILON = 1e-10;

function scaleAwareTolerance(values, ulps = 32) {
  const scale = values.reduce(
    (largest, value) => Math.max(largest, Math.abs(value)),
    Number.MIN_VALUE,
  );
  return Number.EPSILON * ulps * scale;
}

function scaleAwareEqual(left, right, ulps = 4) {
  return Math.abs(left - right) <= scaleAwareTolerance([left, right], ulps);
}

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

function normalizeTwoVariableObjective(objective) {
  if (!Array.isArray(objective) || objective.length !== 2) {
    throw new TypeError("objective must contain exactly two coefficients");
  }
  objective.forEach((value, index) => {
    assertFiniteNumber(value, `objective[${index}]`);
    if (value < 0) {
      throw new RangeError("objective coefficients must be non-negative");
    }
  });
  return [...objective];
}

function normalizeResourceConstraints(constraints) {
  if (!Array.isArray(constraints) || constraints.length === 0) {
    throw new RangeError("constraints must be a non-empty array");
  }

  const ids = new Set();
  return constraints.map((constraint, index) => {
    if (!constraint || !Array.isArray(constraint.coefficients) || constraint.coefficients.length !== 2) {
      throw new TypeError(`constraints[${index}] must have exactly two coefficients`);
    }
    constraint.coefficients.forEach((value, coefficientIndex) => {
      assertFiniteNumber(value, `constraints[${index}].coefficients[${coefficientIndex}]`);
      if (value < 0) {
        throw new RangeError("resource coefficients must be non-negative");
      }
    });
    assertFiniteNumber(constraint.limit, `constraints[${index}].limit`);
    if (constraint.limit < 0) {
      throw new RangeError("constraint limits must be non-negative");
    }
    if (constraint.coefficients.every((value) => value === 0)) {
      throw new RangeError("a constraint must use at least one variable");
    }

    const id = constraint.id ?? `constraint-${index + 1}`;
    if (typeof id !== "string" || id.length === 0 || ids.has(id)) {
      throw new RangeError(`constraint IDs must be unique non-empty strings: ${id}`);
    }
    ids.add(id);

    return {
      id,
      label: constraint.label ?? `제약 ${index + 1}`,
      coefficients: [...constraint.coefficients],
      limit: constraint.limit,
    };
  });
}

function geometryConstraint(constraint) {
  const coefficientScale = Math.max(...constraint.coefficients);
  return {
    coefficients: constraint.coefficients.map((coefficient) => coefficient / coefficientScale),
    limit: constraint.limit / coefficientScale,
  };
}

function intersection(left, right) {
  const [a, b] = left.coefficients;
  const [c, d] = right.coefficients;
  const positiveProduct = a * d;
  const negativeProduct = b * c;
  const determinant = positiveProduct - negativeProduct;
  if (
    determinant === 0 ||
    Math.abs(determinant) <=
      scaleAwareTolerance([positiveProduct, negativeProduct], 32)
  ) {
    return null;
  }

  const xPositiveProduct = left.limit * d;
  const xNegativeProduct = b * right.limit;
  const yPositiveProduct = a * right.limit;
  const yNegativeProduct = left.limit * c;
  const xNumerator =
    Math.abs(xPositiveProduct - xNegativeProduct) <=
    scaleAwareTolerance([xPositiveProduct, xNegativeProduct], 32)
      ? 0
      : xPositiveProduct - xNegativeProduct;
  const yNumerator =
    Math.abs(yPositiveProduct - yNegativeProduct) <=
    scaleAwareTolerance([yPositiveProduct, yNegativeProduct], 32)
      ? 0
      : yPositiveProduct - yNegativeProduct;

  return [
    xNumerator / determinant,
    yNumerator / determinant,
  ];
}

function pointsAreClose(left, right) {
  return (
    Math.abs(left[0] - right[0]) <= scaleAwareTolerance([left[0], right[0]], 64) &&
    Math.abs(left[1] - right[1]) <= scaleAwareTolerance([left[1], right[1]], 64)
  );
}

function rowTolerance(constraint, point) {
  return scaleAwareTolerance(
    [
      constraint.coefficients[0] * point[0],
      constraint.coefficients[1] * point[1],
      constraint.limit,
    ],
    128,
  );
}

/**
 * Solve a teaching-sized, two-variable resource allocation LP:
 * max c₁x + c₂y, subject to aᵢx + bᵢy ≤ limitᵢ and x,y ≥ 0.
 *
 * The intentionally narrow API keeps the geometry inspectable: every candidate
 * vertex is enumerated and returned so the browser can draw the same calculation
 * a learner sees in the table.
 */
export function solveTwoVariableLinearProgram({ objective, constraints }) {
  const normalizedObjective = normalizeTwoVariableObjective(objective);
  const normalizedConstraints = normalizeResourceConstraints(constraints);
  const geometryConstraints = normalizedConstraints.map(geometryConstraint);
  const unboundedVariableIndexes = normalizedObjective
    .map((_, variableIndex) => variableIndex)
    .filter((variableIndex) =>
      normalizedConstraints.every(
        (constraint) => constraint.coefficients[variableIndex] === 0,
      ),
    );

  normalizedObjective.forEach((coefficient, variableIndex) => {
    if (
      coefficient > 0 &&
      unboundedVariableIndexes.includes(variableIndex)
    ) {
      throw new RangeError(`variable ${variableIndex} is unbounded`);
    }
  });

  const candidates = [[0, 0]];
  geometryConstraints.forEach((constraint) => {
    const [xCoefficient, yCoefficient] = constraint.coefficients;
    if (xCoefficient > 0) candidates.push([constraint.limit / xCoefficient, 0]);
    if (yCoefficient > 0) candidates.push([0, constraint.limit / yCoefficient]);
  });
  for (let leftIndex = 0; leftIndex < geometryConstraints.length; leftIndex += 1) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < geometryConstraints.length;
      rightIndex += 1
    ) {
      const point = intersection(
        geometryConstraints[leftIndex],
        geometryConstraints[rightIndex],
      );
      if (point) candidates.push(point);
    }
  }

  const feasibleVertices = [];
  candidates.forEach(([rawX, rawY]) => {
    const rawPoint = [rawX, rawY];
    const feasible =
      rawPoint[0] >= -scaleAwareTolerance([rawPoint[0]], 128) &&
      rawPoint[1] >= -scaleAwareTolerance([rawPoint[1]], 128) &&
      geometryConstraints.every(
        (constraint) => {
          const leftHandSide =
            constraint.coefficients[0] * rawPoint[0] +
            constraint.coefficients[1] * rawPoint[1];
          return leftHandSide - constraint.limit <= rowTolerance(constraint, rawPoint);
        },
      );
    const point = rawPoint.map((coordinate) => (coordinate < 0 ? 0 : coordinate));
    if (feasible && !feasibleVertices.some((existing) => pointsAreClose(existing.point, point))) {
      const slacks = normalizedConstraints.map(
        (constraint) =>
          constraint.limit -
          constraint.coefficients[0] * point[0] -
          constraint.coefficients[1] * point[1],
      );
      feasibleVertices.push({
        point,
        value: normalizedObjective[0] * point[0] + normalizedObjective[1] * point[1],
        slacks,
        bindingConstraintIds: normalizedConstraints
          .filter((_, index) => {
            const constraint = geometryConstraints[index];
            const residual =
              constraint.limit -
              constraint.coefficients[0] * point[0] -
              constraint.coefficients[1] * point[1];
            return Math.abs(residual) <= rowTolerance(constraint, point);
          })
          .map((constraint) => constraint.id),
      });
    }
  });

  const centroid = feasibleVertices
    .reduce(
      (center, vertex) => [
        center[0] + vertex.point[0] / feasibleVertices.length,
        center[1] + vertex.point[1] / feasibleVertices.length,
      ],
      [0, 0],
    );
  feasibleVertices.sort(
    (left, right) =>
      Math.atan2(left.point[1] - centroid[1], left.point[0] - centroid[0]) -
      Math.atan2(right.point[1] - centroid[1], right.point[0] - centroid[0]),
  );
  const optimumValue = Math.max(...feasibleVertices.map((vertex) => vertex.value));
  const optimumTolerance =
    Number.EPSILON *
    256 *
    Math.max(
      Number.MIN_VALUE,
      ...feasibleVertices.map((vertex) => Math.abs(vertex.value)),
    );
  const optimalVertices = feasibleVertices.filter(
    (vertex) => Math.abs(vertex.value - optimumValue) <= optimumTolerance,
  );
  const optimum = optimalVertices[0];
  const hasUnboundedOptimalFace = unboundedVariableIndexes.some(
    (variableIndex) => normalizedObjective[variableIndex] === 0,
  );

  return {
    objective: normalizedObjective,
    constraints: normalizedConstraints,
    feasibleVertices,
    optimum,
    optimalVertices,
    feasibleRegionUnbounded: unboundedVariableIndexes.length > 0,
    unboundedVariableIndexes,
    hasUnboundedOptimalFace,
    hasMultipleOptima: optimalVertices.length > 1 || hasUnboundedOptimalFace,
  };
}

export function estimateConstraintMarginalValue({
  objective,
  constraints,
  constraintIndex,
  delta = 1,
}) {
  assertFiniteNumber(delta, "delta");
  if (delta <= 0) {
    throw new RangeError("delta must be positive");
  }
  const normalizedConstraints = normalizeResourceConstraints(constraints);
  if (
    !Number.isSafeInteger(constraintIndex) ||
    constraintIndex < 0 ||
    constraintIndex >= normalizedConstraints.length
  ) {
    throw new RangeError("constraintIndex is out of range");
  }

  const base = solveTwoVariableLinearProgram({
    objective,
    constraints: normalizedConstraints,
  });
  const expandedConstraints = normalizedConstraints.map((constraint, index) => ({
    ...constraint,
    coefficients: [...constraint.coefficients],
    limit: constraint.limit + (index === constraintIndex ? delta : 0),
  }));
  const expanded = solveTwoVariableLinearProgram({
    objective,
    constraints: expandedConstraints,
  });
  const midpointConstraints = normalizedConstraints.map((constraint, index) => ({
    ...constraint,
    coefficients: [...constraint.coefficients],
    limit: constraint.limit + (index === constraintIndex ? delta / 2 : 0),
  }));
  const midpoint = solveTwoVariableLinearProgram({
    objective,
    constraints: midpointConstraints,
  });
  const change = expanded.optimum.value - base.optimum.value;
  const firstHalfMarginalValue =
    (midpoint.optimum.value - base.optimum.value) / (delta / 2);
  const secondHalfMarginalValue =
    (expanded.optimum.value - midpoint.optimum.value) / (delta / 2);
  const slopeTolerance =
    Number.EPSILON *
    512 *
    Math.max(
      Number.MIN_VALUE,
      Math.abs(firstHalfMarginalValue),
      Math.abs(secondHalfMarginalValue),
    );
  const endpointBinding =
    base.optimum.bindingConstraintIds.includes(normalizedConstraints[constraintIndex].id) &&
    expanded.optimum.bindingConstraintIds.includes(normalizedConstraints[constraintIndex].id);

  return {
    constraint: normalizedConstraints[constraintIndex],
    delta,
    base,
    midpoint,
    expanded,
    change,
    marginalValue: change / delta,
    firstHalfMarginalValue,
    secondHalfMarginalValue,
    slopeStable:
      Math.abs(firstHalfMarginalValue - secondHalfMarginalValue) <= slopeTolerance,
    endpointBinding,
  };
}

export function analyzeDecisionUnderUncertainty({ alternatives, probabilities }) {
  if (!Array.isArray(alternatives) || alternatives.length === 0) {
    throw new RangeError("alternatives must be a non-empty array");
  }
  if (!Array.isArray(probabilities) || probabilities.length === 0) {
    throw new RangeError("probabilities must be a non-empty array");
  }
  probabilities.forEach((probability, index) => {
    assertFiniteNumber(probability, `probabilities[${index}]`);
    if (probability < 0 || probability > 1) {
      throw new RangeError("probabilities must be between 0 and 1");
    }
  });
  const probabilityTotal = probabilities.reduce((sum, probability) => sum + probability, 0);
  if (Math.abs(probabilityTotal - 1) > 1e-8) {
    throw new RangeError("probabilities must sum to 1");
  }

  const alternativeIds = new Set();
  const normalized = alternatives.map((alternative, alternativeIndex) => {
    if (!alternative || !Array.isArray(alternative.payoffs)) {
      throw new TypeError(`alternatives[${alternativeIndex}] needs payoffs`);
    }
    if (alternative.payoffs.length !== probabilities.length) {
      throw new RangeError("every payoff row must match the scenario count");
    }
    alternative.payoffs.forEach((payoff, scenarioIndex) =>
      assertFiniteNumber(payoff, `alternatives[${alternativeIndex}].payoffs[${scenarioIndex}]`),
    );
    const id = alternative.id ?? `alternative-${alternativeIndex + 1}`;
    if (typeof id !== "string" || id.length === 0 || alternativeIds.has(id)) {
      throw new RangeError(`alternative IDs must be unique non-empty strings: ${id}`);
    }
    alternativeIds.add(id);
    return {
      id,
      label: alternative.label ?? `대안 ${alternativeIndex + 1}`,
      payoffs: [...alternative.payoffs],
    };
  });

  const bestByScenario = probabilities.map((_, scenarioIndex) =>
    Math.max(...normalized.map((alternative) => alternative.payoffs[scenarioIndex])),
  );
  const rows = normalized.map((alternative) => {
    const regrets = alternative.payoffs.map(
      (payoff, scenarioIndex) => bestByScenario[scenarioIndex] - payoff,
    );
    return {
      ...alternative,
      expectedValue: alternative.payoffs.reduce(
        (sum, payoff, scenarioIndex) => sum + payoff * probabilities[scenarioIndex],
        0,
      ),
      worstCase: Math.min(...alternative.payoffs),
      bestCase: Math.max(...alternative.payoffs),
      regrets,
      maximumRegret: Math.max(...regrets),
    };
  });

  const highestExpected = Math.max(...rows.map((row) => row.expectedValue));
  const highestWorstCase = Math.max(...rows.map((row) => row.worstCase));
  const lowestMaximumRegret = Math.min(...rows.map((row) => row.maximumRegret));

  return {
    probabilities: [...probabilities],
    bestByScenario,
    rows,
    expectedBestIds: rows
      .filter((row) => scaleAwareEqual(row.expectedValue, highestExpected))
      .map((row) => row.id),
    robustBestIds: rows
      .filter((row) => scaleAwareEqual(row.worstCase, highestWorstCase))
      .map((row) => row.id),
    minimaxRegretIds: rows
      .filter((row) => scaleAwareEqual(row.maximumRegret, lowestMaximumRegret))
      .map((row) => row.id),
    criterionNotes: {
      expectedValue:
        "확률을 알고 편익에 위험중립적이라는 가정 아래 계산한 기대값입니다.",
      maximin:
        "확률과 무관하게 나열된 모든 상태를 가능한 스트레스 시나리오로 취급합니다.",
      minimaxRegret:
        "확률과 무관하게 각 상태의 사후 최선과 벌어지는 최대 편익 격차를 줄입니다.",
    },
  };
}

function minimumWholeUnitsToCover(total, perUnit) {
  const rawUnits = total / perUnit;
  if (!Number.isFinite(rawUnits)) return rawUnits;

  const nearestInteger = Math.round(rawUnits);
  let candidate = scaleAwareEqual(rawUnits, nearestInteger, 8)
    ? nearestInteger
    : Math.ceil(rawUnits);
  candidate = Math.max(0, candidate);

  const coversTotal = (units) => {
    const provided = perUnit * units;
    return provided >= total || scaleAwareEqual(provided, total, 8);
  };

  while (candidate > 0 && coversTotal(candidate - 1)) {
    candidate -= 1;
  }
  while (!coversTotal(candidate)) {
    const nextCandidate = candidate + 1;
    if (nextCandidate === candidate) break;
    candidate = nextCandidate;
  }
  return candidate;
}

export function calculateAccessEconomics({
  monthlyDisposableIncome,
  monthlyPrice,
  usageDays,
  hoursSavedPerDay,
  assumedHourlyValue,
}) {
  const values = {
    monthlyDisposableIncome,
    monthlyPrice,
    usageDays,
    hoursSavedPerDay,
    assumedHourlyValue,
  };
  Object.entries(values).forEach(([label, value]) => {
    assertFiniteNumber(value, label);
    if (value < 0) throw new RangeError(`${label} cannot be negative`);
  });
  if (!Number.isSafeInteger(usageDays) || usageDays <= 0 || usageDays > 31) {
    throw new RangeError("usageDays must be an integer between 1 and 31");
  }

  const monthlyHoursSaved = usageDays * hoursSavedPerDay;
  const imputedTimeValue = monthlyHoursSaved * assumedHourlyValue;
  const dailyPrice = monthlyPrice / usageDays;
  const dailyImputedBenefit = hoursSavedPerDay * assumedHourlyValue;
  const burdenShare =
    monthlyDisposableIncome <= EPSILON ? null : monthlyPrice / monthlyDisposableIncome;
  const netImputedValue = imputedTimeValue - monthlyPrice;
  const benefitCostRatio = monthlyPrice <= EPSILON ? null : imputedTimeValue / monthlyPrice;
  const breakEvenUsageDays =
    monthlyPrice === 0
      ? 0
      : dailyImputedBenefit === 0
        ? null
        : minimumWholeUnitsToCover(monthlyPrice, dailyImputedBenefit);
  const derivedValues = {
    burdenShare,
    monthlyHoursSaved,
    imputedTimeValue,
    netImputedValue,
    dailyPrice,
    dailyImputedBenefit,
    benefitCostRatio,
  };
  Object.entries(derivedValues).forEach(([label, value]) => {
    if (value !== null && !Number.isFinite(value)) {
      throw new RangeError(`${label} is outside the supported numeric range`);
    }
  });

  return {
    burdenShare,
    monthlyHoursSaved,
    imputedTimeValue,
    netImputedValue,
    dailyPrice,
    dailyImputedBenefit,
    benefitCostRatio,
    breakEvenUsageDays,
    breakEvenWithinMonth:
      breakEvenUsageDays !== null && breakEvenUsageDays <= 31,
  };
}

export function giniCoefficient(values) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new RangeError("values must be a non-empty array");
  }
  values.forEach((value, index) => {
    assertFiniteNumber(value, `values[${index}]`);
    if (value < 0) throw new RangeError("gini values cannot be negative");
  });
  const maximum = Math.max(...values);
  if (maximum === 0) return 0;
  const sorted = values.map((value) => value / maximum).sort((left, right) => left - right);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  const weighted = sorted.reduce(
    (sum, value, index) => sum + (index + 1) * value,
    0,
  );
  return (2 * weighted) / (sorted.length * total) - (sorted.length + 1) / sorted.length;
}
