# efchSQL

**A tiny, dependency-free engine that gives changing preferences unequal
amounts of work.**

efchSQL is a clean-room systems demo inspired by the candidate-routing pattern
behind recommendation feeds. It ranks fictional posts with live positive and
negative symbol weights, but scores only the blocks that can still reach the
top-K. Exact mode returns the same ordered rows as exhaustive scoring and
reports how much work it avoided.

Everything runs locally on an ordinary CPU. There is no package install,
framework, backend, account, outbound network request, GPU, tracking script,
remote model, or proprietary feed data.

## See it

From this directory:

```sh
npm run dev
```

Open `http://127.0.0.1:4173`. Move a preference slider, like or dislike a
fictional post, or edit and run the query. The side panel shows the rows and
blocks actually visited, avoided score work, latency, exactness, and index
rebuild count. The default interaction loop runs only the optimized path; click
**Verify** when you want a one-off exhaustive comparison. The browser harness
uses `?test=1` to keep that oracle enabled for every exact test query.

No `npm install` is required. The development server uses only Node.js standard
modules.

## The query

efchSQL intentionally supports a small SQL-like surface:

```sql
SELECT * FROM feed
WHERE language = 'ko' AND ageHours <= 48
PREFER database: 2.0, systems: 1.2, ads: -1.5
LIMIT 10
MODE EXACT;
```

- `WHERE` handles comparisons, `IN`, `CONTAINS`, `IS NULL`, `AND`, `OR`,
  `NOT`, and parentheses.
- `PREFER` assigns signed weights to sparse symbols. Positive is “more like
  this”; negative is “less like this.”
- `LIMIT` selects K.
- `MODE EXACT` uses safe bounds and may prune only proven losers.
- `MODE BUDGET <rows>` or `MODE APPROX <rows>` caps row scoring. A result is
  labeled non-exact if the cap actually truncates the search; it can still be
  exact when every required row fits within the budget.

This is a ranking DSL, not a general SQL implementation: there are no joins,
transactions, schema mutations, or arbitrary functions.

## Why it is non-uniform

The reusable index stores conservative symbol information for small row
blocks. Each query combines those bounds with its current weight vector.
High-potential blocks are scored first; after K winners exist, a block whose
best possible score cannot win is skipped.

```text
all rows
  └─ cheap block bounds using this query's live weights
       ├─ cannot reach current top-K → skip the whole block
       └─ can still win              → calculate row scores
                                          └─ optional costly refinement
```

Changing a preference changes a few numbers, not the dataset or index. A
like/dislike update is proportional to the interacted item's sparse symbols.
The next query immediately uses the new snapshot.

“Dependency-free” and “local” remove package, transport, and model-serving
overhead. The algorithm itself is not literally free: bound calculation,
parsing, and heap maintenance cost work. efchSQL exposes that work in metrics
and keeps exhaustive scoring as the honest baseline. A one-percent scoring
ratio is not automatically a one-hundred-times wall-clock speedup.

The exhaustive baseline is not part of the normal optimized request. It runs
only in tests, benchmarks, an explicit **Verify** action, or the browser test
mode.

Read [the algorithm](docs/ALGORITHM.md) for the bound and correctness argument,
or [the architecture](docs/ARCHITECTURE.md) for the component boundaries.

## Programmatic use

The engine is a browser-and-Node ESM module:

```js
import { createEngine } from "./src/engine.js";

const engine = createEngine(posts, { blockSize: 32 });
const result = engine.query(`
  SELECT * FROM feed
  PREFER database: 1.4, ads: -1
  LIMIT 5
  MODE EXACT
`);

console.log(result.rows);
console.log(result.metrics);
```

Rows need a stable `id` and sparse `symbols`, supplied as an array or as an
object of numeric strengths. Other fields are available to `WHERE` predicates.
See the demo data and tests for complete examples.

The optional synchronous refiner reserves a more costly local calculation for
rows that can still win:

```js
const result = engine.query(query, {
  refiner: {
    maxContribution: 0.5,
    score(row) {
      return calculateCostlyLocalSignal(row);
    },
  },
});

console.log(result.metrics.refinedRows);
```

`maxContribution` must be a conservative upper bound. It lets exact mode prove
that a row or block cannot recover through refinement; the engine also rejects
an observed contribution above the declared contract. With no finite bound,
exact mode safely performs the refinement rather than guessing. For inherently
unbounded work, use an explicitly approximate budget and inspect
`metrics.exact`.

## Test loop

Node.js 20 or newer and, for the browser check, `/usr/bin/chromium` are the only
tools expected.

| Command | What it proves |
| --- | --- |
| `npm test` | Parser, feedback, ranking, edge cases, and randomized equality with exhaustive top-K |
| `npm run test:browser` | Runs separate desktop and 430px mobile Chromium harnesses and captures both smoke-test screenshots |
| `npm run bench` | Runs deterministic pruning and timing scenarios against the exhaustive baseline |
| `npm run verify` | Runs the license audit, Node suite, benchmark assertions, and browser smoke test |
| `npm run dev` | Starts the local static server |

The benchmark is a diagnostic, not a cross-device performance promise. Results
depend on K, weight sparsity, block size, score separation, filters, runtime,
and hardware.

## Repository map

```text
efchSQL/
├── index.html                 local interactive demo
├── src/
│   ├── engine.js              exact/budgeted top-K execution
│   ├── query-parser.js        small SQL-like parser
│   ├── feedback.js            sparse live preference updates
│   ├── app.js                 demo control loop
│   ├── demo-data.js           fictional deterministic records
│   └── styles.css             local responsive UI
├── tests/                     Node tests and real-browser harness
├── scripts/                   server, benchmark, audit, and verification
└── docs/                      algorithm, architecture, and license scope
```

## License and provenance

Copyright (c) 2026 studyreadbook4ever. efchSQL is released under the
[MIT License](LICENSE).

The project bundles no third-party code, libraries, fonts, images, or datasets.
Its implementation is original clean-room code. Prior work on Threshold
Algorithms, WAND-style bounds, and SQLite FTS5 is cited conceptually—without
copied source—in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The license
applies to this `efchSQL` project, not unrelated sibling projects in the parent
repository; see [license scope](docs/LICENSE_SCOPE.md).

The licensing notes document project intent and are not legal advice.
