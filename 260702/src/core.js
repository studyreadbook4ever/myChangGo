(function initCore(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  root.ECFoundryCore = api;
})(typeof globalThis !== "undefined" ? globalThis : window, function makeCore() {
  const TWO_PI = Math.PI * 2;
  const EPSILON = 1e-9;

  const DIRECTIONS = [
    { key: "E", label: "East", angle: 0 },
    { key: "NE", label: "North-East", angle: Math.PI / 4 },
    { key: "N", label: "North", angle: Math.PI / 2 },
    { key: "NW", label: "North-West", angle: (3 * Math.PI) / 4 },
    { key: "W", label: "West", angle: Math.PI },
    { key: "SW", label: "South-West", angle: (-3 * Math.PI) / 4 },
    { key: "S", label: "South", angle: -Math.PI / 2 },
    { key: "SE", label: "South-East", angle: -Math.PI / 4 },
  ];

  const PROBLEM_TYPES = [
    "field_direction",
    "force_positive",
    "force_negative",
    "weakest_field_candidate",
    "highest_potential_candidate",
    "potential_sign",
  ];

  const TYPE_LABELS = {
    field_direction: "Net field direction",
    force_positive: "Force on + test charge",
    force_negative: "Force on - test charge",
    weakest_field_candidate: "Weakest field candidate",
    highest_potential_candidate: "Highest potential candidate",
    potential_sign: "Potential sign",
  };

  const SPATIAL_3D_TYPES = [
    "frontmost_object",
    "leftmost_object",
    "tallest_object",
    "count_color",
    "count_occluded",
    "nearest_to_target",
  ];

  const SPATIAL_3D_TYPE_LABELS = {
    frontmost_object: "Frontmost object",
    leftmost_object: "Leftmost object",
    tallest_object: "Tallest object",
    count_color: "Count by color",
    count_occluded: "Count partially hidden",
    nearest_to_target: "Nearest to target",
  };

  const OBJECT_COLORS = [
    { key: "red", label: "Red", rgb: [0.96, 0.04, 0.03] },
    { key: "blue", label: "Blue", rgb: [0.03, 0.24, 0.96] },
    { key: "green", label: "Green", rgb: [0.0, 0.78, 0.2] },
    { key: "yellow", label: "Yellow", rgb: [1.0, 0.8, 0.0] },
    { key: "magenta", label: "Magenta", rgb: [0.88, 0.0, 0.96] },
    { key: "cyan", label: "Cyan", rgb: [0.0, 0.78, 0.96] },
    { key: "orange", label: "Orange", rgb: [1.0, 0.38, 0.0] },
  ];

  function hashString(input) {
    const text = String(input);
    let h = 2166136261;
    for (let i = 0; i < text.length; i += 1) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function next() {
      a += 0x6d2b79f5;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function createRng(seedInput) {
    const seed = typeof seedInput === "number" ? seedInput >>> 0 : hashString(seedInput);
    const next = mulberry32(seed);
    return {
      seed,
      next,
      float(min = 0, max = 1) {
        return min + next() * (max - min);
      },
      int(min, max) {
        return Math.floor(this.float(min, max + 1));
      },
      bool(probability = 0.5) {
        return next() < probability;
      },
      pick(items) {
        return items[Math.floor(next() * items.length)];
      },
    };
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function round(value, digits = 3) {
    const scale = 10 ** digits;
    return Math.round(value * scale) / scale;
  }

  function snap(value, step = 0.5) {
    return Math.round(value / step) * step;
  }

  function magnitude(v) {
    return Math.hypot(v.x, v.y);
  }

  function normalize(v) {
    const mag = magnitude(v);
    if (mag < EPSILON) return { x: 0, y: 0 };
    return { x: v.x / mag, y: v.y / mag };
  }

  function add(a, b) {
    return { x: a.x + b.x, y: a.y + b.y };
  }

  function scale(v, factor) {
    return { x: v.x * factor, y: v.y * factor };
  }

  function distance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  function objectBaseY(object) {
    if (Number.isFinite(object.baseY)) return round(object.baseY, 3);
    if (object.position && object.size) return round(object.position.y - object.size.y / 2, 3);
    return 0;
  }

  function objectTopY(object) {
    return round(objectBaseY(object) + object.size.y, 3);
  }

  function angleWrap(angle) {
    let a = angle;
    while (a <= -Math.PI) a += TWO_PI;
    while (a > Math.PI) a -= TWO_PI;
    return a;
  }

  function angleDiff(a, b) {
    return Math.abs(angleWrap(a - b));
  }

  function directionFromVector(vector) {
    const mag = magnitude(vector);
    if (mag < 0.035) {
      return {
        key: "NEAR_ZERO",
        label: "Near zero / unstable",
        angle: 0,
        angularMarginDeg: 0,
      };
    }
    const angle = Math.atan2(vector.y, vector.x);
    let best = DIRECTIONS[0];
    let bestDiff = Infinity;
    for (const direction of DIRECTIONS) {
      const diff = angleDiff(angle, direction.angle);
      if (diff < bestDiff) {
        best = direction;
        bestDiff = diff;
      }
    }
    const sectorHalf = Math.PI / 8;
    return {
      key: best.key,
      label: best.label,
      angle,
      angularMarginDeg: round(((sectorHalf - bestDiff) * 180) / Math.PI, 1),
    };
  }

  function computeFieldAt(point, charges) {
    let field = { x: 0, y: 0 };
    let potential = 0;
    const contributions = [];
    for (const charge of charges) {
      const dx = point.x - charge.x;
      const dy = point.y - charge.y;
      const r2 = dx * dx + dy * dy + 0.065;
      const r = Math.sqrt(r2);
      const invR3 = 1 / (r2 * r);
      const e = {
        x: charge.q * dx * invR3,
        y: charge.q * dy * invR3,
      };
      const v = charge.q / r;
      field = add(field, e);
      potential += v;
      contributions.push({
        chargeId: charge.id,
        q: charge.q,
        r: round(r, 4),
        vector: { x: round(e.x, 5), y: round(e.y, 5) },
        magnitude: round(magnitude(e), 5),
        potential: round(v, 5),
      });
    }
    const totalContributionMagnitude = contributions.reduce((sum, item) => sum + item.magnitude, 0);
    const fieldMagnitude = magnitude(field);
    const strongest = [...contributions].sort((a, b) => b.magnitude - a.magnitude)[0];
    return {
      point: { x: round(point.x, 3), y: round(point.y, 3) },
      field: { x: round(field.x, 6), y: round(field.y, 6) },
      fieldMagnitude: round(fieldMagnitude, 6),
      potential: round(potential, 6),
      contributions,
      strongestContribution: strongest,
      cancellationIndex: round(
        clamp(1 - fieldMagnitude / Math.max(totalContributionMagnitude, EPSILON), 0, 1),
        4,
      ),
      dominanceRatio: round(
        strongest ? strongest.magnitude / Math.max(totalContributionMagnitude, EPSILON) : 0,
        4,
      ),
    };
  }

  function chooseProblemType(rng, requested, difficulty) {
    if (requested && requested !== "mixed") return requested;
    const hardPool =
      difficulty >= 7
        ? [
            "weakest_field_candidate",
            "highest_potential_candidate",
            "field_direction",
            "force_negative",
            "potential_sign",
          ]
        : PROBLEM_TYPES;
    return rng.pick(hardPool);
  }

  function makePoint(rng, extent, existing, minDistance = 1.05) {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const point = {
        x: snap(rng.float(-extent + 0.7, extent - 0.7), 0.5),
        y: snap(rng.float(-extent + 0.7, extent - 0.7), 0.5),
      };
      if (existing.every((other) => distance(point, other) >= minDistance)) return point;
    }
    return {
      x: snap(rng.float(-extent + 1, extent - 1), 0.5),
      y: snap(rng.float(-extent + 1, extent - 1), 0.5),
    };
  }

  function makeCharges(rng, config) {
    const charges = [];
    const extent = config.gridExtent;
    const chargeCount = clamp(config.chargeCount, 2, 10);
    const values = config.difficulty >= 7 ? [1, 1.5, 2, 2.5, 3, 4] : [1, 2, 3];

    for (let i = 0; i < chargeCount; i += 1) {
      let point;
      if (config.symmetryTraps && i > 0 && i % 3 === 0 && rng.bool(0.45)) {
        const mirrored = charges[rng.int(0, charges.length - 1)];
        point = rng.bool()
          ? { x: -mirrored.x, y: mirrored.y }
          : { x: mirrored.x, y: -mirrored.y };
        if (
          Math.abs(point.x) > extent - 0.6 ||
          Math.abs(point.y) > extent - 0.6 ||
          charges.some((other) => distance(point, other) < 1.05)
        ) {
          point = makePoint(rng, extent, charges, 1.05);
        }
      } else {
        point = makePoint(rng, extent, charges, 1.05);
      }
      const sign = rng.bool(0.5) ? 1 : -1;
      const q = sign * rng.pick(values);
      charges.push({ id: `q${i + 1}`, x: point.x, y: point.y, q });
    }

    const totalCharge = charges.reduce((sum, charge) => sum + charge.q, 0);
    if (Math.abs(totalCharge) > chargeCount * 0.95) {
      const last = charges[charges.length - 1];
      last.q = -Math.sign(totalCharge) * Math.max(1, Math.abs(last.q));
    }
    return charges;
  }

  function makeCandidates(rng, config, charges, probe) {
    const candidates = [];
    const occupied = [...charges, probe];
    const count = clamp(config.candidateCount, 3, 6);
    const extent = config.gridExtent;

    if (config.hardDistractors) {
      const radius = rng.float(1.1, 2.3);
      const baseAngle = rng.float(-Math.PI, Math.PI);
      for (let i = 0; i < Math.min(count, 4); i += 1) {
        const angle = baseAngle + (i * TWO_PI) / Math.min(count, 4) + rng.float(-0.18, 0.18);
        const point = {
          x: snap(clamp(probe.x + Math.cos(angle) * radius, -extent + 0.6, extent - 0.6), 0.5),
          y: snap(clamp(probe.y + Math.sin(angle) * radius, -extent + 0.6, extent - 0.6), 0.5),
        };
        if (
          !candidates.some((other) => distance(point, other) < 0.8) &&
          charges.every((charge) => distance(point, charge) > 0.85)
        ) {
          candidates.push({ label: String.fromCharCode(65 + candidates.length), ...point });
          occupied.push(point);
        }
      }
    }

    while (candidates.length < count) {
      const point = makePoint(rng, extent, occupied, 1);
      candidates.push({ label: String.fromCharCode(65 + candidates.length), ...point });
      occupied.push(point);
    }
    return candidates;
  }

  function makeNearCancellationProbe(rng, charges, extent) {
    const oppositePairs = [];
    for (let i = 0; i < charges.length; i += 1) {
      for (let j = i + 1; j < charges.length; j += 1) {
        if (Math.sign(charges[i].q) !== Math.sign(charges[j].q)) {
          oppositePairs.push([charges[i], charges[j]]);
        }
      }
    }
    if (!oppositePairs.length) return null;
    const [a, b] = rng.pick(oppositePairs);
    const t = rng.float(0.35, 0.65);
    const point = {
      x: snap(clamp(a.x * (1 - t) + b.x * t + rng.float(-0.5, 0.5), -extent + 0.7, extent - 0.7), 0.5),
      y: snap(clamp(a.y * (1 - t) + b.y * t + rng.float(-0.5, 0.5), -extent + 0.7, extent - 0.7), 0.5),
    };
    if (charges.every((charge) => distance(point, charge) > 1)) return point;
    return null;
  }

  function answerOptionsFor(type, candidates) {
    if (type === "weakest_field_candidate" || type === "highest_potential_candidate") {
      return candidates.map((candidate) => ({
        value: candidate.label,
        label: `Candidate ${candidate.label}`,
      }));
    }
    if (type === "potential_sign") {
      return [
        { value: "positive", label: "Positive" },
        { value: "negative", label: "Negative" },
        { value: "near_zero", label: "Near zero" },
      ];
    }
    return [
      ...DIRECTIONS.map((direction) => ({ value: direction.key, label: direction.label })),
      { value: "NEAR_ZERO", label: "Near zero / unstable" },
    ];
  }

  function solveInstance(type, charges, probe, candidates) {
    const probeSolution = computeFieldAt(probe, charges);
    const direction = directionFromVector(probeSolution.field);
    const candidateSolutions = candidates.map((candidate) => ({
      label: candidate.label,
      point: { x: candidate.x, y: candidate.y },
      ...computeFieldAt(candidate, charges),
    }));

    let answer;
    let confidence = 0.8;
    let traceLines = [];
    const e = probeSolution.field;
    const opposite = scale(e, -1);

    if (type === "field_direction") {
      answer = direction.key;
      confidence = clamp(0.35 + direction.angularMarginDeg / 22.5 + probeSolution.fieldMagnitude / 2.4, 0, 1);
      traceLines = [
        "Compute E(P) = sum_i q_i * (P - r_i) / |P - r_i|^3.",
        `E(P) = (${round(e.x, 5)}, ${round(e.y, 5)}), |E| = ${probeSolution.fieldMagnitude}.`,
        `Compass sector = ${direction.label}; angular margin = ${direction.angularMarginDeg} deg.`,
      ];
    }

    if (type === "force_positive") {
      answer = direction.key;
      confidence = clamp(0.35 + direction.angularMarginDeg / 22.5 + probeSolution.fieldMagnitude / 2.4, 0, 1);
      traceLines = [
        "For a positive test charge, F = q_test E has the same direction as E.",
        `E(P) = (${round(e.x, 5)}, ${round(e.y, 5)}).`,
        `Initial force direction = ${direction.label}.`,
      ];
    }

    if (type === "force_negative") {
      const negativeDirection = directionFromVector(opposite);
      answer = negativeDirection.key;
      confidence = clamp(0.35 + negativeDirection.angularMarginDeg / 22.5 + probeSolution.fieldMagnitude / 2.4, 0, 1);
      traceLines = [
        "For a negative test charge, F = q_test E reverses the direction of E.",
        `E(P) = (${round(e.x, 5)}, ${round(e.y, 5)}), so -E = (${round(opposite.x, 5)}, ${round(opposite.y, 5)}).`,
        `Initial force direction = ${negativeDirection.label}.`,
      ];
    }

    if (type === "weakest_field_candidate") {
      const sorted = [...candidateSolutions].sort((a, b) => a.fieldMagnitude - b.fieldMagnitude);
      answer = sorted[0].label;
      const second = sorted[1] || sorted[0];
      confidence = clamp((second.fieldMagnitude - sorted[0].fieldMagnitude) / Math.max(second.fieldMagnitude, 0.1), 0, 1);
      traceLines = [
        "For every candidate X, compute |E(X)| from the same vector sum.",
        ...sorted.map((item) => `${item.label}: |E|=${item.fieldMagnitude}, V=${item.potential}`),
        `Minimum magnitude is candidate ${answer}.`,
      ];
    }

    if (type === "highest_potential_candidate") {
      const sorted = [...candidateSolutions].sort((a, b) => b.potential - a.potential);
      answer = sorted[0].label;
      const second = sorted[1] || sorted[0];
      confidence = clamp((sorted[0].potential - second.potential) / Math.max(Math.abs(sorted[0].potential), 0.2), 0, 1);
      traceLines = [
        "For every candidate X, compute electric potential V(X) = sum_i q_i / |X - r_i|.",
        ...sorted.map((item) => `${item.label}: V=${item.potential}, |E|=${item.fieldMagnitude}`),
        `Highest potential is candidate ${answer}.`,
      ];
    }

    if (type === "potential_sign") {
      const v = probeSolution.potential;
      answer = Math.abs(v) < 0.18 ? "near_zero" : v > 0 ? "positive" : "negative";
      confidence = clamp(Math.abs(v) / 1.5, 0, 1);
      traceLines = [
        "Potential is scalar: V(P) = sum_i q_i / |P - r_i|.",
        `V(P) = ${round(v, 6)}.`,
        `Sign class = ${answer}.`,
      ];
    }

    return {
      answer,
      answerOptions: answerOptionsFor(type, candidates),
      confidence: round(confidence, 3),
      probeSolution,
      candidateSolutions,
      solverTrace: traceLines.join("\n"),
    };
  }

  function makePrompt(type) {
    const promptByType = {
      field_direction: "At point P, which compass direction is the net electric field?",
      force_positive: "A +1 test charge is released at point P. Which direction is its initial force?",
      force_negative: "A -1 test charge is released at point P. Which direction is its initial force?",
      weakest_field_candidate: "Which labeled candidate point has the smallest electric-field magnitude?",
      highest_potential_candidate: "Which labeled candidate point has the highest electric potential?",
      potential_sign: "At point P, what is the sign of the electric potential?",
    };
    return promptByType[type];
  }

  function buildAnnotation(type, solver, config) {
    const mathDepth = clamp(
      Math.round(config.difficulty / 2 + (type.includes("candidate") ? 1.4 : 0.4)),
      1,
      5,
    );
    return {
      status: "pending",
      split: "train",
      humanAnswer: solver.answer,
      flags: [],
      labels: {
        visualClarity: 4,
        mathDepth,
        ambiguityRisk: solver.confidence < 0.32 ? 4 : solver.confidence < 0.55 ? 3 : 2,
        novelty: clamp(Math.round(config.difficulty / 2), 1, 5),
        pedagogicalValue: 4,
      },
      notes: "",
      reviewedAt: null,
    };
  }

  function buildMetrics(type, charges, solver, config) {
    const candidateGap =
      type.includes("candidate") && solver.candidateSolutions.length > 1
        ? (() => {
            const values = solver.candidateSolutions
              .map((item) =>
                type === "weakest_field_candidate" ? item.fieldMagnitude : item.potential,
              )
              .sort((a, b) =>
                type === "weakest_field_candidate" ? a - b : b - a,
              );
            return round(Math.abs(values[0] - values[1]), 5);
          })()
        : null;
    const positiveCharges = charges.filter((charge) => charge.q > 0).length;
    const negativeCharges = charges.length - positiveCharges;
    return {
      visualComplexity: clamp(Math.round(charges.length / 2 + config.candidateCount / 4), 1, 5),
      spatialComplexity: clamp(
        Math.round(config.gridExtent / 2 + solver.probeSolution.cancellationIndex * 2),
        1,
        5,
      ),
      cancellationIndex: solver.probeSolution.cancellationIndex,
      dominanceRatio: solver.probeSolution.dominanceRatio,
      answerConfidence: solver.confidence,
      candidateGap,
      positiveCharges,
      negativeCharges,
      netCharge: round(charges.reduce((sum, charge) => sum + charge.q, 0), 3),
    };
  }

  function sanitizeConfig(config = {}) {
    return {
      seed: config.seed || "electric-charge-field",
      difficulty: clamp(Number(config.difficulty ?? 7), 1, 10),
      chargeCount: clamp(Number(config.chargeCount ?? 7), 2, 10),
      candidateCount: clamp(Number(config.candidateCount ?? 4), 3, 6),
      gridExtent: clamp(Number(config.gridExtent ?? 6), 4, 10),
      problemType: config.problemType || "mixed",
      nearCancellation: Boolean(config.nearCancellation ?? true),
      symmetryTraps: Boolean(config.symmetryTraps ?? true),
      hardDistractors: Boolean(config.hardDistractors ?? true),
    };
  }

  function generateInstance(configInput = {}, index = 0) {
    const config = sanitizeConfig(configInput);
    const rng = createRng(`${config.seed}:${index}:${config.difficulty}:${config.problemType}`);
    const type = chooseProblemType(rng, config.problemType, config.difficulty);
    const charges = makeCharges(rng, config);
    const probeCandidate =
      config.nearCancellation && rng.bool(config.difficulty >= 7 ? 0.62 : 0.28)
        ? makeNearCancellationProbe(rng, charges, config.gridExtent)
        : null;
    const probe = probeCandidate || makePoint(rng, config.gridExtent, charges, 1.15);
    const candidates = makeCandidates(rng, config, charges, probe);
    const solver = solveInstance(type, charges, probe, candidates);
    const id = `${type}_${hashString(`${config.seed}:${index}`).toString(16).padStart(8, "0")}`;
    const metrics = buildMetrics(type, charges, solver, config);

    return {
      id,
      family: "electric_charge_field",
      type,
      typeLabel: TYPE_LABELS[type],
      seed: config.seed,
      index,
      prompt: makePrompt(type),
      answer: solver.answer,
      answerOptions: solver.answerOptions,
      charges,
      probe,
      candidates,
      solver: {
        fieldAtProbe: solver.probeSolution,
        candidates: solver.candidateSolutions,
        trace: solver.solverTrace,
      },
      parameters: config,
      metrics,
      annotation: buildAnnotation(type, solver, config),
      createdAt: new Date().toISOString(),
    };
  }

  function generateBatch(config, count) {
    const size = clamp(Number(count || 1), 1, 500);
    const baseOffset = Number(config.offset || 0);
    const family = config.family || "electric_charge_field";
    return Array.from({ length: size }, (_, index) =>
      family === "spatial_3d_scene"
        ? generate3DInstance(config, baseOffset + index)
        : generateInstance(config, baseOffset + index),
    );
  }

  function choose3DType(rng, requested, difficulty) {
    if (requested && requested !== "mixed" && SPATIAL_3D_TYPES.includes(requested)) return requested;
    const hardPool =
      difficulty >= 7
        ? ["frontmost_object", "count_occluded", "nearest_to_target", "count_color"]
        : SPATIAL_3D_TYPES;
    return rng.pick(hardPool);
  }

  function make3DObjects(rng, config) {
    const objects = [];
    const count = clamp(Number(config.objectCount ?? config.chargeCount ?? 8), 3, 14);
    const extent = clamp(Number(config.gridExtent ?? 6), 4, 10);
    const occupied = [];
    for (let i = 0; i < count; i += 1) {
      let x = 0;
      let z = 0;
      for (let attempt = 0; attempt < 120; attempt += 1) {
        x = snap(rng.float(-extent * 0.64, extent * 0.64), 0.5);
        z = snap(rng.float(-extent * 0.52, extent * 0.72), 0.5);
        if (occupied.every((point) => Math.hypot(point.x - x, point.z - z) > 0.8)) break;
      }
      occupied.push({ x, z });
      const w = rng.pick([0.7, 0.9, 1.1, 1.3]);
      const d = rng.pick([0.7, 0.9, 1.1, 1.3]);
      const h = rng.pick(config.difficulty >= 7 ? [0.8, 1.1, 1.4, 1.8, 2.2] : [0.8, 1.1, 1.4]);
      const elevationRoll = rng.next();
      const baseY =
        config.difficulty >= 7 && elevationRoll > 0.68
          ? rng.pick([0.7, 1.1, 1.6, 2.2])
          : config.difficulty >= 5 && elevationRoll > 0.84
            ? rng.pick([0.6, 1.0])
            : 0;
      const color = rng.pick(OBJECT_COLORS);
      objects.push({
        id: `o${i + 1}`,
        label: String.fromCharCode(65 + i),
        shape: rng.bool(0.75) ? "box" : "pillar",
        color: color.key,
        colorLabel: color.label,
        rgb: color.rgb,
        baseY: round(baseY, 2),
        position: { x: round(x, 2), y: round(baseY + h / 2, 2), z: round(z, 2) },
        size: { x: w, y: h, z: d },
        yaw: round(rng.pick([0, Math.PI / 12, -Math.PI / 12, Math.PI / 8, -Math.PI / 8]), 3),
        elevationClass: baseY > 1.2 ? "floating" : baseY > 0 ? "raised" : "grounded",
      });
    }
    return objects;
  }

  function cameraDepth(object) {
    return round(object.position.z - object.position.x * 0.18, 4);
  }

  function screenXProxy(object) {
    return round(object.position.x - object.position.z * 0.34, 4);
  }

  function distance3D(a, b) {
    return Math.hypot(
      a.position.x - b.position.x,
      a.position.y - b.position.y,
      a.position.z - b.position.z,
    );
  }

  function estimateOcclusion(objects) {
    return objects.map((object) => {
      const blockers = objects.filter((other) => {
        if (other.id === object.id) return false;
        if (cameraDepth(other) <= cameraDepth(object)) return false;
        const xGap = Math.abs(screenXProxy(other) - screenXProxy(object));
        const zGap = Math.abs(other.position.z - object.position.z);
        const verticalOverlap =
          Math.min(objectTopY(object), objectTopY(other)) -
          Math.max(objectBaseY(object), objectBaseY(other));
        return xGap < 0.9 && zGap < 2.5 && verticalOverlap > 0.18;
      });
      return { ...object, occluded: blockers.length > 0, blockers: blockers.map((item) => item.label) };
    });
  }

  function objectAnswerOptions(objects) {
    return objects.map((object) => ({
      value: object.label,
      label: `${object.label} (${object.colorLabel})`,
    }));
  }

  function numericAnswerOptions(max = 14) {
    return Array.from({ length: max + 1 }, (_, value) => ({
      value: String(value),
      label: String(value),
    }));
  }

  function solve3DInstance(type, objects, rng) {
    const solvedObjects = estimateOcclusion(objects);
    const trace = [];
    let answer;
    let answerOptions = objectAnswerOptions(solvedObjects);
    let target = null;
    let queryColor = null;

    if (type === "frontmost_object") {
      const sorted = [...solvedObjects].sort((a, b) => cameraDepth(b) - cameraDepth(a));
      answer = sorted[0].label;
      trace.push("Approximate camera depth = z - 0.18x. Larger value is closer to the viewer.");
      trace.push(...sorted.map((item) => `${item.label}: depth=${cameraDepth(item)}`));
    }

    if (type === "leftmost_object") {
      const sorted = [...solvedObjects].sort((a, b) => screenXProxy(a) - screenXProxy(b));
      answer = sorted[0].label;
      trace.push("Projected screen x proxy = x - 0.34z. Smaller value is farther left.");
      trace.push(...sorted.map((item) => `${item.label}: screenX=${screenXProxy(item)}`));
    }

    if (type === "tallest_object") {
      const sorted = [...solvedObjects].sort((a, b) => b.size.y - a.size.y);
      answer = sorted[0].label;
      trace.push("Compare box height along the vertical y axis.");
      trace.push(...sorted.map((item) => `${item.label}: height=${item.size.y}`));
    }

    if (type === "count_color") {
      const presentColors = [...new Set(solvedObjects.map((object) => object.color))];
      queryColor = rng.pick(presentColors.length ? presentColors : OBJECT_COLORS.map((color) => color.key));
      const count = solvedObjects.filter((object) => object.color === queryColor).length;
      answer = String(count);
      answerOptions = numericAnswerOptions(Math.max(8, solvedObjects.length));
      trace.push(`Count objects whose color key is ${queryColor}.`);
      trace.push(`Matching labels: ${solvedObjects.filter((object) => object.color === queryColor).map((object) => object.label).join(", ") || "none"}.`);
    }

    if (type === "count_occluded") {
      const occluded = solvedObjects.filter((object) => object.occluded);
      answer = String(occluded.length);
      answerOptions = numericAnswerOptions(Math.max(8, solvedObjects.length));
      trace.push("Default-view occlusion criterion: count an object only when a closer object overlaps its projected horizontal band and its vertical span. Edge contact alone does not count.");
      trace.push(...solvedObjects.map((item) => `${item.label}: occluded=${item.occluded} blockers=${item.blockers.join("/") || "none"}`));
    }

    if (type === "nearest_to_target") {
      target = rng.pick(solvedObjects);
      const sorted = solvedObjects
        .filter((object) => object.id !== target.id)
        .sort((a, b) => distance3D(a, target) - distance3D(b, target));
      answer = sorted[0].label;
      answerOptions = objectAnswerOptions(solvedObjects.filter((object) => object.id !== target.id));
      trace.push(`Target object = ${target.label}. Compare center-to-center 3D distance.`);
      trace.push(...sorted.map((item) => `${item.label}: distance=${round(distance3D(item, target), 4)}`));
    }

    return {
      answer,
      answerOptions,
      objects: solvedObjects,
      target: target ? target.label : null,
      queryColor,
      trace: trace.join("\n"),
    };
  }

  function make3DPrompt(type, solution) {
    const prompts = {
      frontmost_object: "Which labeled 3D object is closest to the viewer?",
      leftmost_object: "Which labeled 3D object appears farthest left in the image?",
      tallest_object: "Which labeled 3D object is tallest?",
      count_color: `How many ${solution.queryColor || "selected-color"} objects are in the 3D scene?`,
      count_occluded: "In the default camera view, how many labeled objects have part of their body covered by a closer object? Do not count edge contact.",
      nearest_to_target: `Which object is nearest to target ${solution.target || "?"} in 3D space? Do not choose the target itself.`,
    };
    return prompts[type];
  }

  function build3DAnnotation(solution, config) {
    return {
      status: "pending",
      split: "train",
      humanAnswer: solution.answer,
      flags: [],
      labels: {
        visualClarity: 4,
        mathDepth: clamp(Math.round(config.difficulty / 2), 1, 5),
        ambiguityRisk: 2,
        novelty: 4,
        pedagogicalValue: 4,
      },
      notes: "",
      reviewedAt: null,
    };
  }

  function generate3DInstance(configInput = {}, index = 0) {
    const config = sanitizeConfig(configInput);
    config.family = "spatial_3d_scene";
    config.objectCount = clamp(Number(configInput.objectCount ?? configInput.chargeCount ?? 8), 3, 14);
    const rng = createRng(`${config.seed}:3d:${index}:${config.difficulty}:${config.problemType}`);
    const type = choose3DType(rng, config.problemType, config.difficulty);
    const objects = make3DObjects(rng, config);
    const solution = solve3DInstance(type, objects, rng);
    const id = `${type}_${hashString(`${config.seed}:3d:${index}`).toString(16).padStart(8, "0")}`;
    const occludedCount = solution.objects.filter((object) => object.occluded).length;
    return {
      id,
      family: "spatial_3d_scene",
      type,
      typeLabel: SPATIAL_3D_TYPE_LABELS[type],
      seed: config.seed,
      index,
      prompt: make3DPrompt(type, solution),
      answer: solution.answer,
      answerOptions: solution.answerOptions,
      objects: solution.objects,
      scene: {
        camera: "isometric_webgpu",
        target: solution.target,
        queryColor: solution.queryColor,
      },
      solver: {
        trace: solution.trace,
      },
      parameters: config,
      metrics: {
        visualComplexity: clamp(Math.round(solution.objects.length / 2), 1, 5),
        spatialComplexity: clamp(Math.round(config.difficulty / 2 + occludedCount / 3), 1, 5),
        occludedCount,
        objectCount: solution.objects.length,
        answerConfidence: 0.82,
      },
      annotation: build3DAnnotation(solution, config),
      createdAt: new Date().toISOString(),
    };
  }

  return {
    DIRECTIONS,
    PROBLEM_TYPES,
    TYPE_LABELS,
    SPATIAL_3D_TYPES,
    SPATIAL_3D_TYPE_LABELS,
    OBJECT_COLORS,
    hashString,
    createRng,
    computeFieldAt,
    directionFromVector,
    generateInstance,
    generate3DInstance,
    generateBatch,
    round,
    magnitude,
    normalize,
    clamp,
  };
});
