import { parseQuery } from "./query-parser.js";
import { symbolEntries } from "./feedback.js";

const EPSILON = 1e-10;

function defaultNormalizeSymbol(symbol) {
  return String(symbol).trim().toLowerCase();
}

function now() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function assertFinite(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError(`${label} must be a finite number`);
  return number;
}

function readPath(object, path) {
  let value = object;
  for (const part of path.split(".")) {
    if (value == null || !Object.hasOwn(Object(value), part)) return undefined;
    value = value[part];
  }
  return value;
}

const INTRINSIC_FUNCTION_KEYS = new Set([
  "length",
  "name",
  "arguments",
  "caller",
  "prototype",
]);

function detachedFrozenCopy(value, copies = new Map()) {
  if (value == null || (typeof value !== "object" && typeof value !== "function")) {
    return value;
  }
  if (copies.has(value)) return copies.get(value);
  if (typeof value === "function") {
    const original = value;
    const forwarded = function detachedQueryFunction(...args) {
      return Reflect.apply(original, forwarded, args);
    };
    copies.set(value, forwarded);
    for (const key of Reflect.ownKeys(original)) {
      if (typeof key === "string" && INTRINSIC_FUNCTION_KEYS.has(key)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(original, key);
      const propertyValue =
        descriptor && Object.hasOwn(descriptor, "value")
          ? descriptor.value
          : Reflect.get(original, key);
      Object.defineProperty(forwarded, key, {
        value: detachedFrozenCopy(propertyValue, copies),
        enumerable: descriptor?.enumerable ?? false,
        configurable: true,
        writable: true,
      });
    }
    return Object.freeze(forwarded);
  }
  const copy = Array.isArray(value) ? [] : Object.create(null);
  copies.set(value, copy);
  for (const key of Object.keys(value)) {
    copy[key] = detachedFrozenCopy(value[key], copies);
  }
  return Object.freeze(copy);
}

function normalizeWeights(...sources) {
  const normalizeSymbol =
    typeof sources.at(-1) === "function" ? sources.pop() : defaultNormalizeSymbol;
  const result = new Map();
  for (const source of sources) {
    if (source == null) continue;
    if (typeof source !== "object") {
      throw new TypeError("Preference weights must be an object or Map");
    }
    const entries = source instanceof Map ? source.entries() : Object.entries(source);
    for (const [rawSymbol, rawWeight] of entries) {
      const symbol = normalizeSymbol(rawSymbol);
      const weight = Number(rawWeight);
      if (!symbol) continue;
      if (!Number.isFinite(weight)) {
        throw new TypeError(`Preference weight for ${symbol} must be finite`);
      }
      if (weight === 0) continue;
      const combined = (result.get(symbol) ?? 0) + weight;
      if (!Number.isFinite(combined)) {
        throw new RangeError(`Combined preference weight for ${symbol} is not finite`);
      }
      if (combined === 0) result.delete(symbol);
      else result.set(symbol, combined);
    }
  }
  return result;
}

function compareIds(left, right) {
  if (typeof left === "number" && typeof right === "number") {
    if (Object.is(left, right) || left === right) return 0;
    if (Number.isNaN(left)) return 1;
    if (Number.isNaN(right)) return -1;
    return left < right ? -1 : 1;
  }
  const a = `${typeof left}:${String(left)}`;
  const b = `${typeof right}:${String(right)}`;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Negative means `left` ranks before `right`.
 * Ties are stable across runs: id ascending, then original input position.
 */
export function compareRanked(left, right) {
  if (left.score !== right.score) return left.score > right.score ? -1 : 1;
  const idComparison = compareIds(left.id, right.id);
  if (idComparison !== 0) return idComparison;
  return left.index - right.index;
}

function worseThan(left, right) {
  return compareRanked(left, right) > 0;
}

function siftUp(heap, start) {
  let index = start;
  while (index > 0) {
    const parent = (index - 1) >>> 1;
    if (!worseThan(heap[index], heap[parent])) break;
    [heap[index], heap[parent]] = [heap[parent], heap[index]];
    index = parent;
  }
}

function siftDown(heap, start) {
  let index = start;
  while (true) {
    const left = index * 2 + 1;
    if (left >= heap.length) return;
    const right = left + 1;
    let worseChild = left;
    if (right < heap.length && worseThan(heap[right], heap[left])) worseChild = right;
    if (!worseThan(heap[worseChild], heap[index])) return;
    [heap[index], heap[worseChild]] = [heap[worseChild], heap[index]];
    index = worseChild;
  }
}

function addToTop(heap, candidate, limit) {
  if (limit <= 0) return;
  if (heap.length < limit) {
    heap.push(candidate);
    siftUp(heap, heap.length - 1);
    return;
  }
  if (compareRanked(candidate, heap[0]) >= 0) return;
  heap[0] = candidate;
  siftDown(heap, 0);
}

function safelyBelow(upper, threshold) {
  const margin = EPSILON * Math.max(1, Math.abs(upper), Math.abs(threshold));
  return upper < threshold - margin;
}

function contains(container, wanted) {
  if (typeof container === "string") return container.includes(String(wanted));
  if (Array.isArray(container)) return container.includes(wanted);
  if (container instanceof Set || container instanceof Map) return container.has(wanted);
  if (container && typeof container === "object") return Object.hasOwn(container, wanted);
  return false;
}

function evaluatePredicate(row, predicate) {
  const actual = readPath(row, predicate.field);
  const expected = predicate.value;
  switch (predicate.operator.toLowerCase()) {
    case "=":
      return actual === expected;
    case "!=":
    case "<>":
      return actual !== expected;
    case "<":
      return actual < expected;
    case "<=":
      return actual <= expected;
    case ">":
      return actual > expected;
    case ">=":
      return actual >= expected;
    case "in":
      return expected.some((value) => actual === value);
    case "not in":
      return !expected.some((value) => actual === value);
    case "contains":
      return contains(actual, expected);
    case "not contains":
      return !contains(actual, expected);
    case "is null":
      return actual == null;
    case "is not null":
      return actual != null;
    default:
      throw new TypeError(`Unsupported WHERE operator ${predicate.operator}`);
  }
}

export function matchesWhere(row, expression) {
  if (!expression) return true;
  if (typeof expression === "function") return Boolean(expression(row));
  switch (expression.type) {
    case "predicate":
      return evaluatePredicate(row, expression);
    case "and":
      return matchesWhere(row, expression.left) && matchesWhere(row, expression.right);
    case "or":
      return matchesWhere(row, expression.left) || matchesWhere(row, expression.right);
    case "not":
      return !matchesWhere(row, expression.expression);
    default:
      throw new TypeError(`Unsupported WHERE expression ${expression.type}`);
  }
}

function scoreRecord(record, weights) {
  let score = record.baseScore;
  // Iterating the query's sparse weights makes work O(active preferences), not
  // O(all symbols in the dataset).
  for (const [symbol, weight] of weights) {
    score += weight * (record.symbols.get(symbol) ?? 0);
  }
  if (!Number.isFinite(score)) {
    throw new RangeError(`Score for row ${String(record.id)} is not finite`);
  }
  return Object.is(score, -0) ? 0 : score;
}

/**
 * Standalone cheap score helper, useful for inspecting and testing a row.
 */
export function scoreRow(
  row,
  weights = {},
  {
    symbolField = "symbols",
    baseScoreField = "baseScore",
    normalizeSymbol = defaultNormalizeSymbol,
  } = {},
) {
  const normalized = normalizeWeights(weights, normalizeSymbol);
  const symbols = new Map(symbolEntries(readPath(row, symbolField), normalizeSymbol));
  let score = Number(readPath(row, baseScoreField) ?? 0);
  if (!Number.isFinite(score)) {
    throw new TypeError("Row base score must be a finite number");
  }
  for (const [symbol, weight] of normalized) score += weight * (symbols.get(symbol) ?? 0);
  if (!Number.isFinite(score)) throw new RangeError("Row score is not finite");
  return Object.is(score, -0) ? 0 : score;
}

function normalizeQuery(query, normalizeSymbol) {
  let parsed;
  if (typeof query === "string") {
    parsed = parseQuery(query);
  } else {
    if (query == null || typeof query !== "object" || Array.isArray(query)) {
      throw new TypeError("query must be a SELECT string or parsed SELECT object");
    }
    parsed = {
      type: "select",
      select: ["*"],
      from: "feed",
      where: null,
      prefer: {},
      limit: 20,
      mode: "exact",
      budget: null,
      ...query,
    };
  }
  if (!parsed || parsed.type !== "select") {
    throw new TypeError("query must be a SELECT string or parsed SELECT object");
  }
  const normalized = {
    ...parsed,
    select: parsed.select ?? ["*"],
    from: parsed.from ?? "feed",
    prefer: Object.fromEntries(normalizeWeights(parsed.prefer ?? parsed.preferences, normalizeSymbol)),
    limit: parsed.limit ?? 20,
    mode: String(parsed.mode ?? "exact").toLowerCase(),
    budget: parsed.budget ?? null,
  };
  return detachedFrozenCopy(normalized);
}

function projectRow(row, fields) {
  if (!fields || fields.length === 0 || fields.includes("*")) return { ...row };
  const projected = {};
  for (const field of fields) projected[field] = readPath(row, field);
  return projected;
}

function normalizeRefiner(refiner) {
  if (!refiner) return null;
  if (typeof refiner === "function") {
    return {
      score: refiner,
      globalUpperBound: Number.POSITIVE_INFINITY,
      rowUpperBound: null,
      blockUpperBound: null,
    };
  }
  if (typeof refiner !== "object") throw new TypeError("refiner must be a function or object");
  const score = refiner.refine ?? refiner.score;
  if (typeof score !== "function") {
    throw new TypeError("refiner requires a score(row, context) or refine(row, context) function");
  }

  let globalUpperBound = Number.POSITIVE_INFINITY;
  let rowUpperBound = null;
  if (typeof refiner.upperBound === "function") rowUpperBound = refiner.upperBound;
  else if (refiner.upperBound != null) {
    globalUpperBound = assertFinite(refiner.upperBound, "refiner.upperBound");
  } else if (refiner.maxContribution != null) {
    globalUpperBound = assertFinite(refiner.maxContribution, "refiner.maxContribution");
  }

  return {
    score,
    globalUpperBound,
    rowUpperBound,
    blockUpperBound:
      typeof refiner.blockUpperBound === "function" ? refiner.blockUpperBound : null,
  };
}

function readRefinement(value) {
  if (value && typeof value.then === "function") {
    throw new TypeError("efchSQL query() is synchronous; refiner returned a Promise");
  }
  if (value && typeof value === "object") {
    return {
      contribution: assertFinite(value.score ?? value.contribution, "refiner score"),
      detail: value,
    };
  }
  return { contribution: assertFinite(value, "refiner score"), detail: null };
}

function makeEmptyMetrics(totalRows, blocksTotal, exact, started) {
  const latencyMs = now() - started;
  return {
    totalRows,
    scannedRows: 0,
    scoredRows: 0,
    matchedRows: 0,
    refinedRows: 0,
    prunedRows: totalRows,
    blockPrunedRows: totalRows,
    blocksTotal,
    blocksVisited: 0,
    blocksSkipped: blocksTotal,
    visitedBlocks: 0,
    skippedBlocks: blocksTotal,
    exact,
    budgetHit: false,
    scoreEvaluationRatio: 0,
    refinementRatio: 0,
    latencyMs,
    elapsedMs: latencyMs,
  };
}

function finalizeMetrics(metrics, started) {
  metrics.prunedRows = Math.max(0, metrics.totalRows - metrics.scoredRows);
  metrics.visitedBlocks = metrics.blocksVisited;
  metrics.skippedBlocks = metrics.blocksSkipped;
  metrics.scoreEvaluationRatio =
    metrics.totalRows === 0 ? 0 : metrics.scoredRows / metrics.totalRows;
  metrics.refinementRatio =
    metrics.totalRows === 0 ? 0 : metrics.refinedRows / metrics.totalRows;
  metrics.latencyMs = now() - started;
  metrics.elapsedMs = metrics.latencyMs;
  return metrics;
}

export class EfchSQLEngine {
  constructor(
    rows = [],
    {
      blockSize = 64,
      symbolField = "symbols",
      baseScoreField = "baseScore",
      idField = "id",
      sourceName = "feed",
      normalizeSymbol = defaultNormalizeSymbol,
      baseScore,
    } = {},
  ) {
    if (!Number.isInteger(blockSize) || blockSize <= 0) {
      throw new TypeError("blockSize must be a positive integer");
    }
    if (typeof normalizeSymbol !== "function") {
      throw new TypeError("normalizeSymbol must be a function");
    }
    this.blockSize = blockSize;
    this.symbolField = symbolField;
    this.baseScoreField = baseScoreField;
    this.idField = idField;
    this.sourceName = sourceName;
    this.normalizeSymbol = normalizeSymbol;
    this.baseScore = typeof baseScore === "function" ? baseScore : null;
    this.setRows(rows);
  }

  setRows(rows) {
    if (!Array.isArray(rows)) throw new TypeError("rows must be an array");
    this.rows = rows.slice();
    this._records = this.rows.map((row, index) => {
      const rawBase = this.baseScore
        ? this.baseScore(row, index)
        : readPath(row, this.baseScoreField) ?? 0;
      const base = Number(rawBase);
      const id = readPath(row, this.idField) ?? index;
      if (!Number.isFinite(base)) {
        throw new TypeError(`Base score for row ${String(id)} must be finite`);
      }
      return {
        row,
        index,
        id,
        baseScore: Object.is(base, -0) ? 0 : base,
        symbols: new Map(
          symbolEntries(readPath(row, this.symbolField), this.normalizeSymbol),
        ),
      };
    });
    this._blocks = [];
    for (let start = 0; start < this._records.length; start += this.blockSize) {
      const records = this._records.slice(start, start + this.blockSize);
      const stats = new Map();
      let baseUpper = Number.NEGATIVE_INFINITY;
      for (const record of records) {
        baseUpper = Math.max(baseUpper, record.baseScore);
        for (const [symbol, value] of record.symbols) {
          let range = stats.get(symbol);
          if (!range) {
            range = { min: 0, max: 0 };
            stats.set(symbol, range);
          }
          range.min = Math.min(range.min, value);
          range.max = Math.max(range.max, value);
        }
      }
      this._blocks.push({
        index: this._blocks.length,
        start,
        records,
        stats,
        baseUpper,
      });
    }
    return this;
  }

  query(query, options = {}) {
    return this._execute(query, options, false);
  }

  execute(query, options = {}) {
    return this.query(query, options);
  }

  exhaustive(query, options = {}) {
    return this._execute(query, options, true);
  }

  _execute(query, options, forceExhaustive) {
    const started = now();
    const plan = normalizeQuery(query, this.normalizeSymbol);
    if (String(plan.from).toLowerCase() !== String(this.sourceName).toLowerCase()) {
      throw new Error(`Unknown source ${plan.from}; this engine exposes ${this.sourceName}`);
    }

    const limit = options.limit ?? plan.limit;
    if (!Number.isInteger(limit) || limit < 0) {
      throw new TypeError("LIMIT must be a non-negative integer");
    }

    const mode = forceExhaustive
      ? "exact"
      : String(options.mode ?? plan.mode ?? "exact").toLowerCase();
    if (!["exact", "approx", "budget"].includes(mode)) {
      throw new TypeError("mode must be exact, approx, or budget");
    }
    const approximate = mode !== "exact";
    let budget = options.budget ?? plan.budget;
    if (approximate && budget == null) budget = Math.max(limit * 10, 100);
    if (budget != null && (!Number.isInteger(budget) || budget < 0)) {
      throw new TypeError("budget must be a non-negative integer");
    }

    // A runtime preference snapshot replaces the SQL PREFER vector. This lets
    // an app keep a readable query in the editor while feeding live like /
    // dislike updates without accidentally double-counting the same weights.
    const runtimeWeights = options.weights ?? options.preferences;
    const weights = normalizeWeights(
      runtimeWeights == null ? plan.prefer : runtimeWeights,
      this.normalizeSymbol,
    );
    const predicate =
      typeof options.predicate === "function"
        ? (row) => matchesWhere(row, plan.where) && options.predicate(row)
        : (row) => matchesWhere(row, plan.where);
    const refiner = normalizeRefiner(options.refiner);
    const context = Object.freeze({
      query: plan,
      weights: Object.freeze(Object.fromEntries(weights)),
      mode: approximate ? "approx" : "exact",
    });
    const contextualize = (extra) => Object.freeze({ ...context, ...extra });

    if (limit === 0 || this._records.length === 0) {
      const metrics = makeEmptyMetrics(
        this._records.length,
        this._blocks.length,
        true,
        started,
      );
      return { rows: [], results: [], metrics, query: plan };
    }

    const rowUpperCache = new Map();
    const rowUpper = (record) => {
      if (!refiner) return 0;
      if (rowUpperCache.has(record.index)) return rowUpperCache.get(record.index);
      let upper = refiner.globalUpperBound;
      if (refiner.rowUpperBound) {
        upper = assertFinite(
          refiner.rowUpperBound(
            record.row,
            contextualize({
              cheapScore: scoreRecord(record, weights),
              rowIndex: record.index,
            }),
          ),
          "refiner.upperBound(row)",
        );
      }
      rowUpperCache.set(record.index, upper);
      return upper;
    };

    const rankedBlocks = this._blocks.map((block) => {
      if (forceExhaustive) {
        return {
          block,
          cheapUpper: Number.POSITIVE_INFINITY,
          refinementUpper: Number.POSITIVE_INFINITY,
          upper: Number.POSITIVE_INFINITY,
        };
      }
      let cheapUpper = block.baseUpper;
      for (const [symbol, weight] of weights) {
        const range = block.stats.get(symbol);
        if (!range) continue;
        cheapUpper += weight * (weight >= 0 ? range.max : range.min);
      }
      if (Number.isNaN(cheapUpper)) {
        throw new RangeError(`Block ${block.index} produced an invalid score upper bound`);
      }

      let refinementUpper = 0;
      if (refiner?.blockUpperBound) {
        refinementUpper = assertFinite(
          refiner.blockUpperBound(
            block.records.map((record) => record.row),
            contextualize({ blockIndex: block.index }),
          ),
          "refiner.blockUpperBound(block)",
        );
      } else if (refiner?.rowUpperBound) {
        refinementUpper = Number.NEGATIVE_INFINITY;
        for (const record of block.records) {
          refinementUpper = Math.max(refinementUpper, rowUpper(record));
        }
      } else if (refiner) {
        refinementUpper = refiner.globalUpperBound;
      }

      return {
        block,
        cheapUpper,
        refinementUpper,
        upper: cheapUpper + refinementUpper,
      };
    });

    if (forceExhaustive) {
      rankedBlocks.sort((a, b) => a.block.index - b.block.index);
    } else {
      rankedBlocks.sort((left, right) => {
        if (left.upper !== right.upper) return left.upper > right.upper ? -1 : 1;
        return left.block.index - right.block.index;
      });
    }

    const metrics = {
      totalRows: this._records.length,
      scannedRows: 0,
      scoredRows: 0,
      matchedRows: 0,
      refinedRows: 0,
      prunedRows: 0,
      blockPrunedRows: 0,
      blocksTotal: this._blocks.length,
      blocksVisited: 0,
      blocksSkipped: 0,
      visitedBlocks: 0,
      skippedBlocks: 0,
      exact: true,
      budgetHit: false,
      scoreEvaluationRatio: 0,
      refinementRatio: 0,
      latencyMs: 0,
      elapsedMs: 0,
    };
    const top = [];
    let stoppedAtBlock = rankedBlocks.length;

    outer: for (let rank = 0; rank < rankedBlocks.length; rank += 1) {
      const rankedBlock = rankedBlocks[rank];
      const threshold = top.length === limit ? top[0].score : -Infinity;
      if (
        !forceExhaustive &&
        top.length === limit &&
        safelyBelow(rankedBlock.upper, threshold)
      ) {
        stoppedAtBlock = rank;
        break;
      }

      metrics.blocksVisited += 1;
      const block = rankedBlock.block;
      for (let offset = 0; offset < block.records.length; offset += 1) {
        const record = block.records[offset];
        metrics.scannedRows += 1;
        if (!predicate(record.row)) continue;
        metrics.matchedRows += 1;

        if (approximate && metrics.scoredRows >= budget) {
          metrics.budgetHit = true;
          metrics.exact = false;
          stoppedAtBlock = rank + 1;
          break outer;
        }

        const cheapScore = scoreRecord(record, weights);
        metrics.scoredRows += 1;
        let refinement = 0;
        let refinementDetail = null;

        if (refiner) {
          const bound = forceExhaustive
            ? Number.POSITIVE_INFINITY
            : refiner.rowUpperBound
              ? rowUpper(record)
              : refiner.blockUpperBound
                ? rankedBlock.refinementUpper
                : refiner.globalUpperBound;
          const currentThreshold =
            top.length === limit ? top[0].score : Number.NEGATIVE_INFINITY;
          if (
            !forceExhaustive &&
            top.length === limit &&
            safelyBelow(cheapScore + bound, currentThreshold)
          ) {
            continue;
          }

          const refined = readRefinement(
            refiner.score(
              record.row,
              contextualize({ cheapScore, rowIndex: record.index }),
            ),
          );
          refinement = refined.contribution;
          refinementDetail = refined.detail;
          metrics.refinedRows += 1;
          const contractMargin =
            EPSILON * Math.max(1, Math.abs(refinement), Math.abs(bound));
          if (
            !forceExhaustive &&
            Number.isFinite(bound) &&
            refinement > bound + contractMargin
          ) {
            throw new RangeError(
              `Refiner contract violated for row ${String(record.id)}: ` +
                `${refinement} exceeds declared upper bound ${bound}`,
            );
          }
        }

        const totalScore = cheapScore + refinement;
        if (!Number.isFinite(totalScore)) {
          throw new RangeError(`Total score for row ${String(record.id)} is not finite`);
        }
        addToTop(
          top,
          {
            row: record.row,
            id: record.id,
            index: record.index,
            cheapScore,
            refinement,
            refinementDetail,
            score: totalScore,
          },
          limit,
        );
      }
    }

    if (stoppedAtBlock < rankedBlocks.length) {
      metrics.blocksSkipped = rankedBlocks.length - stoppedAtBlock;
      for (let index = stoppedAtBlock; index < rankedBlocks.length; index += 1) {
        metrics.blockPrunedRows += rankedBlocks[index].block.records.length;
      }
    }

    const rankedTop = top.slice().sort(compareRanked);
    const results = rankedTop.map((candidate) => ({
      row: candidate.row,
      score: candidate.score,
      cheapScore: candidate.cheapScore,
      refinement: candidate.refinement,
      refinementDetail: candidate.refinementDetail,
    }));
    const rows = rankedTop.map((candidate) => ({
      ...projectRow(candidate.row, plan.select),
      efchScore: candidate.score,
    }));
    finalizeMetrics(metrics, started);
    return { rows, results, metrics, query: plan };
  }
}

export function createEngine(rows, options) {
  return new EfchSQLEngine(rows, options);
}

/**
 * Exhaustive correctness oracle. It shares score semantics and filtering with
 * the block engine but deliberately disables every pruning decision.
 */
export function exhaustiveTopK(rows, query, options = {}) {
  const engineOptions = options.engineOptions ?? {};
  const queryOptions = { ...options };
  delete queryOptions.engineOptions;
  return new EfchSQLEngine(rows, engineOptions).exhaustive(query, queryOptions);
}

export default createEngine;
