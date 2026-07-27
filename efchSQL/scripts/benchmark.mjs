import assert from "node:assert/strict";

import { createEngine } from "../src/engine.js";

const BLOCK_SIZE = 64;
const BLOCKS = 100;
const LIMIT = 64;

function makeSharpWorkload() {
  const rows = [];
  for (let block = 0; block < BLOCKS; block += 1) {
    for (let offset = 0; offset < BLOCK_SIZE; offset += 1) {
      rows.push({
        id: block * BLOCK_SIZE + offset,
        baseScore: 0,
        symbols: {
          wanted: block === 73 ? 100 - offset / BLOCK_SIZE : 0,
          background: (offset % 7) / 10,
        },
      });
    }
  }
  return rows;
}

function makeAmbiguousWorkload() {
  return Array.from({ length: BLOCK_SIZE * BLOCKS }, (_, id) => ({
    id,
    baseScore: 0,
    // Every block can tie the current Kth result, so an exact engine must keep
    // looking. This is an intentionally honest worst case.
    symbols: { wanted: 1 },
  }));
}

function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function timed(run, repetitions = 25) {
  for (let warmup = 0; warmup < 5; warmup += 1) run();
  const samples = [];
  let result;
  for (let iteration = 0; iteration < repetitions; iteration += 1) {
    const start = process.hrtime.bigint();
    result = run();
    samples.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  return { result, milliseconds: median(samples) };
}

function benchmark(name, rows) {
  const engine = createEngine(rows, { blockSize: BLOCK_SIZE });
  const sql = `SELECT * FROM feed PREFER wanted: 1 LIMIT ${LIMIT} MODE EXACT`;
  const fast = timed(() => engine.query(sql));
  const exhaustive = timed(() => engine.exhaustive(sql));

  assert.deepEqual(
    fast.result.results.map(({ row }) => row.id),
    exhaustive.result.results.map(({ row }) => row.id),
    `${name}: optimized IDs differ from exhaustive IDs`,
  );
  assert.deepEqual(
    fast.result.results.map(({ score }) => score),
    exhaustive.result.results.map(({ score }) => score),
    `${name}: optimized scores differ from exhaustive scores`,
  );

  return {
    workload: name,
    rows: rows.length,
    "scored rows": fast.result.metrics.scoredRows,
    "evaluation ratio":
      `${(fast.result.metrics.scoreEvaluationRatio * 100).toFixed(2)}%`,
    "blocks skipped":
      `${fast.result.metrics.blocksSkipped}/${fast.result.metrics.blocksTotal}`,
    "optimized median ms": fast.milliseconds.toFixed(3),
    "exhaustive median ms": exhaustive.milliseconds.toFixed(3),
    "wall speedup":
      exhaustive.milliseconds > 0
        ? `${(exhaustive.milliseconds / fast.milliseconds).toFixed(2)}x`
        : "n/a",
    exact: fast.result.metrics.exact,
  };
}

console.log("efchSQL exact top-K benchmark (median of 25 runs)");
console.log("Score-evaluation savings and wall-clock speedup are reported separately.");
const sharp = benchmark("sharp / clustered", makeSharpWorkload());
const ambiguous = benchmark("ambiguous / ties", makeAmbiguousWorkload());
assert.equal(sharp["scored rows"], BLOCK_SIZE, "sharp workload should score one block");
assert.equal(sharp["evaluation ratio"], "1.00%");
assert.equal(sharp.exact, true);
assert.equal(
  ambiguous["scored rows"],
  BLOCK_SIZE * BLOCKS,
  "ambiguous exact workload must fall back to scoring every row",
);
assert.equal(ambiguous.exact, true);
console.table([sharp, ambiguous]);
console.log(
  "Interpretation: upper bounds excel when strong candidates cluster, but exact mode " +
    "correctly falls back toward exhaustive work when bounds cannot separate ties.",
);
