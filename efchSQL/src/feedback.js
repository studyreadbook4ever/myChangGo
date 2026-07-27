/**
 * Tiny, dependency-free preference learning.
 *
 * Only symbols present in the interacted-with item are touched. This keeps an
 * update O(symbols-on-the-item), not O(all-known-symbols).
 */

function defaultNormalizeSymbol(symbol) {
  return String(symbol).trim().toLowerCase();
}

function requireFinite(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new TypeError(`${label} must be a finite number`);
  }
  return number;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function directionFor(signal) {
  if (signal === "like" || signal === "liked" || signal === true) return 1;
  if (signal === "dislike" || signal === "disliked" || signal === false) return -1;
  const numeric = Number(signal);
  if (!Number.isFinite(numeric) || numeric === 0) {
    throw new TypeError("Feedback signal must be like/dislike, a boolean, or a non-zero number");
  }
  return Math.sign(numeric);
}

/**
 * Converts any supported sparse symbol representation to [symbol, strength][].
 *
 * Supported inputs:
 *   ["database", "javascript"]
 *   new Set(["database"])
 *   { database: 1, javascript: 0.5 }
 *   new Map([["database", 1]])
 *   { symbols: [...] } (a whole feed item)
 */
export function symbolEntries(input, normalizeSymbol = defaultNormalizeSymbol) {
  const source =
    input &&
    typeof input === "object" &&
    !Array.isArray(input) &&
    Object.hasOwn(input, "symbols")
      ? input.symbols
      : input;
  const accumulated = new Map();

  const add = (rawSymbol, rawStrength) => {
    const symbol = normalizeSymbol(rawSymbol);
    if (!symbol) return;
    const strength = requireFinite(rawStrength, `Symbol strength for ${symbol}`);
    if (strength === 0) return;
    const combined = (accumulated.get(symbol) ?? 0) + strength;
    if (!Number.isFinite(combined)) {
      throw new RangeError(`Combined symbol strength for ${symbol} is not finite`);
    }
    if (combined === 0) accumulated.delete(symbol);
    else accumulated.set(symbol, combined);
  };

  if (source instanceof Map) {
    for (const [symbol, strength] of source) add(symbol, strength);
  } else if (source instanceof Set || Array.isArray(source)) {
    for (const entry of source) {
      if (
        entry &&
        typeof entry === "object" &&
        !Array.isArray(entry) &&
        (Object.hasOwn(entry, "symbol") || Object.hasOwn(entry, "name"))
      ) {
        const rawSymbol = Object.hasOwn(entry, "symbol") ? entry.symbol : entry.name;
        const rawStrength = Object.hasOwn(entry, "value")
          ? entry.value
          : Object.hasOwn(entry, "strength")
            ? entry.strength
            : 1;
        add(rawSymbol, rawStrength);
      } else {
        add(entry, 1);
      }
    }
  } else if (source && typeof source === "object") {
    for (const [symbol, strength] of Object.entries(source)) add(symbol, strength);
  } else if (typeof source === "string" || typeof source === "number") {
    add(source, 1);
  }

  return [...accumulated.entries()];
}

function normalizedWeights(input, normalizeSymbol) {
  const weights = Object.create(null);
  if (input == null) return weights;
  if (typeof input !== "object") {
    throw new TypeError("Preference weights must be an object or Map");
  }
  const entries = input instanceof Map ? input.entries() : Object.entries(input);
  for (const [rawSymbol, rawWeight] of entries) {
    const symbol = normalizeSymbol(rawSymbol);
    if (!symbol) continue;
    const weight = requireFinite(rawWeight, `Preference weight for ${symbol}`);
    if (weight === 0) continue;
    const combined = (weights[symbol] ?? 0) + weight;
    if (!Number.isFinite(combined)) {
      throw new RangeError(`Combined preference weight for ${symbol} is not finite`);
    }
    if (combined === 0) delete weights[symbol];
    else weights[symbol] = combined;
  }
  return weights;
}

function internalWeights(snapshot) {
  const weights = Object.create(null);
  for (const [symbol, weight] of Object.entries(snapshot)) weights[symbol] = weight;
  return weights;
}

/**
 * Pure sparse update helper. The input object is never mutated.
 */
export function applyFeedback(
  weights,
  symbols,
  signal,
  {
    learningRate = 0.35,
    strength = 1,
    minWeight = -4,
    maxWeight = 4,
    pruneEpsilon = 1e-9,
    normalizeSymbol = defaultNormalizeSymbol,
  } = {},
) {
  const next = normalizedWeights(weights, normalizeSymbol);
  const direction = directionFor(signal);
  const magnitude = requireFinite(strength, "Feedback strength");
  const rate = requireFinite(learningRate, "Learning rate");
  const minimum = requireFinite(minWeight, "Minimum preference weight");
  const maximum = requireFinite(maxWeight, "Maximum preference weight");
  const epsilon = requireFinite(pruneEpsilon, "Prune epsilon");
  if (magnitude < 0) throw new RangeError("Feedback strength must be non-negative");
  if (rate < 0) throw new RangeError("Learning rate must be non-negative");
  if (epsilon < 0) throw new RangeError("Prune epsilon must be non-negative");
  if (minimum > maximum) {
    throw new RangeError("Minimum preference weight must not exceed maximum preference weight");
  }

  for (const [symbol, symbolStrength] of symbolEntries(symbols, normalizeSymbol)) {
    const delta = direction * rate * magnitude * symbolStrength;
    if (!Number.isFinite(delta)) {
      throw new RangeError(`Feedback update for ${symbol} is not finite`);
    }
    const rawUpdated = (next[symbol] ?? 0) + delta;
    if (!Number.isFinite(rawUpdated)) {
      throw new RangeError(`Updated preference weight for ${symbol} is not finite`);
    }
    const updated = clamp(rawUpdated, minimum, maximum);
    if (Math.abs(updated) <= epsilon) delete next[symbol];
    else next[symbol] = updated;
  }

  return { ...next };
}

export class PreferenceModel {
  constructor({
    weights = {},
    learningRate = 0.35,
    minWeight = -4,
    maxWeight = 4,
    pruneEpsilon = 1e-9,
    normalizeSymbol = defaultNormalizeSymbol,
  } = {}) {
    if (typeof normalizeSymbol !== "function") {
      throw new TypeError("normalizeSymbol must be a function");
    }
    this.learningRate = requireFinite(learningRate, "Learning rate");
    this.minWeight = requireFinite(minWeight, "Minimum preference weight");
    this.maxWeight = requireFinite(maxWeight, "Maximum preference weight");
    this.pruneEpsilon = requireFinite(pruneEpsilon, "Prune epsilon");
    if (this.learningRate < 0) throw new RangeError("Learning rate must be non-negative");
    if (this.pruneEpsilon < 0) throw new RangeError("Prune epsilon must be non-negative");
    if (this.minWeight > this.maxWeight) {
      throw new RangeError("Minimum preference weight must not exceed maximum preference weight");
    }
    this.normalizeSymbol = normalizeSymbol;
    this._weights = normalizedWeights(weights, normalizeSymbol);
    this.interactions = 0;
  }

  get size() {
    return Object.keys(this._weights).length;
  }

  get weights() {
    return this.toJSON();
  }

  getWeight(symbol) {
    return this._weights[this.normalizeSymbol(symbol)] ?? 0;
  }

  /**
   * Records feedback and returns a fresh preference snapshot.
   *
   * Examples:
   *   model.feedback(post, "like")
   *   model.feedback(["ads", "crypto"], "dislike", { strength: 2 })
   */
  feedback(itemOrSymbols, signal, options = {}) {
    this._weights = internalWeights(
      applyFeedback(this._weights, itemOrSymbols, signal, {
        learningRate: options.learningRate ?? this.learningRate,
        strength: options.strength ?? 1,
        minWeight: options.minWeight ?? this.minWeight,
        maxWeight: options.maxWeight ?? this.maxWeight,
        pruneEpsilon: options.pruneEpsilon ?? this.pruneEpsilon,
        normalizeSymbol: this.normalizeSymbol,
      }),
    );
    this.interactions += 1;
    return this.toJSON();
  }

  record(itemOrSymbols, signal, options) {
    return this.feedback(itemOrSymbols, signal, options);
  }

  like(itemOrSymbols, options) {
    return this.feedback(itemOrSymbols, "like", options);
  }

  dislike(itemOrSymbols, options) {
    return this.feedback(itemOrSymbols, "dislike", options);
  }

  setWeight(symbol, value) {
    const key = this.normalizeSymbol(symbol);
    if (!key) return this.toJSON();
    const number = Number(value);
    if (!Number.isFinite(number)) throw new TypeError("Preference weight must be finite");
    const updated = clamp(number, this.minWeight, this.maxWeight);
    if (Math.abs(updated) <= this.pruneEpsilon) delete this._weights[key];
    else this._weights[key] = updated;
    return this.toJSON();
  }

  /**
   * Multiplicative forgetting, performed only when explicitly requested.
   */
  decay(factor = 0.98) {
    const multiplier = clamp(requireFinite(factor, "Decay factor"), 0, 1);
    for (const symbol of Object.keys(this._weights)) {
      const value = this._weights[symbol] * multiplier;
      if (Math.abs(value) <= this.pruneEpsilon) delete this._weights[symbol];
      else this._weights[symbol] = value;
    }
    return this.toJSON();
  }

  reset(weights = {}) {
    this._weights = normalizedWeights(weights, this.normalizeSymbol);
    this.interactions = 0;
    return this.toJSON();
  }

  toJSON() {
    return { ...this._weights };
  }

  snapshot() {
    return this.toJSON();
  }

  static fromJSON(weights, options = {}) {
    return new PreferenceModel({ ...options, weights });
  }
}

export default PreferenceModel;
